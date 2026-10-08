jest.mock('../../notify', () => ({ notifyHouseholdAdmins: jest.fn(), alertStaff: jest.fn() }));

import request from 'supertest';
import app from '../../../../app';
import { setupAssociations, BillingEvent, BillingReconciliationItem, BillingSubscription, BillingTransaction } from '../../../../database/models';
import { resetDb, closeIntResources } from '../../../../test/int/db';
import { createHouseholdWithAdmin, addMember, authHeaderFor } from '../../../../test/factories';
import { testBillingConfig } from '../../../../test/billing/config';
import {
  makeOidcKey, oidcToken, OidcKey, playSubscription, pubsubBody, rtdn, subscriptionNotification, TEST_AUDIENCE, TEST_PACKAGE, TEST_PUSH_SA, trustOidcKey,
} from '../../../../test/billing/googleFixtures';
import { __setBillingConfigForTests } from '../../config';
import { __setIapConfigForTests } from '../config';
import { __setPlayHttpForTests, GoogleNotFoundError, PlayRequest, PlaySubscriptionV2 } from '../google';
import { getEntitlement } from '../../entitlement';
import { notifyHouseholdAdmins } from '../../notify';
import { __drainForTests } from '../../worker';

const WEBHOOK = '/api/v1/billing/webhooks/google';
const VERIFY = '/api/v1/billing/iap/google/verify';
const TOKEN = 'purchase-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const DAY = 86400_000;

let key: OidcKey;
let restoreOidc: () => void;
let hh: { id: string };
let admin: Awaited<ReturnType<typeof createHouseholdWithAdmin>>['admin'];
let plays: Record<string, PlaySubscriptionV2 | Error>;
let acks: string[];
let ackError: Error | null;
let calls: PlayRequest[];

beforeAll(() => setupAssociations());
beforeEach(async () => {
  await __drainForTests();
  await resetDb();
  key = makeOidcKey();
  restoreOidc = trustOidcKey(key);
  __setBillingConfigForTests(testBillingConfig());
  __setIapConfigForTests({
    apple: null, appleOnlineChecks: false, warnings: [],
    google: { serviceAccountJson: '{}', packageName: TEST_PACKAGE, rtdnAudience: TEST_AUDIENCE, rtdnServiceAccountEmail: TEST_PUSH_SA },
  });
  plays = {};
  acks = [];
  ackError = null;
  calls = [];
  __setPlayHttpForTests(async (req) => {
    calls.push(req);
    if (req.method === 'POST') {
      if (ackError) throw ackError;
      acks.push(decodeURIComponent(/subscriptions\/([^/]+)\/tokens\/([^:]+):acknowledge/.exec(req.url)!.slice(1, 3).join('|')));
      return { status: 200, data: {} };
    }
    const token = decodeURIComponent(/tokens\/([^/?]+)$/.exec(req.url)![1]);
    const found = plays[token];
    if (!found) throw new GoogleNotFoundError('410');
    if (found instanceof Error) throw found;
    return { status: 200, data: found };
  });
  const made = await createHouseholdWithAdmin();
  hh = made.household;
  admin = made.admin;
  (notifyHouseholdAdmins as jest.Mock).mockClear();
});
afterEach(() => restoreOidc());
afterAll(async () => { await __drainForTests(); __setPlayHttpForTests(null); __setIapConfigForTests(null); __setBillingConfigForTests(null); await closeIntResources(); });

const bearer = (claims: Record<string, unknown> = {}) => ({ Authorization: `Bearer ${oidcToken(key, claims)}` });
let lastMessageId = '';
const push = async (body: string, headers: Record<string, string> = bearer()) => {
  try { lastMessageId = (JSON.parse(body) as { message?: { messageId?: string } }).message?.messageId ?? lastMessageId; } catch { /* malformed bodies are part of the tests */ }
  const res = await request(app).post(WEBHOOK).set('Content-Type', 'application/json').set(headers).send(body);
  await __drainForTests();
  return res;
};
const rt = (type: number, token = TOKEN) => push(pubsubBody(subscriptionNotification(type, token)));
const sub = (token = TOKEN) => BillingSubscription.findOne({ where: { provider: 'google', providerSubscriptionId: token } });
// Events created within the same second tie on timestamps, so look the last push up by its message id.
const lastEvent = () => BillingEvent.findOne({ where: { providerEventId: lastMessageId } });
const ent = () => getEntitlement(hh.id, { bypassCache: true });

describe('Google RTDN receiver', () => {
  it('503 when Google billing is not configured', async () => {
    __setIapConfigForTests({ apple: null, google: null, appleOnlineChecks: false, warnings: [] });
    expect((await rt(4)).status).toBe(503);
  });

  it('401 without a token, with a bad token, a wrong audience, or another service account; nothing stored', async () => {
    const body = pubsubBody(subscriptionNotification(4, TOKEN));
    expect((await push(body, {})).status).toBe(401);
    expect((await push(body, { Authorization: 'Bearer abc.def.ghi' })).status).toBe(401);
    expect((await push(body, bearer({ aud: 'https://evil.example.test' }))).status).toBe(401);
    expect((await push(body, bearer({ email: 'other@rootaroo-test.iam.gserviceaccount.com' }))).status).toBe(401);
    expect(await BillingEvent.count()).toBe(0);
  });

  it('400 for a malformed envelope, wrong content type or bad base64 payload; 413 when oversized', async () => {
    expect((await push('{nope')).status).toBe(400);
    expect((await push('{}')).status).toBe(400);
    expect((await push(JSON.stringify({ message: { data: Buffer.from('not json').toString('base64'), messageId: 'm1' } }))).status).toBe(400);
    expect((await request(app).post(WEBHOOK).set(bearer()).set('Content-Type', 'text/plain').send('x')).status).toBe(400);
    expect((await push(JSON.stringify({ message: { data: 'x'.repeat(1_100_000), messageId: 'm2' } }))).status).toBe(413);
    expect(await BillingEvent.count()).toBe(0);
  });

  it('acks and drops a notification for another package', async () => {
    const res = await push(pubsubBody(rtdn({ packageName: 'com.other.app', subscriptionNotification: { notificationType: 4, purchaseToken: TOKEN } })));
    expect(res.status).toBe(200);
    expect(await BillingEvent.count()).toBe(0);
  });

  it('a redelivered Pub/Sub message (same messageId) is stored and processed once', async () => {
    plays[TOKEN] = playSubscription({ householdId: hh.id });
    const body = pubsubBody(subscriptionNotification(4, TOKEN), 'msg-dup');
    const [a, b] = await Promise.all([push(body), push(body)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await BillingEvent.count()).toBe(1);
    expect(await BillingTransaction.count()).toBe(1);
  });
});

describe('Google RTDN processing (every notification type)', () => {
  it('SUBSCRIPTION_PURCHASED: creates the row from the Play API, grants access, ledgers the order and acknowledges', async () => {
    plays[TOKEN] = playSubscription({ householdId: hh.id, productId: 'rootaroo.hh7', basePlanId: 'year', price: { currencyCode: 'USD', units: '105', nanos: 480_000_000 }, orderId: 'GPA.1111-1111-1111-11111' });
    expect((await rt(4)).status).toBe(200);
    expect(await sub()).toMatchObject({ householdId: hh.id, provider: 'google', livemode: true, status: 'active', seats: 7, interval: 'year', unitAmount: 10548 });
    expect((await ent()).allowed).toBe(false); // a livemode=true row only counts toward live-mode (production) entitlement, never in dev/test
    expect(await BillingTransaction.findOne()).toMatchObject({ provider: 'google', type: 'payment', providerObjectId: 'GPA.1111-1111-1111-11111', amount: 10548, billingReason: 'subscription_create' });
    expect(acks).toEqual([`rootaroo.hh7|${TOKEN}`]);
    expect(await lastEvent()).toMatchObject({ status: 'processed', type: 'SUBSCRIPTION_PURCHASED' });
  });

  it('a license-test purchase is livemode=false (the event row is corrected too) and is what dev entitlement uses', async () => {
    plays[TOKEN] = playSubscription({ householdId: hh.id, test: true });
    await rt(4);
    expect((await sub())!.livemode).toBe(false);
    expect((await lastEvent())!.livemode).toBe(false);
    expect(await ent()).toMatchObject({ allowed: true, reason: 'active' });
  });

  it('SUBSCRIPTION_RENEWED: a new order is a new payment; an acknowledged purchase is not acknowledged again', async () => {
    plays[TOKEN] = playSubscription({ householdId: hh.id, ack: true, test: true, orderId: 'GPA.2222-0000-0000-00000' });
    await rt(4);
    const next = new Date(Math.floor((Date.now() + 60 * DAY) / 1000) * 1000);
    plays[TOKEN] = playSubscription({ householdId: hh.id, ack: true, test: true, expiry: next, orderId: 'GPA.2222-0000-0000-00000..1' });
    await rt(2);
    expect((await sub())!.currentPeriodEnd!.getTime()).toBe(next.getTime());
    expect(await BillingTransaction.count({ where: { type: 'payment' } })).toBe(2);
    expect(acks).toEqual([]);
  });

  it('IN_GRACE_PERIOD keeps access until the store grace ends and tells the admins; RECOVERED restores', async () => {
    plays[TOKEN] = playSubscription({ householdId: hh.id, test: true, ack: true });
    await rt(4);
    const until = new Date(Math.floor((Date.now() + 5 * DAY) / 1000) * 1000);
    plays[TOKEN] = playSubscription({ householdId: hh.id, test: true, ack: true, state: 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD', expiry: until });
    await rt(6);
    expect(await sub()).toMatchObject({ status: 'past_due' });
    expect((await sub())!.graceUntil!.getTime()).toBe(until.getTime());
    expect(await ent()).toMatchObject({ allowed: true, reason: 'grace' });
    expect(await BillingTransaction.count({ where: { type: 'failed_payment' } })).toBe(1);
    expect(notifyHouseholdAdmins).toHaveBeenCalledWith(hh.id, 'billing_payment_failed', expect.any(String), expect.stringContaining('Google Play'), expect.anything());

    plays[TOKEN] = playSubscription({ householdId: hh.id, test: true, ack: true });
    await rt(1);
    expect(await sub()).toMatchObject({ status: 'active', graceUntil: null });
  });

  it('ON_HOLD removes access (no grace); PAUSED too', async () => {
    plays[TOKEN] = playSubscription({ householdId: hh.id, test: true, ack: true });
    await rt(4);
    plays[TOKEN] = playSubscription({ householdId: hh.id, test: true, ack: true, state: 'SUBSCRIPTION_STATE_ON_HOLD' });
    await rt(5);
    expect(await sub()).toMatchObject({ status: 'unpaid', graceUntil: null });
    expect((await ent()).allowed).toBe(false);
    plays[TOKEN] = playSubscription({ householdId: hh.id, test: true, ack: true, state: 'SUBSCRIPTION_STATE_PAUSED' });
    await rt(10);
    expect(await sub()).toMatchObject({ status: 'paused' });
    expect((await ent()).allowed).toBe(false);
    await rt(11);
    expect((await lastEvent())!.status).toBe('processed');
  });

  it('CANCELED keeps access to the end of the period as cancel-at-period-end; RESTARTED undoes it; EXPIRED ends it', async () => {
    plays[TOKEN] = playSubscription({ householdId: hh.id, test: true, ack: true });
    await rt(4);
    plays[TOKEN] = playSubscription({ householdId: hh.id, test: true, ack: true, state: 'SUBSCRIPTION_STATE_CANCELED', autoRenew: false });
    await rt(3);
    expect(await sub()).toMatchObject({ status: 'active', cancelAtPeriodEnd: true });
    expect((await ent()).allowed).toBe(true);
    plays[TOKEN] = playSubscription({ householdId: hh.id, test: true, ack: true });
    await rt(7);
    expect((await sub())!.cancelAtPeriodEnd).toBe(false);
    plays[TOKEN] = playSubscription({ householdId: hh.id, test: true, ack: true, state: 'SUBSCRIPTION_STATE_EXPIRED', expiry: new Date(Date.now() - 1000) });
    await rt(13);
    expect(await sub()).toMatchObject({ status: 'canceled' });
    expect(await ent()).toMatchObject({ allowed: false, reason: 'subscription_required' });
  });

  it('DEFERRED, PRICE_CHANGE_CONFIRMED/UPDATED, ITEMS_CHANGED, CANCELLATION_SCHEDULED and STEP_UP just refresh the row', async () => {
    plays[TOKEN] = playSubscription({ householdId: hh.id, test: true, ack: true });
    await rt(4);
    const later = new Date(Math.floor((Date.now() + 90 * DAY) / 1000) * 1000);
    plays[TOKEN] = playSubscription({ householdId: hh.id, test: true, ack: true, expiry: later });
    for (const t of [9, 8, 19, 17, 18, 22]) {
      await rt(t);
      expect((await lastEvent())!.status).toBe('processed');
    }
    expect((await sub())!.currentPeriodEnd!.getTime()).toBe(later.getTime());
  });

  it('PENDING_PURCHASE_CANCELED never grants access', async () => {
    plays[TOKEN] = playSubscription({ householdId: hh.id, test: true, state: 'SUBSCRIPTION_STATE_PENDING' });
    await rt(4);
    expect(await sub()).toMatchObject({ status: 'incomplete' });
    expect((await ent()).allowed).toBe(false);
    expect(acks).toEqual([]); // never acknowledge a pending purchase
    plays[TOKEN] = playSubscription({ householdId: hh.id, test: true, state: 'SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED' });
    await rt(20);
    expect(await sub()).toMatchObject({ status: 'incomplete_expired' });
  });

  it('SUBSCRIPTION_REVOKED cancels immediately', async () => {
    plays[TOKEN] = playSubscription({ householdId: hh.id, test: true, ack: true });
    await rt(4);
    plays[TOKEN] = playSubscription({ householdId: hh.id, test: true, ack: true, state: 'SUBSCRIPTION_STATE_EXPIRED', expiry: new Date(Date.now() - 1000) });
    await rt(12);
    expect((await sub())!.status).toBe('canceled');
  });

  it('a voided subscription purchase cancels access and writes a refund; one-time and test notifications are ignored', async () => {
    plays[TOKEN] = playSubscription({ householdId: hh.id, test: true, ack: true, orderId: 'GPA.3333-0000-0000-00000' });
    await rt(4);
    const voided = rtdn({ voidedPurchaseNotification: { purchaseToken: TOKEN, orderId: 'GPA.3333-0000-0000-00000', productType: 1, refundType: 1 } });
    await push(pubsubBody(voided));
    expect((await sub())!.status).toBe('canceled');
    expect(await BillingTransaction.findOne({ where: { type: 'refund' } })).toMatchObject({ providerObjectId: 'GPA.3333-0000-0000-00000', status: 'succeeded', provider: 'google' });
    expect((await ent()).allowed).toBe(false);

    await push(pubsubBody(rtdn({ voidedPurchaseNotification: { purchaseToken: 'x', orderId: 'o', productType: 2 } })));
    expect((await lastEvent())!.status).toBe('ignored');
    await push(pubsubBody(rtdn({ testNotification: { version: '1.0' } })));
    expect((await lastEvent())!.status).toBe('ignored');
    await push(pubsubBody(rtdn({ oneTimeProductNotification: { notificationType: 1, purchaseToken: 'y', sku: 'z' } })));
    expect((await lastEvent())!.status).toBe('ignored');
  });

  it('an upgrade/downgrade (new token linked to the old one) retires the old row without a duplicate-subscription review', async () => {
    plays[TOKEN] = playSubscription({ householdId: hh.id, test: true, ack: true, productId: 'rootaroo.hh5' });
    await rt(4);
    plays.newtoken1234 = playSubscription({ householdId: hh.id, test: true, productId: 'rootaroo.hh8', linked: TOKEN });
    await rt(4, 'newtoken1234');
    expect((await sub())!.status).toBe('canceled');
    expect(await sub('newtoken1234')).toMatchObject({ status: 'active', seats: 8 });
    expect(await BillingReconciliationItem.count({ where: { kind: 'cross_provider_duplicate' } })).toBe(0);
    expect(await ent()).toMatchObject({ allowed: true, seatsAllowed: 8 });
  });

  it('an untagged purchase raises unmatched_subscription and stores no row', async () => {
    plays[TOKEN] = playSubscription({ householdId: null, test: true });
    await rt(4);
    expect(await BillingSubscription.count()).toBe(0);
    expect(await BillingReconciliationItem.count({ where: { kind: 'unmatched_subscription' } })).toBe(1);
  });

  it('a token the Play API no longer knows is a missing_in_store review item, not a retry loop', async () => {
    await rt(13, 'unknown-token-123456');
    expect(await BillingReconciliationItem.count({ where: { kind: 'missing_in_store' } })).toBe(1);
    expect((await lastEvent())!.status).toBe('processed');
  });

  it('a Play API outage fails the event so the worker retries it', async () => {
    plays[TOKEN] = new Error('503 backend error');
    await rt(2);
    expect(await lastEvent()).toMatchObject({ status: 'failed', attempts: 1 });
    plays[TOKEN] = playSubscription({ householdId: hh.id, test: true, ack: true });
    const ev = (await lastEvent())!;
    const { processEvent } = await import('../../worker');
    expect(await processEvent(ev.id)).toBe('processed');
    expect((await sub())!.status).toBe('active');
  });

  it('a failed acknowledge keeps the customer subscribed and raises a review item', async () => {
    plays[TOKEN] = playSubscription({ householdId: hh.id, test: true });
    ackError = new Error('ack down');
    await rt(4);
    expect((await ent()).allowed).toBe(true);
    expect(await BillingReconciliationItem.count({ where: { kind: 'google_ack_failed' } })).toBe(1);
  });
});

describe('POST /billing/iap/google/verify', () => {
  const post = (user: typeof admin | null, body: Record<string, unknown>) => request(app).post(VERIFY).set(user ? authHeaderFor(user) : {}).send(body);
  const body = (o: Record<string, unknown> = {}) => ({ purchaseToken: TOKEN, productId: 'rootaroo.hh5', ...o });

  it('requires authentication and a household admin', async () => {
    plays[TOKEN] = playSubscription({ householdId: hh.id, test: true });
    expect((await post(null, body())).status).toBe(401);
    expect((await post(await addMember(hh.id), body())).status).toBe(403);
    expect(await BillingSubscription.count()).toBe(0);
  });

  it('503 when Google billing is not configured; 400 for an invalid body', async () => {
    expect((await post(admin, { purchaseToken: 'x', productId: 'nope' })).status).toBe(400);
    __setIapConfigForTests({ apple: null, google: null, appleOnlineChecks: false, warnings: [] });
    expect((await post(admin, body())).status).toBe(503);
  });

  it('verifies with the Play API, stores the entitlement, links the purchaser, then acknowledges', async () => {
    plays[TOKEN] = playSubscription({ householdId: hh.id.toUpperCase(), test: true, orderId: 'GPA.4444-0000-0000-00000' });
    const res = await post(admin, body());
    expect(res.status).toBe(200);
    expect(res.body.data.entitlement).toMatchObject({ allowed: true, reason: 'active' });
    expect(await sub()).toMatchObject({ householdId: hh.id, purchasedByUserId: admin.id, status: 'active' });
    expect(await BillingTransaction.count({ where: { type: 'payment', userId: admin.id } })).toBe(1);
    expect(acks).toEqual([`rootaroo.hh5|${TOKEN}`]);
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST']);
  });

  it('is idempotent (restore): replaying the same token changes nothing and does not re-acknowledge', async () => {
    plays[TOKEN] = playSubscription({ householdId: hh.id, test: true, ack: true, orderId: 'GPA.5555-0000-0000-00000' });
    await post(admin, body());
    expect((await post(admin, body())).status).toBe(200);
    expect(await BillingSubscription.count()).toBe(1);
    expect(await BillingTransaction.count()).toBe(1);
    expect(acks).toEqual([]);
  });

  it('a pending purchase is stored without access and is not acknowledged', async () => {
    plays[TOKEN] = playSubscription({ householdId: hh.id, test: true, state: 'SUBSCRIPTION_STATE_PENDING' });
    const res = await post(admin, body());
    expect(res.status).toBe(200);
    expect(res.body.data.entitlement.allowed).toBe(false);
    expect(acks).toEqual([]);
  });

  it('a failed acknowledge still returns access (the RTDN/reconcile retry acknowledges later)', async () => {
    plays[TOKEN] = playSubscription({ householdId: hh.id, test: true });
    ackError = new Error('ack down');
    const res = await post(admin, body());
    expect(res.status).toBe(200);
    expect(res.body.data.entitlement.allowed).toBe(true);
    expect(await BillingReconciliationItem.count({ where: { kind: 'google_ack_failed' } })).toBe(1);
  });

  it('409 when the purchase is tagged for another household or untagged; nothing stored, nothing acknowledged', async () => {
    const other = await createHouseholdWithAdmin();
    for (const tag of [other.household.id, null]) {
      plays[TOKEN] = playSubscription({ householdId: tag, test: true });
      const res = await post(admin, body());
      expect(res.status).toBe(409);
      expect(res.body.code ?? res.body.error?.code).toBe('PURCHASE_HOUSEHOLD_MISMATCH');
    }
    expect(await BillingSubscription.count()).toBe(0);
    expect(acks).toEqual([]);
  });

  it('400 for an unknown token or a product that is not the purchased one', async () => {
    expect((await post(admin, body({ purchaseToken: 'does-not-exist-123' }))).status).toBe(400);
    plays[TOKEN] = playSubscription({ householdId: hh.id, test: true, productId: 'rootaroo.hh6' });
    expect((await post(admin, body({ productId: 'rootaroo.hh5' }))).status).toBe(400);
    expect(await BillingSubscription.count()).toBe(0);
  });

  it('503 when the Play API is down', async () => {
    plays[TOKEN] = new Error('boom');
    expect((await post(admin, body())).status).toBe(503);
  });
});
