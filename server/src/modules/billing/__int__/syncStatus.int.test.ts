jest.mock('../notify', () => ({ notifyHouseholdAdmins: jest.fn(), alertStaff: jest.fn() }));

import request from 'supertest';
import app from '../../../app';
import { setupAssociations, BillingCheckoutSession } from '../../../database/models';
import { resetDb, closeIntResources } from '../../../test/int/db';
import { createHouseholdWithAdmin, addMember, authHeaderFor } from '../../../test/factories';
import { createCustomerRow } from '../../../test/billing/rows';
import { installStripeMock, listOf, StripeMock } from '../../../test/billing/stripeMock';
import { catalogPrices, stripeCheckoutSession, stripeSubscription } from '../../../test/billing/fixtures';
import { clearLocalCatalogCache } from '../catalog';
import { seedDefaultRoutingRules } from '../routing';

let s: StripeMock;
beforeAll(() => setupAssociations());
beforeEach(async () => {
  await resetDb();
  await seedDefaultRoutingRules('development');
  clearLocalCatalogCache();
  s = installStripeMock('test');
  const all = catalogPrices();
  s.prices.list.mockImplementation((p: any) => listOf(p.lookup_keys ? all.filter((x) => p.lookup_keys.includes(x.lookup_key)) : all));
});
afterAll(() => closeIntResources());

async function paidHousehold() {
  const { household, admin } = await createHouseholdWithAdmin();
  await createCustomerRow(household.id, { providerCustomerId: 'cus_1' });
  await BillingCheckoutSession.create({ id: '11111111-1111-4111-8111-111111111111', householdId: household.id, livemode: false, providerSessionId: 'cs_test_ok', createdByUserId: admin.id, interval: 'month', seats: 5, status: 'open', url: 'u', expiresAt: new Date(Date.now() + 1e6) });
  return { household, admin };
}

describe('GET /billing/return/:result', () => {
  it('302s to the app with no auth and no side effects', async () => {
    const res = await request(app).get('/api/v1/billing/return/success?session_id=cs_test_ok');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('rootaroo://billing/success?session_id=cs_test_ok');
    expect(s.checkout.sessions.retrieve).not.toHaveBeenCalled();
  });

  it('serves a static page for anything else', async () => {
    const res = await request(app).get('/api/v1/billing/return/success?session_id=evil');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Return to Rootaroo');
  });
});

describe('POST /billing/checkout/:id/sync', () => {
  it('syncs a completed session and unlocks; any member may sync (T3)', async () => {
    const { household } = await paidHousehold();
    const member = await addMember(household.id);
    s.checkout.sessions.retrieve.mockResolvedValue(stripeCheckoutSession({ id: 'cs_test_ok', status: 'complete', clientReferenceId: household.id, customer: 'cus_1', subscription: 'sub_1' }));
    s.subscriptions.retrieve.mockResolvedValue(stripeSubscription({ id: 'sub_1', customer: 'cus_1' }));
    const res = await request(app).post('/api/v1/billing/checkout/cs_test_ok/sync').set(authHeaderFor(member));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ entitlement: { allowed: true }, pendingCheckout: { sessionId: 'cs_test_ok', state: 'complete' } });
    expect(s.checkout.sessions.retrieve).toHaveBeenCalledWith('cs_test_ok', { expand: ['subscription'] });
    expect((await BillingCheckoutSession.findOne({ where: { providerSessionId: 'cs_test_ok' } }))!.status).toBe('complete');
  });

  it('reports processing while the subscription is not yet active (T4)', async () => {
    const { household, admin } = await paidHousehold();
    s.checkout.sessions.retrieve.mockResolvedValue(stripeCheckoutSession({ id: 'cs_test_ok', status: 'complete', clientReferenceId: household.id, customer: 'cus_1', subscription: 'sub_1' }));
    s.subscriptions.retrieve.mockResolvedValue(stripeSubscription({ id: 'sub_1', customer: 'cus_1', status: 'incomplete' }));
    const res = await request(app).post('/api/v1/billing/checkout/cs_test_ok/sync').set(authHeaderFor(admin));
    expect(res.body.data).toMatchObject({ entitlement: { allowed: false }, pendingCheckout: { state: 'processing' } });
  });

  it("403 for another household's session (B2)", async () => {
    const { admin } = await paidHousehold();
    s.checkout.sessions.retrieve.mockResolvedValue(stripeCheckoutSession({ id: 'cs_test_ok', status: 'complete', clientReferenceId: 'someone-else', customer: 'cus_1' }));
    expect((await request(app).post('/api/v1/billing/checkout/cs_test_ok/sync').set(authHeaderFor(admin))).status).toBe(403);
  });

  it('403 when the customer does not match (B2)', async () => {
    const { household, admin } = await paidHousehold();
    s.checkout.sessions.retrieve.mockResolvedValue(stripeCheckoutSession({ id: 'cs_test_ok', status: 'complete', clientReferenceId: household.id, customer: 'cus_other' }));
    expect((await request(app).post('/api/v1/billing/checkout/cs_test_ok/sync').set(authHeaderFor(admin))).status).toBe(403);
  });

  it('403 for a live session id in a test-mode household without calling Stripe (B3)', async () => {
    const { admin } = await paidHousehold();
    expect((await request(app).post('/api/v1/billing/checkout/cs_live_abc/sync').set(authHeaderFor(admin))).status).toBe(403);
    expect(s.checkout.sessions.retrieve).not.toHaveBeenCalled();
  });

  it('403 when Stripe does not know the session', async () => {
    const { admin } = await paidHousehold();
    s.checkout.sessions.retrieve.mockRejectedValue(Object.assign(new Error('No such checkout.session'), { type: 'StripeInvalidRequestError', code: 'resource_missing' }));
    expect((await request(app).post('/api/v1/billing/checkout/cs_test_zzz/sync').set(authHeaderFor(admin))).status).toBe(403);
  });

  it('marks expired sessions', async () => {
    const { household, admin } = await paidHousehold();
    s.checkout.sessions.retrieve.mockResolvedValue(stripeCheckoutSession({ id: 'cs_test_ok', status: 'expired', clientReferenceId: household.id, customer: 'cus_1' }));
    const res = await request(app).post('/api/v1/billing/checkout/cs_test_ok/sync').set(authHeaderFor(admin));
    expect(res.body.data.pendingCheckout.state).toBe('expired');
    expect((await BillingCheckoutSession.findOne({ where: { providerSessionId: 'cs_test_ok' } }))!.status).toBe('expired');
  });
});

describe('GET /billing/status', () => {
  it('returns the full status shape', async () => {
    const { household, admin } = await paidHousehold();
    await addMember(household.id);
    const res = await request(app).get('/api/v1/billing/status').set(authHeaderFor(admin)).set('X-Platform', 'android').set('X-Store-Country', 'us');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      householdId: household.id, entitlement: { allowed: false, reason: 'subscription_required' }, subscription: null, isAdmin: true,
      adminNames: [admin.displayName], purchaseMethod: 'stripe_checkout', memberCount: 2,
      pendingCheckout: { sessionId: 'cs_test_ok', state: 'open' }, plans: { seatsIncluded: 5 },
    });
  });

  it('still answers when the catalog is unavailable (plans: null)', async () => {
    const { admin } = await createHouseholdWithAdmin();
    s.prices.list.mockReturnValue(listOf([]));
    const res = await request(app).get('/api/v1/billing/status').set(authHeaderFor(admin));
    expect(res.status).toBe(200);
    expect(res.body.data.plans).toBeNull();
  });
});
