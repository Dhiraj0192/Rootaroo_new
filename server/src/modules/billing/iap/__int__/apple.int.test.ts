jest.mock('../../notify', () => ({ notifyHouseholdAdmins: jest.fn(), alertStaff: jest.fn() }));

import request from 'supertest';
import app from '../../../../app';
import { setupAssociations, BillingEvent, BillingReconciliationItem, BillingSubscription, BillingTransaction } from '../../../../database/models';
import { resetDb, closeIntResources } from '../../../../test/int/db';
import { createHouseholdWithAdmin, addMember, authHeaderFor } from '../../../../test/factories';
import { testBillingConfig } from '../../../../test/billing/config';
import {
  appleNotification, appleRenewal, appleTransaction, buildTestChain, signJws, TEST_APP_APPLE_ID, TEST_BUNDLE, TestChain,
} from '../../../../test/billing/appleFixtures';
import { __setBillingConfigForTests } from '../../config';
import { __setIapConfigForTests } from '../config';
import { __setAppleApiClientForTests, __setAppleRootsForTests } from '../apple';
import { getEntitlement } from '../../entitlement';
import { notifyHouseholdAdmins } from '../../notify';
import { __drainForTests } from '../../worker';

const WEBHOOK = '/api/v1/billing/webhooks/apple';
const VERIFY = '/api/v1/billing/iap/apple/verify';
const OTID = '2000000111111';
const DAY = 86400_000;
const iapCfg = (apple: unknown = { keyId: 'K', issuerId: 'I', privateKey: 'p', bundleId: TEST_BUNDLE, appAppleId: TEST_APP_APPLE_ID }) =>
  ({ apple, google: null, appleOnlineChecks: false, warnings: [] }) as never;

let chain: TestChain;
let hh: { id: string };
let admin: Awaited<ReturnType<typeof createHouseholdWithAdmin>>['admin'];

beforeAll(() => setupAssociations());
beforeEach(async () => {
  await __drainForTests();
  await resetDb();
  chain = buildTestChain('Test');
  __setAppleRootsForTests([chain.rootDer]);
  __setIapConfigForTests(iapCfg());
  __setBillingConfigForTests(testBillingConfig());
  __setAppleApiClientForTests(null);
  const made = await createHouseholdWithAdmin();
  hh = made.household;
  admin = made.admin;
  (notifyHouseholdAdmins as jest.Mock).mockClear();
});
afterAll(async () => { await __drainForTests(); __setAppleRootsForTests(null); __setIapConfigForTests(null); __setBillingConfigForTests(null); await closeIntResources(); });

const tx = (o: Record<string, unknown> = {}) => appleTransaction({ originalTransactionId: OTID, appAccountToken: hh.id.toUpperCase(), ...o });
const send = async (jws: string) => {
  const res = await request(app).post(WEBHOOK).set('Content-Type', 'application/json').send(JSON.stringify({ signedPayload: jws }));
  await __drainForTests();
  return res;
};
const notify = (spec: Parameters<typeof appleNotification>[1]) => send(appleNotification(chain, { tx: tx(), ...spec }));
const sub = () => BillingSubscription.findOne({ where: { provider: 'apple', providerSubscriptionId: OTID } });
const eventStatus = async () => (await BillingEvent.findOne({ order: [['createdAt', 'DESC']] }))!.status;

describe('Apple webhook receiver', () => {
  it('answers 503 when Apple IAP is not configured', async () => {
    __setIapConfigForTests(iapCfg(null));
    expect((await notify({ type: 'SUBSCRIBED' })).status).toBe(503);
    expect(await BillingEvent.count()).toBe(0);
  });

  it('400s on a bad signature, foreign chain, wrong content, malformed or missing body; no row written', async () => {
    const good = appleNotification(chain, { type: 'SUBSCRIBED', tx: tx() });
    const [h, p] = good.split('.');
    expect((await send(`${h}.${p}.AAAA`)).status).toBe(400);
    expect((await send(appleNotification(buildTestChain('Other'), { type: 'SUBSCRIBED', tx: tx() }))).status).toBe(400);
    expect((await send(appleNotification(chain, { type: 'SUBSCRIBED', bundleId: 'com.evil.app', tx: tx() }))).status).toBe(400);
    expect((await request(app).post(WEBHOOK).set('Content-Type', 'application/json').send('{nope')).status).toBe(400);
    expect((await request(app).post(WEBHOOK).set('Content-Type', 'application/json').send('{}')).status).toBe(400);
    expect((await request(app).post(WEBHOOK).set('Content-Type', 'text/plain').send('x')).status).toBe(400);
    expect((await request(app).post(WEBHOOK).set('Content-Type', 'application/json').send(JSON.stringify({ signedPayload: 'x'.repeat(1_100_000) }))).status).toBe(413);
    expect(await BillingEvent.count()).toBe(0);
  });

  it('duplicate delivery of the same notificationUUID: 200 both times, processed once', async () => {
    const jws = appleNotification(chain, { type: 'SUBSCRIBED', uuid: 'dup-uuid-1', tx: tx() });
    const [a, b] = await Promise.all([send(jws), send(jws)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await BillingEvent.count({ where: { providerEventId: 'dup-uuid-1' } })).toBe(1);
    expect(await BillingTransaction.count()).toBe(1);
  });

  it('SUBSCRIBED/INITIAL_BUY creates the subscription, grants entitlement and writes the ledger', async () => {
    const res = await notify({ type: 'SUBSCRIBED', subtype: 'INITIAL_BUY', tx: tx({ productId: 'rootaroo.hh7.year', price: 20990 }) });
    expect(res.status).toBe(200);
    expect(await sub()).toMatchObject({ householdId: hh.id, provider: 'apple', livemode: false, status: 'active', seats: 7, interval: 'year' });
    expect(await getEntitlement(hh.id, { bypassCache: true })).toMatchObject({ allowed: true, reason: 'active', seatsAllowed: 7 });
    expect(await BillingTransaction.findOne()).toMatchObject({ provider: 'apple', type: 'payment', amount: 2099, currency: 'usd', householdId: hh.id, billingReason: 'subscription_create' });
    expect(await BillingEvent.findOne()).toMatchObject({ provider: 'apple', livemode: false, type: 'SUBSCRIBED.INITIAL_BUY', status: 'processed' });
  });

  it('a Production notification is stored with livemode=true', async () => {
    await send(appleNotification(chain, {
      type: 'SUBSCRIBED', environment: 'Production', tx: tx({ environment: 'Production' }), renewal: appleRenewal({ environment: 'Production' }),
    }));
    expect((await sub())!.livemode).toBe(true);
    expect((await BillingEvent.findOne())!.livemode).toBe(true);
  });

  it('DID_RENEW extends the period and records one new payment per transaction', async () => {
    await notify({ type: 'SUBSCRIBED', tx: tx({ transactionId: '3001' }) });
    const next = Math.floor((Date.now() + 60 * DAY) / 1000) * 1000;
    await notify({ type: 'DID_RENEW', tx: tx({ transactionId: '3002', expiresDate: next, purchaseDate: Date.now() }) });
    expect((await sub())!.currentPeriodEnd!.getTime()).toBe(next);
    expect(await BillingTransaction.count({ where: { type: 'payment' } })).toBe(2);
  });

  it('DID_FAIL_TO_RENEW with a grace period keeps access until the store grace ends, then recovers on DID_RENEW', async () => {
    await notify({ type: 'SUBSCRIBED' });
    const grace = Math.floor((Date.now() + 5 * DAY) / 1000) * 1000;
    await notify({ type: 'DID_FAIL_TO_RENEW', subtype: 'GRACE_PERIOD', renewal: appleRenewal({ gracePeriodExpiresDate: grace, isInBillingRetryPeriod: true }) });
    expect(await sub()).toMatchObject({ status: 'past_due' });
    expect((await sub())!.graceUntil!.getTime()).toBe(grace);
    expect(await getEntitlement(hh.id, { bypassCache: true })).toMatchObject({ allowed: true, reason: 'grace' });
    expect(await BillingTransaction.count({ where: { type: 'failed_payment' } })).toBe(1);
    expect(notifyHouseholdAdmins).toHaveBeenCalledWith(hh.id, 'billing_payment_failed', expect.any(String), expect.stringContaining('Apple'), expect.anything());

    await notify({ type: 'DID_RENEW', subtype: 'BILLING_RECOVERY', tx: tx({ transactionId: '3999', expiresDate: Date.now() + 30 * DAY }) });
    expect(await sub()).toMatchObject({ status: 'active', graceUntil: null });
    expect(await getEntitlement(hh.id, { bypassCache: true })).toMatchObject({ allowed: true, reason: 'active' });
  });

  it('DID_FAIL_TO_RENEW without grace, then GRACE_PERIOD_EXPIRED: no access', async () => {
    await notify({ type: 'SUBSCRIBED' });
    await notify({ type: 'DID_FAIL_TO_RENEW', subtype: undefined, tx: tx({ expiresDate: Date.now() - DAY }) });
    expect((await sub())!.status).toBe('unpaid');
    expect((await getEntitlement(hh.id, { bypassCache: true })).allowed).toBe(false);
    await notify({ type: 'GRACE_PERIOD_EXPIRED', tx: tx({ expiresDate: Date.now() - DAY }) });
    expect((await sub())!.status).toBe('unpaid');
  });

  it('EXPIRED cancels and ends access', async () => {
    await notify({ type: 'SUBSCRIBED' });
    const expires = Math.floor((Date.now() - 1000) / 1000) * 1000;
    await notify({ type: 'EXPIRED', subtype: 'VOLUNTARY', tx: tx({ expiresDate: expires }) });
    expect(await sub()).toMatchObject({ status: 'canceled' });
    expect((await sub())!.endedAt!.getTime()).toBe(expires);
    expect(await getEntitlement(hh.id, { bypassCache: true })).toMatchObject({ allowed: false, reason: 'subscription_required' });
  });

  it('REFUND revokes access and writes a refund ledger row; REFUND_REVERSED restores both', async () => {
    await notify({ type: 'SUBSCRIBED', tx: tx({ transactionId: '4001' }) });
    await notify({ type: 'REFUND', tx: tx({ transactionId: '4001', revocationDate: Date.now() - 1000, revocationReason: 0 }) });
    expect((await sub())!.status).toBe('canceled');
    expect(await BillingTransaction.findOne({ where: { type: 'refund' } })).toMatchObject({ status: 'succeeded', amount: 899, providerObjectId: '4001' });
    expect((await getEntitlement(hh.id, { bypassCache: true })).allowed).toBe(false);

    await notify({ type: 'REFUND_REVERSED', tx: tx({ transactionId: '4001' }), signedDate: Date.now() + 1000 });
    expect((await sub())!.status).toBe('active');
    expect((await BillingTransaction.findOne({ where: { type: 'refund' } }))!.status).toBe('reversed');
  });

  it('REVOKE (family sharing removed) cancels', async () => {
    await notify({ type: 'SUBSCRIBED' });
    await notify({ type: 'REVOKE', tx: tx({ revocationDate: Date.now() - 1000 }) });
    expect((await sub())!.status).toBe('canceled');
  });

  it('DID_CHANGE_RENEWAL_STATUS toggles cancel-at-period-end without touching access', async () => {
    await notify({ type: 'SUBSCRIBED' });
    await notify({ type: 'DID_CHANGE_RENEWAL_STATUS', subtype: 'AUTO_RENEW_DISABLED', renewal: appleRenewal({ autoRenewStatus: 0 }) });
    expect(await sub()).toMatchObject({ status: 'active', cancelAtPeriodEnd: true });
    expect((await getEntitlement(hh.id, { bypassCache: true })).allowed).toBe(true);
    await notify({ type: 'DID_CHANGE_RENEWAL_STATUS', subtype: 'AUTO_RENEW_ENABLED', renewal: appleRenewal({ autoRenewStatus: 1 }) });
    expect((await sub())!.cancelAtPeriodEnd).toBe(false);
  });

  it('DID_CHANGE_RENEWAL_PREF: a downgrade is pending until renewal, an upgrade applies at once', async () => {
    await notify({ type: 'SUBSCRIBED', tx: tx({ productId: 'rootaroo.hh8.month' }), renewal: appleRenewal({ autoRenewProductId: 'rootaroo.hh8.month' }) });
    await notify({ type: 'DID_CHANGE_RENEWAL_PREF', subtype: 'DOWNGRADE', tx: tx({ productId: 'rootaroo.hh8.month' }), renewal: appleRenewal({ autoRenewProductId: 'rootaroo.hh6.month' }) });
    expect(await sub()).toMatchObject({ seats: 8, pendingUpdate: { productId: 'rootaroo.hh6.month', seats: 6, interval: 'month' } });
    await notify({ type: 'DID_RENEW', tx: tx({ productId: 'rootaroo.hh6.month', transactionId: '5002' }), renewal: appleRenewal({ autoRenewProductId: 'rootaroo.hh6.month' }) });
    expect(await sub()).toMatchObject({ seats: 6, pendingUpdate: null });
    await notify({ type: 'DID_CHANGE_RENEWAL_PREF', subtype: 'UPGRADE', tx: tx({ productId: 'rootaroo.hh10.month', transactionId: '5003' }), renewal: appleRenewal({ autoRenewProductId: 'rootaroo.hh10.month' }) });
    expect(await sub()).toMatchObject({ seats: 10, pendingUpdate: null });
  });

  it('OFFER_REDEEMED, PRICE_INCREASE and RENEWAL_EXTENDED refresh the row', async () => {
    await notify({ type: 'SUBSCRIBED' });
    const later = Math.floor((Date.now() + 90 * DAY) / 1000) * 1000;
    for (const type of ['OFFER_REDEEMED', 'PRICE_INCREASE', 'RENEWAL_EXTENDED']) {
      await notify({ type, tx: tx({ expiresDate: later }) });
      expect(await eventStatus()).toBe('processed');
    }
    expect((await sub())!.currentPeriodEnd!.getTime()).toBe(later);
  });

  it('ignores TEST, CONSUMPTION_REQUEST, REFUND_DECLINED and a transaction-less notification', async () => {
    for (const type of ['TEST', 'CONSUMPTION_REQUEST', 'REFUND_DECLINED', 'ONE_TIME_CHARGE']) {
      await notify({ type });
      expect(await eventStatus()).toBe('ignored');
    }
    await send(appleNotification(chain, { type: 'DID_RENEW', tx: null, renewal: null }));
    expect(await eventStatus()).toBe('ignored');
    expect(await BillingSubscription.count()).toBe(0);
  });

  it('an out-of-order older notification does not overwrite newer state', async () => {
    const t0 = Date.now();
    await notify({ type: 'EXPIRED', tx: tx({ expiresDate: t0 - 1000 }), signedDate: t0 + 10_000 });
    await notify({ type: 'DID_RENEW', tx: tx({ transactionId: '6001', expiresDate: t0 + DAY }), signedDate: t0 });
    expect((await sub())!.status).toBe('canceled');
  });

  it('an untagged purchase raises an unmatched_subscription review item and creates no row', async () => {
    await notify({ type: 'SUBSCRIBED', tx: tx({ appAccountToken: undefined }) });
    expect(await BillingSubscription.count()).toBe(0);
    expect(await BillingReconciliationItem.count({ where: { kind: 'unmatched_subscription' } })).toBe(1);
    expect(await eventStatus()).toBe('processed');
  });

  it('a notification tagged for another household cannot move an existing subscription', async () => {
    const other = await createHouseholdWithAdmin();
    await notify({ type: 'SUBSCRIBED' });
    await notify({ type: 'DID_RENEW', tx: tx({ appAccountToken: other.household.id }) });
    expect((await sub())!.householdId).toBe(hh.id);
    expect(await BillingReconciliationItem.count({ where: { kind: 'store_household_mismatch' } })).toBe(1);
  });
});

describe('POST /billing/iap/apple/verify', () => {
  const post = (user: typeof admin | null, signedTransaction: string) =>
    request(app).post(VERIFY).set(user ? authHeaderFor(user) : {}).send({ signedTransaction });
  const device = (o: Record<string, unknown> = {}) => signJws(tx(o), chain);

  it('requires authentication and a household admin', async () => {
    expect((await post(null, device())).status).toBe(401);
    const member = await addMember(hh.id);
    expect((await post(member, device())).status).toBe(403);
    expect(await BillingSubscription.count()).toBe(0);
  });

  it('503 when Apple IAP is not configured', async () => {
    __setIapConfigForTests(iapCfg(null));
    expect((await post(admin, device())).status).toBe(503);
  });

  it('verifies a device transaction, grants entitlement and links the purchaser', async () => {
    const res = await post(admin, device({ productId: 'rootaroo.hh6.month' }));
    expect(res.status).toBe(200);
    expect(res.body.data.entitlement).toMatchObject({ allowed: true, reason: 'active', seatsAllowed: 6 });
    expect(await sub()).toMatchObject({ householdId: hh.id, purchasedByUserId: admin.id, seats: 6 });
    expect(await BillingTransaction.count({ where: { type: 'payment', userId: admin.id } })).toBe(1);
  });

  it('is idempotent (restore purchases replays the same transaction)', async () => {
    await post(admin, device({ transactionId: '7001' }));
    expect((await post(admin, device({ transactionId: '7001' }))).status).toBe(200);
    expect(await BillingSubscription.count()).toBe(1);
    expect(await BillingTransaction.count()).toBe(1);
  });

  it('uses the App Store Server API status when configured (renewal off, billing grace)', async () => {
    const original = tx({ transactionId: '7002' });
    const getAllSubscriptionStatuses = jest.fn(async () => ({
      data: [{ lastTransactions: [{ originalTransactionId: OTID, status: 1, signedTransactionInfo: signJws(original, chain), signedRenewalInfo: signJws(appleRenewal({ autoRenewStatus: 0 }), chain) }] }],
    }));
    __setAppleApiClientForTests(() => ({ getAllSubscriptionStatuses }) as never);
    const res = await post(admin, signJws(original, chain));
    expect(res.status).toBe(200);
    expect(getAllSubscriptionStatuses).toHaveBeenCalledWith(OTID);
    expect((await sub())!.cancelAtPeriodEnd).toBe(true);
  });

  it('falls back to the signed transaction when the status API fails', async () => {
    __setAppleApiClientForTests(() => ({ getAllSubscriptionStatuses: jest.fn(async () => { throw new Error('boom'); }) }) as never);
    expect((await post(admin, device())).status).toBe(200);
    expect((await sub())!.status).toBe('active');
  });

  it('409 when appAccountToken is another household or missing; nothing stored', async () => {
    const other = await createHouseholdWithAdmin();
    for (const token of [other.household.id, undefined]) {
      const res = await post(admin, device({ appAccountToken: token }));
      expect(res.status).toBe(409);
      expect(res.body.code ?? res.body.error?.code).toBe('PURCHASE_HOUSEHOLD_MISMATCH');
    }
    expect(await BillingSubscription.count()).toBe(0);
  });

  it('400 for a transaction signed by a foreign chain, an unknown product, or garbage', async () => {
    expect((await post(admin, signJws(tx(), buildTestChain('Other')))).status).toBe(400);
    expect((await post(admin, device({ productId: 'com.other.product' }))).status).toBe(400);
    expect((await post(admin, 'x'.repeat(30))).status).toBe(400);
    expect(await BillingSubscription.count()).toBe(0);
  });

  it('a subscription already owned by another household cannot be claimed: 409', async () => {
    const other = await createHouseholdWithAdmin();
    await send(appleNotification(chain, { type: 'SUBSCRIBED', tx: tx({ appAccountToken: other.household.id }) }));
    const res = await post(admin, device());
    expect(res.status).toBe(409);
  });
});
