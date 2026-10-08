import request from 'supertest';
import app from '../../../app';
import { setupAssociations, BillingTransaction } from '../../../database/models';
import { resetDb, closeIntResources } from '../../../test/int/db';
import { createHouseholdWithAdmin, addMember } from '../../../test/factories';
import { createSubscriptionRow, createCustomerRow } from '../../../test/billing/rows';
import { installStripeMock } from '../../../test/billing/stripeMock';
import { testBillingConfig } from '../../../test/billing/config';

const KEY = process.env.ADMIN_BILLING_API_KEY!;
const get = (path: string) => request(app).get(`/api/v1/billing-admin${path}`).set('x-admin-billing-key', KEY);
beforeAll(() => setupAssociations());
beforeEach(async () => { await resetDb(); installStripeMock('test', testBillingConfig({ adminKey: KEY })); });
afterAll(() => closeIntResources());

describe('GET /billing-admin/summary (spec 11 arithmetic)', () => {
  it('net = gross - refunds - withdrawn disputes - fees - dispute fees; MRR from allowed subs', async () => {
    const { household } = await createHouseholdWithAdmin();
    const at = new Date('2026-10-05T00:00:00Z');
    const t = (o: Record<string, unknown>) => BillingTransaction.create({ provider: 'stripe', livemode: true, currency: 'usd', matchStatus: 'matched', householdId: household.id, occurredAt: at, ...o });
    await t({ type: 'payment', status: 'paid', amount: 7999, fee: 262, net: 7737, providerObjectId: 'in_y' });
    await t({ type: 'payment', status: 'paid', amount: 1098, fee: 62, net: 1036, providerObjectId: 'in_m' });
    await t({ type: 'refund', status: 'succeeded', amount: 500, providerObjectId: 're_ok' });
    await t({ type: 'refund', status: 'failed', amount: 300, providerObjectId: 're_bad' });
    await t({ type: 'dispute', status: 'lost', amount: 1098, disputeFee: 1500, fundsState: 'withdrawn', providerObjectId: 'dp_w' });
    await t({ type: 'dispute', status: 'won', amount: 899, disputeFee: 0, fundsState: 'reinstated', providerObjectId: 'dp_r' });
    await t({ type: 'failed_payment', status: 'failed', amount: 899, billingReason: 'subscription_cycle', providerObjectId: 'in_f' });
    await t({ type: 'failed_payment', status: 'failed', amount: 899, billingReason: 'subscription_update', providerObjectId: 'in_f2' });
    await createSubscriptionRow(household.id, { livemode: true, interval: 'year', unitAmount: 7999 });
    const other = await createHouseholdWithAdmin();
    await createSubscriptionRow(other.household.id, { livemode: true, interval: 'month', unitAmount: 1098 });
    const third = await createHouseholdWithAdmin();
    await createSubscriptionRow(third.household.id, { livemode: true, status: 'past_due', unitAmount: 899, graceUntil: new Date(Date.now() + 86400_000) });
    const expired = await createHouseholdWithAdmin();
    await createSubscriptionRow(expired.household.id, { livemode: true, status: 'past_due', unitAmount: 899, graceUntil: new Date(Date.now() - 86400_000) });

    const res = await get('/summary?mode=live&from=2026-10-01T00:00:00Z&to=2026-10-31T23:59:59Z');
    expect(res.body.data).toMatchObject({
      gross: 9097, refunds: 500, disputes: 1098, fees: 324, disputeFees: 1500,
      net: 9097 - 500 - 1098 - 324 - 1500,
      mrr: 667 + 1098 + 899,
      counts: { active: 2, pastDue: 2, inGrace: 1, failedCyclePayments: 1 },
    });
  });

  it('counts store rows in USD only: other currencies stay out of the totals and MRR, but remain listed', async () => {
    const { household } = await createHouseholdWithAdmin();
    const at = new Date('2026-10-05T00:00:00Z');
    const base = { livemode: true, matchStatus: 'matched', householdId: household.id, occurredAt: at, type: 'payment', status: 'paid' };
    await BillingTransaction.create({ ...base, provider: 'apple', currency: 'usd', amount: 899, providerObjectId: 'tx_usd' });
    await BillingTransaction.create({ ...base, provider: 'apple', currency: 'eur', amount: 899, providerObjectId: 'tx_eur' });
    await createSubscriptionRow(household.id, { livemode: true, provider: 'apple', providerSubscriptionId: 'A-1', unitAmount: 899, currency: 'usd' });
    const other = await createHouseholdWithAdmin();
    await createSubscriptionRow(other.household.id, { livemode: true, provider: 'google', providerSubscriptionId: 'G-1', unitAmount: 899, currency: 'eur' });
    const res = await get('/summary?mode=live&from=2026-10-01T00:00:00Z&to=2026-10-31T23:59:59Z');
    expect(res.body.data).toMatchObject({ gross: 899, mrr: 899, counts: { active: 1 } });
    const list = await get('/transactions?mode=live');
    expect(list.body.data.map((t: { providerObjectId: string }) => t.providerObjectId).sort()).toEqual(['tx_eur', 'tx_usd']);
  });

  it('returns zeros for an empty window and defaults the range', async () => {
    const res = await get('/summary');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ mode: 'live', gross: 0, net: 0, mrr: 0, counts: { active: 0, pastDue: 0, inGrace: 0, failedCyclePayments: 0 } });
  });
});

describe('subscriptions and household views', () => {
  it('lists subscriptions by mode and status, with a cursor', async () => {
    const { household } = await createHouseholdWithAdmin();
    await createSubscriptionRow(household.id, { livemode: true, status: 'active' });
    await createSubscriptionRow(household.id, { livemode: true, status: 'canceled' });
    expect((await get('/subscriptions?mode=live&status=active')).body.data).toHaveLength(1);
    expect((await get('/subscriptions?mode=live')).body.data).toHaveLength(2);
    expect((await get('/subscriptions?mode=test')).body.data).toHaveLength(0);
    const first = await get('/subscriptions?mode=live&limit=1');
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const second = await get(`/subscriptions?mode=live&limit=1&cursor=${first.body.nextCursor}`);
    expect(second.body.data).toHaveLength(1);
    expect(second.body.data[0].id).not.toBe(first.body.data[0].id);
    expect((await get('/subscriptions?status=nope')).status).toBe(400);
  });

  it('shows cohort, entitlement, labelled subscriptions, customers, members and transactions', async () => {
    const { household } = await createHouseholdWithAdmin({ name: 'Shah Family' });
    await addMember(household.id);
    await createCustomerRow(household.id);
    await createSubscriptionRow(household.id, { livemode: false });
    await createSubscriptionRow(household.id, { livemode: true });
    const res = await get(`/households/${household.id}`);
    expect(res.body.data).toMatchObject({ household: { name: 'Shah Family', billingCohort: 'live' }, entitlement: { allowed: true } });
    expect(res.body.data.subscriptions.map((s: any) => s.mode).sort()).toEqual(['live', 'test']);
    expect(res.body.data.members).toHaveLength(2);
    expect(res.body.data.customers).toHaveLength(1);
    expect((await get('/households/00000000-0000-4000-8000-000000000000')).status).toBe(404);
  });
});
