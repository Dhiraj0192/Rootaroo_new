import request from 'supertest';
import app from '../../../app';
import { setupAssociations, BillingTransaction } from '../../../database/models';
import { resetDb, closeIntResources } from '../../../test/int/db';
import { createHouseholdWithAdmin } from '../../../test/factories';
import { installStripeMock } from '../../../test/billing/stripeMock';
import { testBillingConfig } from '../../../test/billing/config';

const KEY = process.env.ADMIN_BILLING_API_KEY!;
const get = (path: string) => request(app).get(`/api/v1/billing-admin${path}`).set('x-admin-billing-key', KEY);

beforeAll(() => setupAssociations());
beforeEach(async () => { await resetDb(); installStripeMock('test', testBillingConfig({ adminKey: KEY })); });
afterAll(() => closeIntResources());

async function seed() {
  const { household, admin } = await createHouseholdWithAdmin({ name: 'Rai Family' });
  const base = { provider: 'stripe', currency: 'usd', matchStatus: 'matched', householdId: household.id, userId: admin.id, householdNameSnapshot: 'Rai Family', payerEmailSnapshot: admin.email };
  for (let i = 0; i < 5; i++) {
    await BillingTransaction.create({ ...base, livemode: true, type: 'payment', status: 'paid', amount: 899, fee: 56, net: 843, billingReason: 'subscription_cycle', providerObjectId: `in_${i}`, occurredAt: new Date(Date.UTC(2026, 9, 1 + i)) });
  }
  await BillingTransaction.create({ ...base, livemode: true, type: 'refund', status: 'succeeded', amount: 400, providerObjectId: 're_1', occurredAt: new Date(Date.UTC(2026, 9, 7)) });
  await BillingTransaction.create({ ...base, livemode: false, type: 'payment', status: 'paid', amount: 899, providerObjectId: 'in_test', occurredAt: new Date(Date.UTC(2026, 9, 7)) });
  return { household, admin };
}

describe('GET /billing-admin/transactions', () => {
  it('defaults to live mode, newest first, with links and household names', async () => {
    await seed();
    const res = await get('/transactions');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(6);
    expect(res.body.data[0]).toMatchObject({ type: 'refund', mode: 'live', householdName: 'Rai Family', stripeDashboardUrl: 'https://dashboard.stripe.com/refunds/re_1' });
    expect(res.body.nextCursor).toBeNull();
  });

  it('filters and paginates with a cursor', async () => {
    const { household, admin } = await seed();
    const first = await get(`/transactions?type=payment&householdId=${household.id}&userId=${admin.id}&email=${encodeURIComponent(admin.email)}&billingReason=subscription_cycle&limit=2`);
    expect(first.body.data.map((t: any) => t.providerObjectId)).toEqual(['in_4', 'in_3']);
    const second = await get(`/transactions?type=payment&limit=2&cursor=${first.body.nextCursor}`);
    expect(second.body.data.map((t: any) => t.providerObjectId)).toEqual(['in_2', 'in_1']);
    expect((await get('/transactions?mode=test')).body.data.map((t: any) => t.providerObjectId)).toEqual(['in_test']);
    expect((await get('/transactions?from=2026-10-02T00:00:00Z&to=2026-10-03T23:59:59Z')).body.data).toHaveLength(2);
    expect((await get('/transactions?status=succeeded&matchStatus=matched')).body.data).toHaveLength(1);
  });

  it('rejects bad filters with 400', async () => {
    expect((await get('/transactions?limit=500')).status).toBe(400);
    expect((await get('/transactions?type=gift')).status).toBe(400);
    expect((await get('/transactions?cursor=%%%')).status).toBe(400);
    expect((await get('/transactions?cursor=bm9wZQ')).status).toBe(400);
  });

  it('returns one transaction with its household', async () => {
    await seed();
    const t = await BillingTransaction.findOne({ where: { providerObjectId: 're_1' } });
    const res = await get(`/transactions/${t!.id}`);
    expect(res.body.data).toMatchObject({ providerObjectId: 're_1', household: { name: 'Rai Family' } });
    expect((await get('/transactions/00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await get('/transactions/not-a-uuid')).status).toBe(400);
  });

  it('streams CSV with the same filters', async () => {
    await seed();
    const res = await get('/transactions.csv?type=payment');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    const lines = res.text.trim().split('\n');
    expect(lines[0]).toBe('id,occurred_at,mode,type,status,billing_reason,amount,fee,net,dispute_fee,currency,household_id,household_name,user_id,payer_email,match_status,provider_object_id,stripe_dashboard_url');
    expect(lines).toHaveLength(6);
  });

  it('CSV quotes cells that contain commas or quotes and neutralises spreadsheet formulas', async () => {
    const { household } = await createHouseholdWithAdmin();
    await BillingTransaction.create({ provider: 'stripe', livemode: true, currency: 'usd', matchStatus: 'matched', householdId: household.id, householdNameSnapshot: '=HYPERLINK("http://x","a,b")', type: 'payment', status: 'paid', amount: 899, providerObjectId: 'in_csv', occurredAt: new Date() });
    const res = await get('/transactions.csv');
    expect(res.text).toContain(`"'=HYPERLINK(""http://x"",""a,b"")"`);
  });
});
