import { __setBillingConfigForTests } from '../../config';
import { __setIapConfigForTests } from '../config';
import { GoogleAuthError, mapGoogleToPurchase, priceToCents, verifyPushAuthorization } from '../google';
import { testBillingConfig } from '../../../../test/billing/config';
import {
  makeOidcKey, oidcToken, playSubscription, TEST_AUDIENCE, TEST_PACKAGE, TEST_PUSH_SA, trustOidcKey, OidcKey,
} from '../../../../test/billing/googleFixtures';

const HH = '0a1b2c3d-0000-4000-8000-000000000002';
const DAY = 86400_000;

beforeEach(() => {
  __setBillingConfigForTests(testBillingConfig());
  __setIapConfigForTests({
    apple: null, appleOnlineChecks: false, warnings: [],
    google: { serviceAccountJson: '{}', packageName: TEST_PACKAGE, rtdnAudience: TEST_AUDIENCE, rtdnServiceAccountEmail: TEST_PUSH_SA },
  });
});
afterAll(() => { __setBillingConfigForTests(null); __setIapConfigForTests(null); });

describe('verifyPushAuthorization (Pub/Sub OIDC token)', () => {
  let key: OidcKey;
  let restore: () => void;
  beforeEach(() => { key = makeOidcKey(); restore = trustOidcKey(key); });
  afterEach(() => restore());
  const auth = (claims: Record<string, unknown> = {}, k: OidcKey = key) => `Bearer ${oidcToken(k, claims)}`;

  it('accepts a token for our audience from the configured push service account', async () => {
    await expect(verifyPushAuthorization(auth())).resolves.toBeUndefined();
  });

  it('rejects a missing or malformed header', async () => {
    await expect(verifyPushAuthorization(undefined)).rejects.toThrow(GoogleAuthError);
    await expect(verifyPushAuthorization('Basic abc')).rejects.toThrow(GoogleAuthError);
    await expect(verifyPushAuthorization('Bearer not.a.jwt')).rejects.toThrow(GoogleAuthError);
  });

  it('rejects the wrong audience, another service account, an unverified email, and an expired token', async () => {
    await expect(verifyPushAuthorization(auth({ aud: 'https://evil.example.test/hook' }))).rejects.toThrow(GoogleAuthError);
    await expect(verifyPushAuthorization(auth({ email: 'someone@rootaroo-test.iam.gserviceaccount.com' }))).rejects.toThrow(/push service account/);
    await expect(verifyPushAuthorization(auth({ email_verified: false }))).rejects.toThrow(/push service account/);
    await expect(verifyPushAuthorization(auth({ exp: Math.floor(Date.now() / 1000) - 3600, iat: Math.floor(Date.now() / 1000) - 7200 }))).rejects.toThrow(GoogleAuthError);
  });

  it('rejects a token signed by a key Google does not publish, and a wrong issuer', async () => {
    await expect(verifyPushAuthorization(auth({}, { ...makeOidcKey(), kid: key.kid }))).rejects.toThrow(GoogleAuthError);
    await expect(verifyPushAuthorization(auth({ iss: 'https://evil.example.test' }))).rejects.toThrow(GoogleAuthError);
  });
});

describe('mapGoogleToPurchase (subscriptionsv2 decision table)', () => {
  const map = (o: Parameters<typeof playSubscription>[0] = {}, opts = {}) => mapGoogleToPurchase(playSubscription({ householdId: HH, ...o }), 'tok-1', opts);

  it('ACTIVE: seats/interval from product + base plan, household from the obfuscated account id, cents from the recurring price', () => {
    const { vp, pendingAck, orderId } = map({ productId: 'rootaroo.hh8', basePlanId: 'year', price: { currencyCode: 'USD', units: '175', nanos: 510_000_000 } });
    expect(vp).toMatchObject({
      provider: 'google', livemode: true, status: 'active', seats: 8, interval: 'year', householdId: HH, subscriptionId: 'tok-1',
      unitAmount: 17551, currency: 'usd', cancelAtPeriodEnd: false, productId: 'rootaroo.hh8.year',
    });
    expect(pendingAck).toBe(true);
    expect(orderId).toMatch(/^GPA\./);
  });

  it('also accepts product ids that already carry the interval', () => {
    expect(map({ productId: 'rootaroo.hh6.month', basePlanId: 'month' }).vp).toMatchObject({ seats: 6, interval: 'month', productId: 'rootaroo.hh6.month' });
  });

  it('a license-test purchase is livemode=false', () => {
    expect(map({ test: true }).vp.livemode).toBe(false);
    expect(map({ test: false }).vp.livemode).toBe(true);
  });

  it('autoRenewEnabled=false on an active subscription is cancel-at-period-end', () => {
    expect(map({ autoRenew: false }).vp).toMatchObject({ status: 'active', cancelAtPeriodEnd: true });
  });

  it('CANCELED keeps access until expiry, then is canceled', () => {
    expect(map({ state: 'SUBSCRIPTION_STATE_CANCELED', autoRenew: false }).vp).toMatchObject({ status: 'active', cancelAtPeriodEnd: true });
    const past = new Date(Date.now() - DAY);
    const gone = map({ state: 'SUBSCRIPTION_STATE_CANCELED', expiry: past }).vp;
    expect(gone.status).toBe('canceled');
    expect(gone.endedAt!.getTime()).toBe(past.getTime());
  });

  it('IN_GRACE_PERIOD is past_due until the store expiry; ON_HOLD gives no access', () => {
    const until = new Date(Date.now() + 5 * DAY);
    const grace = map({ state: 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD', expiry: until }).vp;
    expect(grace.status).toBe('past_due');
    expect(grace.graceUntil!.getTime()).toBe(until.getTime());
    expect(map({ state: 'SUBSCRIPTION_STATE_ON_HOLD' }).vp).toMatchObject({ status: 'unpaid', graceUntil: null });
  });

  it('PAUSED, PENDING, PENDING_PURCHASE_CANCELED and EXPIRED map to non-entitling statuses', () => {
    expect(map({ state: 'SUBSCRIPTION_STATE_PAUSED' }).vp.status).toBe('paused');
    expect(map({ state: 'SUBSCRIPTION_STATE_PENDING' }).vp.status).toBe('incomplete');
    expect(map({ state: 'SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED' }).vp.status).toBe('incomplete_expired');
    expect(map({ state: 'SUBSCRIPTION_STATE_EXPIRED', expiry: new Date(Date.now() - DAY) }).vp.status).toBe('canceled');
    expect(map({ state: 'SUBSCRIPTION_STATE_SOMETHING_NEW' }).vp.status).toBe('incomplete');
  });

  it('a voided purchase (refund, chargeback, revoke) is canceled whatever the state says', () => {
    expect(map({}, { voided: true }).vp).toMatchObject({ status: 'canceled', cancelAtPeriodEnd: false });
  });

  it('a deferred product replacement is a pending plan change; linkedPurchaseToken marks the replaced purchase', () => {
    const { vp } = map({ productId: 'rootaroo.hh6', deferredTo: 'rootaroo.hh5', linked: 'old-token' });
    expect(vp.pendingUpdate).toEqual({ productId: 'rootaroo.hh5', seats: 5, interval: 'month' });
    expect(vp.replaces).toBe('old-token');
  });

  it('an unknown product has null seats; an untagged purchase has no household', () => {
    const { vp } = map({ productId: 'com.other.sub', householdId: null });
    expect(vp.seats).toBeNull();
    expect(vp.householdId).toBeNull();
  });

  it('acknowledged purchases need no acknowledge', () => {
    expect(map({ ack: true }).pendingAck).toBe(false);
  });

  it('converts Money to cents', () => {
    expect(priceToCents({ units: '8', nanos: 990_000_000 })).toBe(899);
    expect(priceToCents(undefined)).toBeNull();
  });
});
