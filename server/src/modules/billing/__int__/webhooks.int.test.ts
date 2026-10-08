jest.mock('../notify', () => ({ notifyHouseholdAdmins: jest.fn(), alertStaff: jest.fn() }));

import request from 'supertest';
import app from '../../../app';
import redis from '../../../config/redis';
import { setupAssociations, BillingEvent, BillingSubscription } from '../../../database/models';
import { resetDb, closeIntResources } from '../../../test/int/db';
import { createHouseholdWithAdmin } from '../../../test/factories';
import { createCustomerRow } from '../../../test/billing/rows';
import { installStripeMock, StripeMock } from '../../../test/billing/stripeMock';
import { testBillingConfig } from '../../../test/billing/config';
import { fakeKey, fakeWebhookSecret } from '../../../test/billing/secrets';
import { signedWebhook } from '../../../test/billing/webhookSign';
import { stripeEvent, stripeSubscription, stripeCheckoutSession } from '../../../test/billing/fixtures';
import { __drainForTests } from '../worker';
import { syncCheckout } from '../checkout';

const SECRET_A = fakeWebhookSecret('rotA');
const SECRET_B = fakeWebhookSecret('rotB');
let s: StripeMock;

beforeAll(() => setupAssociations());
beforeEach(async () => {
  // Several tests respond 200 and leave the event in the background worker; TRUNCATE in resetDb must not race it.
  await __drainForTests();
  await resetDb();
  s = installStripeMock('test', testBillingConfig({ modes: { test: { secretKey: fakeKey('sk_test'), webhookSecrets: [SECRET_A, SECRET_B] }, live: null } }));
});
afterAll(async () => { await __drainForTests(); await closeIntResources(); });

const send = (event: unknown, opts: { secret?: string; path?: string; timestamp?: number; contentType?: string } = {}) => {
  const { body, signature } = signedWebhook(event, opts.secret ?? SECRET_A, opts.timestamp);
  return request(app).post(opts.path ?? '/api/v1/billing/webhooks/stripe/test')
    .set('Content-Type', opts.contentType ?? 'application/json').set('Stripe-Signature', signature).send(body);
};
const customerUpdated = (id = `evt_${Math.random().toString(36).slice(2)}`) => stripeEvent('customer.updated', { id: 'cus_1', email: 'x@y' }, { id });

describe('Stripe webhook receiver (B5)', () => {
  it('accepts a valid event, persists it and processes it', async () => {
    const res = await send(customerUpdated('evt_ok'));
    expect(res.status).toBe(200);
    await __drainForTests();
    expect(await BillingEvent.findOne({ where: { providerEventId: 'evt_ok' } })).toMatchObject({ status: 'processed', livemode: false });
  });

  it('accepts the second secret during rotation', async () => {
    expect((await send(customerUpdated(), { secret: SECRET_B })).status).toBe(200);
  });

  it('400 on a bad or missing signature, no row', async () => {
    expect((await send(customerUpdated(), { secret: fakeWebhookSecret('wrong') })).status).toBe(400);
    const r = await request(app).post('/api/v1/billing/webhooks/stripe/test').set('Content-Type', 'application/json').send('{}');
    expect(r.status).toBe(400);
    expect(await BillingEvent.count()).toBe(0);
  });

  it('400 on a replayed event outside the 300 s tolerance', async () => {
    expect((await send(customerUpdated(), { timestamp: Math.floor(Date.now() / 1000) - 400 })).status).toBe(400);
  });

  it('400 when event.livemode does not match the endpoint (B3)', async () => {
    expect((await send(stripeEvent('customer.updated', { id: 'cus_1' }, { livemode: true }))).status).toBe(400);
  });

  it('400 on the live endpoint when live mode is not configured', async () => {
    expect((await send(customerUpdated(), { path: '/api/v1/billing/webhooks/stripe/live' })).status).toBe(400);
  });

  it('duplicate delivery: 200 both times, processed once', async () => {
    await send(customerUpdated('evt_dup'));
    const second = await send(customerUpdated('evt_dup'));
    expect(second.status).toBe(200);
    await __drainForTests();
    expect(await BillingEvent.count({ where: { providerEventId: 'evt_dup' } })).toBe(1);
  });

  it('concurrent duplicate deliveries both get 200 and one row (Review Focus 1)', async () => {
    const [a, b] = await Promise.all([send(customerUpdated('evt_race')), send(customerUpdated('evt_race'))]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await BillingEvent.count({ where: { providerEventId: 'evt_race' } })).toBe(1);
  });

  it('rejects wrong content-type / oversized body (Review Focus 2)', async () => {
    expect((await send(customerUpdated(), { contentType: 'text/plain' })).status).toBe(400);
    const big = { ...customerUpdated(), padding: 'x'.repeat(1_100_000) };
    expect((await send(big)).status).toBe(413);
    expect(await BillingEvent.count()).toBe(0);
  });

  it('updated before created converges (T5)', async () => {
    const { household } = await createHouseholdWithAdmin();
    await createCustomerRow(household.id, { providerCustomerId: 'cus_T5' });
    s.subscriptions.retrieve.mockResolvedValue(stripeSubscription({ id: 'sub_T5', customer: 'cus_T5', seats: 7 }));
    await send(stripeEvent('customer.subscription.updated', stripeSubscription({ id: 'sub_T5', customer: 'cus_T5', seats: 7 }), { created: 200 }));
    await send(stripeEvent('customer.subscription.created', stripeSubscription({ id: 'sub_T5', customer: 'cus_T5', seats: 5 }), { created: 100 }));
    await __drainForTests();
    expect(await BillingSubscription.findOne({ where: { providerSubscriptionId: 'sub_T5' } })).toMatchObject({ seats: 7, eventWatermark: 200 });
  });

  it('concurrent webhook and app sync yield one correct row (T1)', async () => {
    const { household, admin } = await createHouseholdWithAdmin();
    await createCustomerRow(household.id, { providerCustomerId: 'cus_T1' });
    const session = stripeCheckoutSession({ id: 'cs_test_T1', status: 'complete', clientReferenceId: household.id, customer: 'cus_T1', subscription: 'sub_T1' });
    s.checkout.sessions.retrieve.mockResolvedValue(session);
    s.subscriptions.retrieve.mockResolvedValue(stripeSubscription({ id: 'sub_T1', customer: 'cus_T1' }));
    await Promise.all([send(stripeEvent('checkout.session.completed', session)), syncCheckout(admin.id, 'cs_test_T1')]);
    await __drainForTests();
    expect(await BillingSubscription.count({ where: { providerSubscriptionId: 'sub_T1' } })).toBe(1);
  });
});

describe('webhook routes are not rate limited (T9)', () => {
  it('are mounted before the general limiter and before express.json()', () => {
    const stack: Array<{ name: string; regexp: RegExp }> = (app as any)._router.stack;
    const webhook = stack.findIndex((l) => l.name === 'router' && l.regexp.test('/api/v1/billing/webhooks/stripe/test'));
    const limiter = stack.findIndex((l) => l.name === 'rateLimitGate');
    const json = stack.findIndex((l) => l.name === 'jsonParser');
    expect(webhook).toBeGreaterThan(-1);
    expect(limiter).toBeGreaterThan(-1);
    expect(json).toBeGreaterThan(-1);
    expect(webhook).toBeLessThan(limiter);
    expect(webhook).toBeLessThan(json);
  });

  it('a burst of 120 deliveries never gets 429 when Redis is up', async () => {
    if (redis.status !== 'ready') return; // limiter fails open without Redis; structural test above covers it
    const results = await Promise.all(Array.from({ length: 120 }, () => send(customerUpdated())));
    expect(results.every((r) => r.status === 200)).toBe(true);
  });
});
