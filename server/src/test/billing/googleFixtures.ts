import crypto from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import type { PlaySubscriptionV2 } from '../../modules/billing/iap/google';
import type { DeveloperNotification } from '../../modules/billing/iap/googleEvents';

export const TEST_PACKAGE = 'com.rootaroo.app';
export const TEST_AUDIENCE = 'https://api.example.test/api/v1/billing/webhooks/google';
export const TEST_PUSH_SA = 'rtdn-push@rootaroo-test.iam.gserviceaccount.com';

const b64u = (o: unknown) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');

export interface OidcKey { privateKey: crypto.KeyObject; publicPem: string; kid: string }

export function makeOidcKey(kid = 'test-kid-1'): OidcKey {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { privateKey, publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(), kid };
}

/** Make OAuth2Client.verifyIdToken trust `key` instead of fetching Google's certificates. Returns a restore function. */
export function trustOidcKey(key: OidcKey): () => void {
  const spy = jest.spyOn(OAuth2Client.prototype, 'getFederatedSignonCertsAsync')
    .mockResolvedValue({ certs: { [key.kid]: key.publicPem }, format: "PEM" } as never);
  return () => spy.mockRestore();
}

/** A real RS256 JWT shaped like the token Pub/Sub attaches to push requests. */
export function oidcToken(key: OidcKey, claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u({ alg: 'RS256', typ: 'JWT', kid: key.kid, ...header });
  const body = b64u({
    iss: 'https://accounts.google.com', aud: TEST_AUDIENCE, azp: '1234567890', sub: '1234567890',
    email: TEST_PUSH_SA, email_verified: true, iat: now, exp: now + 3600, ...claims,
  });
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), key.privateKey);
  return `${head}.${body}.${sig.toString('base64url')}`;
}

let n = 0;

export function playSubscription(o: {
  productId?: string; basePlanId?: string; state?: string; expiry?: Date; householdId?: string | null; test?: boolean;
  autoRenew?: boolean; ack?: boolean; orderId?: string; linked?: string; deferredTo?: string; price?: { units: string; nanos?: number; currencyCode: string };
} = {}): PlaySubscriptionV2 {
  n += 1;
  return {
    startTime: new Date(Date.now() - 86400_000).toISOString(),
    regionCode: 'US',
    latestOrderId: o.orderId ?? `GPA.3300-0000-0000-${String(n).padStart(5, '0')}`,
    subscriptionState: o.state ?? 'SUBSCRIPTION_STATE_ACTIVE',
    acknowledgementState: o.ack ? 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED' : 'ACKNOWLEDGEMENT_STATE_PENDING',
    ...(o.test ? { testPurchase: {} } : {}),
    ...(o.linked ? { linkedPurchaseToken: o.linked } : {}),
    externalAccountIdentifiers: o.householdId === null ? {} : { obfuscatedExternalAccountId: o.householdId },
    lineItems: [{
      productId: o.productId ?? 'rootaroo.hh5',
      expiryTime: (o.expiry ?? new Date(Date.now() + 29 * 86400_000)).toISOString(),
      latestSuccessfulOrderId: o.orderId ?? `GPA.3300-0000-0000-${String(n).padStart(5, '0')}`,
      autoRenewingPlan: { autoRenewEnabled: o.autoRenew ?? true, recurringPrice: o.price ?? { currencyCode: 'USD', units: '8', nanos: 990_000_000 } },
      offerDetails: { basePlanId: o.basePlanId ?? 'month' },
      ...(o.deferredTo ? { deferredItemReplacement: { productId: o.deferredTo } } : {}),
    }],
  };
}

export function rtdn(partial: Partial<DeveloperNotification>): DeveloperNotification {
  return { version: '1.0', packageName: TEST_PACKAGE, eventTimeMillis: String(Date.now()), ...partial };
}

export const subscriptionNotification = (notificationType: number, purchaseToken: string) =>
  rtdn({ subscriptionNotification: { version: '1.0', notificationType, purchaseToken } });

/** The JSON body of a Pub/Sub push request. */
export function pubsubBody(notification: DeveloperNotification, messageId = `msg-${Math.random().toString(36).slice(2)}`): string {
  return JSON.stringify({
    message: { data: Buffer.from(JSON.stringify(notification)).toString('base64'), messageId, publishTime: new Date().toISOString() },
    subscription: 'projects/rootaroo-test/subscriptions/rtdn-push',
  });
}
