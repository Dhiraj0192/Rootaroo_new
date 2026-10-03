jest.mock('../notify', () => ({ notifyHouseholdAdmins: jest.fn(), alertStaff: jest.fn() }));

import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import app from '../../../app';
import { setupAssociations, Household, BillingCheckoutSession, BillingReconciliationItem, BillingRoutingRule, AdminAuditLog } from '../../../database/models';
import { resetDb, closeIntResources } from '../../../test/int/db';
import { createHouseholdWithAdmin } from '../../../test/factories';
import { createCustomerRow, createSubscriptionRow } from '../../../test/billing/rows';
import { installStripeMock, StripeMock } from '../../../test/billing/stripeMock';
import { testBillingConfig } from '../../../test/billing/config';
import { stripeSubscription } from '../../../test/billing/fixtures';
import { seedDefaultRoutingRules } from '../routing';

const KEY = process.env.ADMIN_BILLING_API_KEY!;
const call = (method: 'get' | 'post' | 'put', path: string, body?: unknown) => request(app)[method](`/api/v1/billing-admin${path}`).set('x-admin-billing-key', KEY).send(body as object);
let s: StripeMock;
beforeAll(() => setupAssociations());
beforeEach(async () => { await resetDb(); s = installStripeMock('test', testBillingConfig({ adminKey: KEY })); });
afterAll(() => closeIntResources());

describe('POST /households/:id/cohort (L9, B8)', () => {
  it('changes a household without billing state and audits the reason', async () => {
    const { household } = await createHouseholdWithAdmin();
    const res = await call('post', `/households/${household.id}/cohort`, { cohort: 'test', reason: 'QA device' });
    expect(res.body.data).toMatchObject({ changed: true, from: 'live', to: 'test' });
    expect((await Household.findByPk(household.id))!.billingCohort).toBe('test');
    await new Promise((r) => setTimeout(r, 150));
    const audit = await AdminAuditLog.findOne({ where: { path: `/api/v1/billing-admin/households/${household.id}/cohort` } });
    expect(audit!.query).toMatchObject({ _note: { from: 'live', to: 'test', reason: 'QA device', force: false } });
  });

  it('is a no-op when the cohort already matches, and 404 for an unknown household', async () => {
    const { household } = await createHouseholdWithAdmin();
    expect((await call('post', `/households/${household.id}/cohort`, { cohort: 'live', reason: 'same' })).body.data).toMatchObject({ changed: false });
    expect((await call('post', '/households/00000000-0000-4000-8000-000000000000/cohort', { cohort: 'test', reason: 'nobody' })).status).toBe(404);
  });

  it('refuses while an allowed subscription or open session exists', async () => {
    const { household, admin } = await createHouseholdWithAdmin();
    await createSubscriptionRow(household.id);
    await BillingCheckoutSession.create({ id: uuidv4(), householdId: household.id, livemode: false, providerSessionId: 'cs_test_open', createdByUserId: admin.id, interval: 'month', seats: 5, status: 'open' });
    const res = await call('post', `/households/${household.id}/cohort`, { cohort: 'test', reason: 'x'.repeat(3) });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'COHORT_CHANGE_BLOCKED', subscriptions: 1, openSessions: 1 });
    expect((await Household.findByPk(household.id))!.billingCohort).toBe('live');
    await new Promise((r) => setTimeout(r, 150));
    const audit = await AdminAuditLog.findOne({ where: { statusCode: 409 } });
    expect(audit!.query).toMatchObject({ _note: { refused: true, to: 'test' } });
  });

  it('force sets cancel_at_period_end and expires open sessions', async () => {
    const { household, admin } = await createHouseholdWithAdmin();
    await createCustomerRow(household.id, { providerCustomerId: 'cus_C' });
    await createSubscriptionRow(household.id, { providerSubscriptionId: 'sub_C' });
    await BillingCheckoutSession.create({ id: uuidv4(), householdId: household.id, livemode: false, providerSessionId: 'cs_test_open', createdByUserId: admin.id, interval: 'month', seats: 5, status: 'open' });
    s.subscriptions.update.mockResolvedValue({});
    s.subscriptions.retrieve.mockResolvedValue(stripeSubscription({ id: 'sub_C', customer: 'cus_C', cancelAtPeriodEnd: true }));
    s.checkout.sessions.expire.mockResolvedValue({});
    const res = await call('post', `/households/${household.id}/cohort`, { cohort: 'test', reason: 'support case', force: true });
    expect(res.body.data).toMatchObject({ changed: true, canceledSubscriptions: ['sub_C'], expiredSessions: ['cs_test_open'] });
    expect(s.subscriptions.update).toHaveBeenCalledWith('sub_C', { cancel_at_period_end: true }, { idempotencyKey: expect.stringContaining('cohort:sub_C') });
    expect((await BillingCheckoutSession.findOne({ where: { providerSessionId: 'cs_test_open' } }))!.status).toBe('expired');
    expect((await Household.findByPk(household.id))!.billingCohort).toBe('test');
  });

  it('force tolerates an already-cancelling subscription and a failing session expiry', async () => {
    const { household, admin } = await createHouseholdWithAdmin();
    await createSubscriptionRow(household.id, { providerSubscriptionId: 'sub_D', cancelAtPeriodEnd: true });
    await BillingCheckoutSession.create({ id: uuidv4(), householdId: household.id, livemode: false, providerSessionId: 'cs_test_gone', createdByUserId: admin.id, interval: 'month', seats: 5, status: 'open' });
    await BillingCheckoutSession.create({ id: uuidv4(), householdId: household.id, livemode: false, providerSessionId: null, createdByUserId: admin.id, interval: 'month', seats: 5, status: 'creating' });
    s.checkout.sessions.expire.mockRejectedValue(new Error('already expired'));
    const res = await call('post', `/households/${household.id}/cohort`, { cohort: 'test', reason: 'force it', force: true });
    expect(res.body.data).toMatchObject({ changed: true, canceledSubscriptions: [], expiredSessions: ['cs_test_gone'] });
    expect(s.subscriptions.update).not.toHaveBeenCalled();
    expect(await BillingCheckoutSession.count({ where: { status: 'expired' } })).toBe(2);
  });

  it('force with a store subscription cannot cancel it: it raises a review item, leaves it untouched and still switches', async () => {
    const { household } = await createHouseholdWithAdmin();
    const store = await createSubscriptionRow(household.id, { provider: 'apple', providerSubscriptionId: '2000000555555' });
    const res = await call('post', `/households/${household.id}/cohort`, { cohort: 'test', reason: 'QA on a store buyer', force: true });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ changed: true, canceledSubscriptions: [], storeSubscriptions: ['2000000555555'] });
    expect(s.subscriptions.update).not.toHaveBeenCalled();
    expect((await store.reload()).status).toBe('active');
    expect(await BillingReconciliationItem.count({ where: { kind: 'store_subscription_cohort_change', providerObjectId: '2000000555555', resolution: 'needs_review' } })).toBe(1);
    expect((await Household.findByPk(household.id))!.billingCohort).toBe('test');
  });

  it('without force a store subscription still blocks the switch', async () => {
    const { household } = await createHouseholdWithAdmin();
    await createSubscriptionRow(household.id, { provider: 'google', providerSubscriptionId: 'tok-abc' });
    const res = await call('post', `/households/${household.id}/cohort`, { cohort: 'test', reason: 'no force' });
    expect(res.status).toBe(409);
    expect((await Household.findByPk(household.id))!.billingCohort).toBe('live');
  });

  it('validates the body', async () => {
    const { household } = await createHouseholdWithAdmin();
    expect((await call('post', `/households/${household.id}/cohort`, { cohort: 'beta', reason: 'xxx' })).status).toBe(400);
    expect((await call('post', `/households/${household.id}/cohort`, { cohort: 'test' })).status).toBe(400);
    expect((await call('post', `/households/${household.id}/cohort`, { cohort: 'test', reason: 'xxx', force: 'yes' })).status).toBe(400);
  });
});

describe('routing rules API', () => {
  it('reads and replaces the rule set atomically', async () => {
    await seedDefaultRoutingRules('development');
    expect((await call('get', '/routing')).body.data).toHaveLength(3);
    const rules = [{ platform: 'ios', country: 'US', method: 'stripe_checkout' }, { platform: 'ios', country: '*', method: 'apple_iap' }];
    expect((await call('put', '/routing', { rules })).status).toBe(200);
    expect(await BillingRoutingRule.count()).toBe(2);
    expect((await call('get', '/routing')).body.data).toHaveLength(2);
    expect((await call('put', '/routing', { rules: [...rules, rules[0]] })).status).toBe(400);
    expect(await BillingRoutingRule.count()).toBe(2);
    expect((await call('put', '/routing', { rules: [{ platform: 'ios', country: 'usa', method: 'none' }] })).status).toBe(400);
    expect((await call('put', '/routing', { rules: [] })).status).toBe(400);
  });
});
