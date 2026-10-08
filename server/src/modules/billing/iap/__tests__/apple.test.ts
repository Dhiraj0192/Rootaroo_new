import crypto from 'crypto';
import { APPLE_ROOT_CA_G3_PEM } from '../appleRootCaG3';
import {
  __setAppleRootsForTests, AppleVerificationError, mapAppleToPurchase, priceToMinor, verifyNotification, verifyTransaction,
} from '../apple';
import { __setIapConfigForTests } from '../config';
import { __setBillingConfigForTests } from '../../config';
import { testBillingConfig } from '../../../../test/billing/config';
import {
  appleNotification, appleRenewal, appleTransaction, buildTestChain, signJws, TEST_APP_APPLE_ID, TEST_BUNDLE,
} from '../../../../test/billing/appleFixtures';

const HH = '0a1b2c3d-0000-4000-8000-000000000001';
const iap = (over: Record<string, unknown> = {}) => ({
  apple: { keyId: 'K', issuerId: 'I', privateKey: 'p', bundleId: TEST_BUNDLE, appAppleId: TEST_APP_APPLE_ID, ...over },
  google: null, appleOnlineChecks: false, warnings: [],
});

let chain = buildTestChain('Test');

beforeEach(() => {
  chain = buildTestChain('Test');
  __setAppleRootsForTests([chain.rootDer]);
  __setIapConfigForTests(iap() as never);
  __setBillingConfigForTests(testBillingConfig());
});
afterAll(() => { __setAppleRootsForTests(null); __setIapConfigForTests(null); __setBillingConfigForTests(null); });

describe('vendored Apple Root CA G3', () => {
  it('is pinned to the published SHA-256 fingerprint and subject', () => {
    const cert = new crypto.X509Certificate(APPLE_ROOT_CA_G3_PEM);
    expect(cert.fingerprint256).toBe('63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79');
    expect(cert.subject).toContain('CN=Apple Root CA - G3');
    expect(cert.ca).toBe(true);
  });
});

describe('verifyNotification', () => {
  const tx = (env: 'Sandbox' | 'Production' = 'Sandbox') => appleTransaction({ environment: env, appAccountToken: HH });

  it('accepts a valid Sandbox notification as livemode=false and decodes the nested JWS', async () => {
    const v = await verifyNotification(appleNotification(chain, { type: 'SUBSCRIBED', subtype: 'INITIAL_BUY', tx: tx() }));
    expect(v).toMatchObject({ environment: 'Sandbox', livemode: false });
    expect(v.notification.notificationType).toBe('SUBSCRIBED');
    expect(v.transaction!.appAccountToken).toBe(HH);
    expect(v.renewal!.autoRenewStatus).toBe(1);
  });

  it('accepts a valid Production notification as livemode=true when the app id matches', async () => {
    const v = await verifyNotification(appleNotification(chain, { type: 'DID_RENEW', environment: 'Production', tx: tx('Production'), renewal: appleRenewal({ environment: 'Production' }) }));
    expect(v).toMatchObject({ environment: 'Production', livemode: true });
  });

  it('rejects Production data with the wrong app Apple id, and when none is configured', async () => {
    const jws = appleNotification(chain, { type: 'DID_RENEW', environment: 'Production', tx: tx('Production'), appAppleId: 999 });
    await expect(verifyNotification(jws)).rejects.toThrow(AppleVerificationError);
    __setIapConfigForTests(iap({ appAppleId: null }) as never);
    __setAppleRootsForTests([chain.rootDer]);
    await expect(verifyNotification(appleNotification(chain, { type: 'DID_RENEW', environment: 'Production', tx: tx('Production') }))).rejects.toThrow(/APPLE_APP_APPLE_ID/);
  });

  it('rejects a wrong bundle id', async () => {
    await expect(verifyNotification(appleNotification(chain, { type: 'SUBSCRIBED', bundleId: 'com.evil.app', tx: tx() }))).rejects.toThrow(AppleVerificationError);
  });

  it('rejects a nested transaction from a different environment than the notification', async () => {
    await expect(verifyNotification(appleNotification(chain, { type: 'SUBSCRIBED', tx: tx('Production') }))).rejects.toThrow(AppleVerificationError);
  });

  it('rejects a nested transaction with a wrong bundle id', async () => {
    await expect(verifyNotification(appleNotification(chain, { type: 'SUBSCRIBED', tx: appleTransaction({ bundleId: 'com.evil.app' }) }))).rejects.toThrow(AppleVerificationError);
  });

  it('rejects a tampered payload (signature no longer matches)', async () => {
    const jws = appleNotification(chain, { type: 'SUBSCRIBED', tx: tx() });
    const [h, p, s] = jws.split('.');
    const body = JSON.parse(Buffer.from(p, 'base64url').toString());
    body.notificationType = 'REFUND_REVERSED';
    const forged = `${h}.${Buffer.from(JSON.stringify(body)).toString('base64url')}.${s}`;
    await expect(verifyNotification(forged)).rejects.toThrow(AppleVerificationError);
  });

  it('rejects a chain that does not root at the trusted root', async () => {
    const other = buildTestChain('Other');
    await expect(verifyNotification(appleNotification(other, { type: 'SUBSCRIBED', tx: tx() }))).rejects.toThrow(AppleVerificationError);
  });

  it('rejects a JWS signed with a key that is not the leaf certificate key', async () => {
    const other = buildTestChain('Other');
    const jws = signJws({ notificationType: 'SUBSCRIBED', notificationUUID: 'x', signedDate: Date.now(), data: { environment: 'Sandbox', bundleId: TEST_BUNDLE, appAppleId: TEST_APP_APPLE_ID } }, { ...chain, leafKey: other.leafKey });
    await expect(verifyNotification(jws)).rejects.toThrow(AppleVerificationError);
  });

  it('rejects a chain of the wrong length and a missing x5c', async () => {
    await expect(verifyNotification(signJws({ notificationType: 'TEST', data: { environment: 'Sandbox', bundleId: TEST_BUNDLE } }, chain, { x5c: chain.x5c.slice(0, 2) }))).rejects.toThrow(AppleVerificationError);
    await expect(verifyNotification(signJws({ notificationType: 'TEST', data: { environment: 'Sandbox', bundleId: TEST_BUNDLE } }, chain, { x5c: undefined }))).rejects.toThrow(AppleVerificationError);
  });

  it('rejects garbage, an unsupported environment and an unsigned (alg none) token', async () => {
    await expect(verifyNotification('nope')).rejects.toThrow(AppleVerificationError);
    await expect(verifyNotification(signJws({ notificationType: 'TEST', data: { environment: 'Xcode' } }, chain))).rejects.toThrow(/environment/);
    const head = Buffer.from(JSON.stringify({ alg: 'none', x5c: chain.x5c })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ notificationType: 'TEST', data: { environment: 'Sandbox', bundleId: TEST_BUNDLE } })).toString('base64url');
    await expect(verifyNotification(`${head}.${body}.`)).rejects.toThrow(AppleVerificationError);
  });

  it('a real-Apple-format notification is rejected when its chain does not root at Apple Root CA G3', async () => {
    // Production trust store: no test override. The chain has Apple's shape and OIDs but is not Apple's.
    __setAppleRootsForTests(null);
    __setIapConfigForTests(iap() as never);
    const jws = appleNotification(chain, { type: 'SUBSCRIBED', subtype: 'INITIAL_BUY', tx: tx() });
    await expect(verifyNotification(jws)).rejects.toMatchObject({ name: 'Error', message: expect.stringMatching(/verification failed/), retryable: false });
  });
});

describe('verifyTransaction', () => {
  it('verifies a device transaction and returns its environment', async () => {
    const { transaction, environment } = await verifyTransaction(signJws(appleTransaction({ appAccountToken: HH }), chain));
    expect(environment).toBe('Sandbox');
    expect(transaction.appAccountToken).toBe(HH);
  });

  it('rejects a foreign chain', async () => {
    await expect(verifyTransaction(signJws(appleTransaction(), buildTestChain('Other')))).rejects.toThrow(AppleVerificationError);
  });
});

describe('mapAppleToPurchase (notification decision table)', () => {
  const day = 86400_000;
  const tx = (o: Record<string, unknown> = {}) => appleTransaction({ appAccountToken: HH.toUpperCase(), ...o }) as never;
  const rn = (o: Record<string, unknown> = {}) => appleRenewal(o) as never;
  const map = (type: string, extra: Record<string, unknown> = {}, t = tx(), r: unknown = rn()) =>
    mapAppleToPurchase({ transaction: t, renewal: r as never, notificationType: type, signedDate: Date.now(), ...extra });

  it('SUBSCRIBED and DID_RENEW are active with the household from appAccountToken, seats and interval from the product', () => {
    for (const type of ['SUBSCRIBED', 'DID_RENEW', 'OFFER_REDEEMED', 'PRICE_INCREASE', 'RENEWAL_EXTENDED']) {
      const vp = map(type, {}, tx({ productId: 'rootaroo.hh8.year', price: 20990, currency: 'USD' }));
      expect(vp).toMatchObject({ status: 'active', provider: 'apple', livemode: false, seats: 8, interval: 'year', householdId: HH, unitAmount: 2099, currency: 'usd', cancelAtPeriodEnd: false });
      expect(vp.subscriptionId).toBe('2000000111111');
    }
  });

  it('Production environment maps to livemode=true', () => {
    expect(map('DID_RENEW', {}, tx({ environment: 'Production' })).livemode).toBe(true);
  });

  it('DID_FAIL_TO_RENEW with GRACE_PERIOD is past_due until the store grace expiry', () => {
    const grace = Date.now() + 6 * day;
    const vp = map('DID_FAIL_TO_RENEW', { subtype: 'GRACE_PERIOD' }, tx(), rn({ gracePeriodExpiresDate: grace, isInBillingRetryPeriod: true }));
    expect(vp.status).toBe('past_due');
    expect(vp.graceUntil!.getTime()).toBe(grace);
  });

  it('past_due without a store expiry falls back to expiry + BILLING_GRACE_DAYS', () => {
    const expires = Date.now() + day;
    const vp = map('DID_FAIL_TO_RENEW', { subtype: 'GRACE_PERIOD' }, tx({ expiresDate: expires }), rn());
    expect(vp.graceUntil!.getTime()).toBe(expires + 7 * day);
  });

  it('DID_FAIL_TO_RENEW without grace is unpaid (billing retry grants no access); GRACE_PERIOD_EXPIRED too', () => {
    expect(map('DID_FAIL_TO_RENEW').status).toBe('unpaid');
    expect(map('GRACE_PERIOD_EXPIRED').status).toBe('unpaid');
    expect(map('DID_FAIL_TO_RENEW').graceUntil).toBeNull();
  });

  it('EXPIRED is canceled and ended at the expiry date', () => {
    const expires = Date.now() - day;
    const vp = map('EXPIRED', { subtype: 'VOLUNTARY' }, tx({ expiresDate: expires }));
    expect(vp).toMatchObject({ status: 'canceled', cancelAtPeriodEnd: false });
    expect(vp.endedAt!.getTime()).toBe(expires);
  });

  it('REFUND and REVOKE cancel immediately', () => {
    const revocationDate = Date.now() - 1000;
    for (const type of ['REFUND', 'REVOKE']) {
      const vp = map(type, {}, tx({ revocationDate, revocationReason: 0 }));
      expect(vp.status).toBe('canceled');
      expect(vp.endedAt!.getTime()).toBe(revocationDate);
    }
    expect(map('REFUND').status).toBe('canceled');
  });

  it('REFUND_REVERSED restores an unexpired subscription', () => {
    expect(map('REFUND_REVERSED').status).toBe('active');
  });

  it('DID_CHANGE_RENEWAL_STATUS reflects auto-renew off as cancel-at-period-end', () => {
    const vp = map('DID_CHANGE_RENEWAL_STATUS', { subtype: 'AUTO_RENEW_DISABLED' }, tx(), rn({ autoRenewStatus: 0 }));
    expect(vp).toMatchObject({ status: 'active', cancelAtPeriodEnd: true });
    expect(map('DID_CHANGE_RENEWAL_STATUS', { subtype: 'AUTO_RENEW_ENABLED' }).cancelAtPeriodEnd).toBe(false);
  });

  it('DID_CHANGE_RENEWAL_PREF downgrade keeps the current size and records the scheduled one', () => {
    const vp = map('DID_CHANGE_RENEWAL_PREF', { subtype: 'DOWNGRADE' }, tx({ productId: 'rootaroo.hh8.month' }), rn({ autoRenewProductId: 'rootaroo.hh6.month' }));
    expect(vp.seats).toBe(8);
    expect(vp.pendingUpdate).toEqual({ productId: 'rootaroo.hh6.month', seats: 6, interval: 'month' });
  });

  it('DID_CHANGE_RENEWAL_PREF upgrade applies the new product at once with nothing pending', () => {
    const vp = map('DID_CHANGE_RENEWAL_PREF', { subtype: 'UPGRADE' }, tx({ productId: 'rootaroo.hh9.month' }), rn({ autoRenewProductId: 'rootaroo.hh9.month' }));
    expect(vp).toMatchObject({ seats: 9, pendingUpdate: null });
  });

  it('data.status from the notification wins: 3 retry, 4 grace, 2 expired, 5 revoked', () => {
    expect(map('DID_RENEW', { status: 3 }).status).toBe('unpaid');
    expect(map('DID_RENEW', { status: 4 }, tx(), rn({ gracePeriodExpiresDate: Date.now() + day })).status).toBe('past_due');
    expect(map('DID_RENEW', { status: 2 }).status).toBe('canceled');
    expect(map('DID_RENEW', { status: 5 }).status).toBe('canceled');
  });

  it('a device transaction with no notification: expired dates are canceled, future dates active', () => {
    expect(mapAppleToPurchase({ transaction: tx({ expiresDate: Date.now() - 1000 }) }).status).toBe('canceled');
    expect(mapAppleToPurchase({ transaction: tx() }).status).toBe('active');
  });

  it('an unknown product has null seats; a missing/invalid appAccountToken has a null household', () => {
    const vp = mapAppleToPurchase({ transaction: tx({ productId: 'other', appAccountToken: 'x' }) });
    expect(vp.seats).toBeNull();
    expect(vp.householdId).toBeNull();
  });

  it('prices are milliunits: 8990 is 899 cents', () => {
    expect(priceToMinor(8990)).toBe(899);
    expect(priceToMinor(undefined)).toBeNull();
  });
});
