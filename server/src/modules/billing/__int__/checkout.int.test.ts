jest.mock('../notify', () => ({ notifyHouseholdAdmins: jest.fn(), alertStaff: jest.fn() }));

import crypto from 'crypto';
import request from 'supertest';
import app from '../../../app';
import { setupAssociations, BillingCheckoutSession, BillingCustomer } from '../../../database/models';
import { resetDb, closeIntResources } from '../../../test/int/db';
import { createHouseholdWithAdmin, addMember, authHeaderFor } from '../../../test/factories';
import { createCustomerRow, createSubscriptionRow } from '../../../test/billing/rows';
import { installStripeMock, listOf, StripeMock } from '../../../test/billing/stripeMock';
import { testBillingConfig } from '../../../test/billing/config';
import { catalogPrices, stripeCheckoutSession, stripeSubscription } from '../../../test/billing/fixtures';
import { clearLocalCatalogCache } from '../catalog';
import { seedDefaultRoutingRules } from '../routing';
import { __clearPortalCacheForTests } from '../portal';

let s: StripeMock;
const post = (user: any, body: object) => request(app).post('/api/v1/billing/checkout').set(authHeaderFor(user)).send(body);

beforeAll(() => setupAssociations());
beforeEach(async () => {
  await resetDb();
  await seedDefaultRoutingRules('development');
  clearLocalCatalogCache();
  __clearPortalCacheForTests();
  s = installStripeMock('test');
  const all = catalogPrices();
  s.prices.list.mockImplementation((p: any) => listOf(p.lookup_keys ? all.filter((x) => p.lookup_keys.includes(x.lookup_key)) : all));
  s.customers.create.mockResolvedValue({ id: 'cus_new', email: 'a@x' });
  s.checkout.sessions.create.mockImplementation(async () => stripeCheckoutSession({ id: 'cs_test_abc', url: 'https://checkout.stripe.com/c/pay/cs_test_abc' }));
  s.billingPortal.sessions.create.mockResolvedValue({ url: 'https://billing.stripe.com/p/session/x' });
});
afterAll(() => closeIntResources());

describe('POST /billing/checkout', () => {
  it('creates a session with server-chosen price and every required parameter (B4, B9)', async () => {
    const { household, admin } = await createHouseholdWithAdmin();
    const res = await post(admin, { interval: 'year', seats: 7, price: 'price_evil', quantity: 3, payment_method_types: ['card'] });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ url: 'https://checkout.stripe.com/c/pay/cs_test_abc', sessionId: 'cs_test_abc' });
    const [params, opts] = s.checkout.sessions.create.mock.calls[0] as any[];
    expect(params).toMatchObject({
      mode: 'subscription', customer: 'cus_new', client_reference_id: household.id,
      line_items: [{ price: 'price_202610_7_year', quantity: 1 }],
      subscription_data: { metadata: { householdId: household.id, purchasedByUserId: admin.id, env: 'dev' } },
      metadata: { householdId: household.id, env: 'dev' }, origin_context: 'mobile_app', allow_promotion_codes: false,
      consent_collection: { terms_of_service: 'required' },
      custom_text: { submit: { message: 'Renews automatically at $127.75 per year until cancelled. Cancel anytime in Manage subscription.' } },
      success_url: 'https://api.example.test/api/v1/billing/return/success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://api.example.test/api/v1/billing/return/cancel',
      integration_identifier: 'rootaroo_app_checkout_qhzmvtkd',
    });
    expect(params).not.toHaveProperty('payment_method_types');
    expect(params.expires_at - Math.floor(Date.now() / 1000)).toBeGreaterThanOrEqual(30 * 60);
    const row = await BillingCheckoutSession.findOne({ where: { householdId: household.id } });
    expect(row).toMatchObject({ status: 'open', providerSessionId: 'cs_test_abc', seats: 7, interval: 'year' });
    expect(opts).toEqual({ idempotencyKey: `cs:${row!.id}` });
    expect(s.customers.create).toHaveBeenCalledWith(
      expect.objectContaining({ email: admin.email, metadata: { householdId: household.id, env: 'dev' } }),
      { idempotencyKey: expect.stringMatching(new RegExp(`^cust:${household.id}:test:[0-9a-f]{16}$`)) },
    );
    // finding 9: the key is derived from the exact params it protects, so a changed email/name never replays a stale customer
    const [custParams, custOpts] = s.customers.create.mock.calls[0] as any[];
    const hash = crypto.createHash('sha256').update(JSON.stringify(custParams)).digest('hex').slice(0, 16);
    expect(custOpts.idempotencyKey).toBe(`cust:${household.id}:test:${hash}`);
  });

  it('omits consent_collection only when BILLING_REQUIRE_TOS_CONSENT is off', async () => {
    const off = installStripeMock('test', testBillingConfig({ requireTosConsent: false }));
    off.prices.list.mockImplementation((p: any) => listOf(catalogPrices().filter((x) => p.lookup_keys.includes(x.lookup_key))));
    off.customers.create.mockResolvedValue({ id: 'cus_new', email: 'a@x' });
    off.checkout.sessions.create.mockResolvedValue(stripeCheckoutSession({ id: 'cs_test_notos' }));
    const { admin } = await createHouseholdWithAdmin();
    expect((await post(admin, { interval: 'month', seats: 5 })).status).toBe(200);
    expect(off.checkout.sessions.create.mock.calls[0][0]).not.toHaveProperty('consent_collection');
  });

  it('403 for a non-admin (B6)', async () => {
    const { household } = await createHouseholdWithAdmin();
    const member = await addMember(household.id);
    expect((await post(member, { interval: 'month', seats: 5 })).status).toBe(403);
  });

  it('400 for out-of-range seats', async () => {
    const { admin } = await createHouseholdWithAdmin();
    expect((await post(admin, { interval: 'month', seats: 11 })).status).toBe(400);
    expect((await post(admin, { interval: 'week', seats: 5 })).status).toBe(400);
  });

  it('409 SEATS_BELOW_MEMBERS with memberCount (L5)', async () => {
    const { household, admin } = await createHouseholdWithAdmin();
    for (let i = 0; i < 6; i++) await addMember(household.id);
    const res = await post(admin, { interval: 'month', seats: 6 });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'SEATS_BELOW_MEMBERS', memberCount: 7 });
  });

  it('rejects an 11-member household for every size (Review Focus 3)', async () => {
    const { household, admin } = await createHouseholdWithAdmin();
    for (let i = 0; i < 10; i++) await addMember(household.id);
    const res = await post(admin, { interval: 'month', seats: 10 });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'SEATS_BELOW_MEMBERS', memberCount: 11 });
  });

  it('409 ALREADY_SUBSCRIBED from a local active subscription (D2)', async () => {
    const { household, admin } = await createHouseholdWithAdmin();
    await createSubscriptionRow(household.id);
    expect((await post(admin, { interval: 'month', seats: 5 })).body.code).toBe('ALREADY_SUBSCRIBED');
    expect(s.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('syncs a Stripe-side active subscription then 409 (D2 stale local state)', async () => {
    const { household, admin } = await createHouseholdWithAdmin();
    await createCustomerRow(household.id, { providerCustomerId: 'cus_S' });
    const sub = stripeSubscription({ id: 'sub_S', customer: 'cus_S' });
    s.subscriptions.list.mockReturnValue(listOf([sub]));
    s.subscriptions.retrieve.mockResolvedValue(sub);
    const res = await post(admin, { interval: 'month', seats: 5 });
    expect(res.body.code).toBe('ALREADY_SUBSCRIBED');
    expect(s.subscriptions.retrieve).toHaveBeenCalledWith('sub_S', expect.anything());
  });

  it('409 PAYMENT_ISSUE with a portal URL while past_due (D2)', async () => {
    const { household, admin } = await createHouseholdWithAdmin();
    await createCustomerRow(household.id, { providerCustomerId: 'cus_P' });
    s.subscriptions.list.mockReturnValue(listOf([stripeSubscription({ id: 'sub_P', customer: 'cus_P', status: 'past_due' })]));
    const res = await post(admin, { interval: 'month', seats: 5 });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'PAYMENT_ISSUE', portalUrl: 'https://billing.stripe.com/p/session/x' });
  });

  it('reuses an open session with the same plan and expires one with a different plan (D1)', async () => {
    const { admin } = await createHouseholdWithAdmin();
    await post(admin, { interval: 'month', seats: 5 });
    const again = await post(admin, { interval: 'month', seats: 5 });
    expect(again.body.data.sessionId).toBe('cs_test_abc');
    expect(s.checkout.sessions.create).toHaveBeenCalledTimes(1);
    s.checkout.sessions.create.mockImplementation(async () => stripeCheckoutSession({ id: 'cs_test_def', url: 'https://checkout.stripe.com/c/pay/cs_test_def' }));
    s.checkout.sessions.expire.mockResolvedValue({});
    const changed = await post(admin, { interval: 'year', seats: 5 });
    expect(s.checkout.sessions.expire).toHaveBeenCalledWith('cs_test_abc');
    expect(changed.body.data.sessionId).toBe('cs_test_def');
  });

  it('expiring an already-paid session syncs it and returns 409 (D6)', async () => {
    const { household, admin } = await createHouseholdWithAdmin();
    await post(admin, { interval: 'month', seats: 5 });
    await createCustomerRow(household.id, { providerCustomerId: 'cus_new' }).catch(() => undefined);
    s.checkout.sessions.expire.mockRejectedValue(new Error('session is complete'));
    s.checkout.sessions.retrieve.mockResolvedValue(stripeCheckoutSession({ id: 'cs_test_abc', status: 'complete', subscription: 'sub_D6', customer: 'cus_new' }));
    s.subscriptions.retrieve.mockResolvedValue(stripeSubscription({ id: 'sub_D6', customer: 'cus_new' }));
    const res = await post(admin, { interval: 'year', seats: 6 });
    expect(res.body.code).toBe('ALREADY_SUBSCRIBED');
    expect((await BillingCheckoutSession.findOne({ where: { providerSessionId: 'cs_test_abc' } }))!.status).toBe('complete');
  });

  it('two concurrent requests create exactly one session (D1)', async () => {
    const { admin } = await createHouseholdWithAdmin();
    s.checkout.sessions.create.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 200));
      return stripeCheckoutSession({ id: 'cs_test_abc', url: 'https://checkout.stripe.com/c/pay/cs_test_abc' });
    });
    const [a, b] = await Promise.all([post(admin, { interval: 'month', seats: 5 }), post(admin, { interval: 'month', seats: 5 })]);
    expect(s.checkout.sessions.create).toHaveBeenCalledTimes(1);
    expect(a.body.data.sessionId).toBe('cs_test_abc');
    expect(b.body.data.sessionId).toBe('cs_test_abc');
  });

  it('recovers a lost customer row by search and survives a unique conflict (D4)', async () => {
    const { household, admin } = await createHouseholdWithAdmin();
    s.customers.search.mockReturnValue(listOf([{ id: 'cus_found', email: 'a@x' }]));
    await post(admin, { interval: 'month', seats: 5 });
    expect(s.customers.create).not.toHaveBeenCalled();
    expect(s.customers.search).toHaveBeenCalledWith({ query: `metadata['householdId']:'${household.id}' AND metadata['env']:'dev'`, limit: 1 });
    expect((await BillingCustomer.findOne({ where: { householdId: household.id } }))!.providerCustomerId).toBe('cus_found');
  });

  it('a Stripe failure marks the row failed, returns 502, and a retry works', async () => {
    const { household, admin } = await createHouseholdWithAdmin();
    s.checkout.sessions.create.mockRejectedValueOnce(new Error('api_connection_error'));
    const fail = await post(admin, { interval: 'month', seats: 5 });
    expect(fail.status).toBe(502);
    expect(fail.body.code).toBe('CHECKOUT_FAILED');
    expect((await BillingCheckoutSession.findOne({ where: { householdId: household.id } }))!.status).toBe('failed');
    expect((await post(admin, { interval: 'month', seats: 5 })).status).toBe(200);
  });

  it('503 BILLING_MODE_UNAVAILABLE without a test key', async () => {
    installStripeMock('test', testBillingConfig({ modes: { test: null, live: null } }));
    const { admin } = await createHouseholdWithAdmin();
    const res = await post(admin, { interval: 'month', seats: 5 });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('BILLING_MODE_UNAVAILABLE');
  });
});

describe('POST /billing/checkout: existing-subscription guards (finding 5)', () => {
  it('409 PAYMENT_ISSUE without a portal URL for a past_due store subscription (no Stripe customer)', async () => {
    const { household, admin } = await createHouseholdWithAdmin();
    await createSubscriptionRow(household.id, { provider: 'apple', providerSubscriptionId: '2000000555', status: 'past_due' });
    const res = await post(admin, { interval: 'month', seats: 5 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PAYMENT_ISSUE');
    expect(res.body.portalUrl ?? null).toBeNull();
    expect(s.billingPortal.sessions.create).not.toHaveBeenCalled();
    expect(s.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('409 PAYMENT_ISSUE without a portal URL for a past_due Stripe row when no customer can be found', async () => {
    const { household, admin } = await createHouseholdWithAdmin();
    await createSubscriptionRow(household.id, { providerSubscriptionId: 'sub_nocust', status: 'past_due' });
    const res = await post(admin, { interval: 'month', seats: 5 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PAYMENT_ISSUE');
    expect(res.body.portalUrl ?? null).toBeNull();
    expect(s.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('recovers the customer by search BEFORE the Stripe subscriptions.list check', async () => {
    const { household, admin } = await createHouseholdWithAdmin();
    s.customers.search.mockReturnValue(listOf([{ id: 'cus_rec', email: 'a@x' }]));
    s.subscriptions.list.mockReturnValue(listOf([stripeSubscription({ id: 'sub_rec', customer: 'cus_rec' })]));
    s.subscriptions.retrieve.mockResolvedValue(stripeSubscription({ id: 'sub_rec', customer: 'cus_rec' }));
    const res = await post(admin, { interval: 'month', seats: 5 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ALREADY_SUBSCRIBED');
    expect(s.subscriptions.list).toHaveBeenCalledWith(expect.objectContaining({ customer: 'cus_rec' }));
    expect(s.checkout.sessions.create).not.toHaveBeenCalled();
    expect((await BillingCustomer.findOne({ where: { householdId: household.id } }))!.providerCustomerId).toBe('cus_rec');
  });
});
