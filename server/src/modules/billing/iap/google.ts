import { GoogleAuth, OAuth2Client } from 'google-auth-library';
import { getBillingConfig } from '../config';
import { getIapConfig, requireGoogleConfig } from './config';
import type { VerifiedPurchase } from './types';
import { normalizeHouseholdId, parseProductId } from './types';

export class GoogleAuthError extends Error {}
export class GoogleNotFoundError extends Error {}

// ---------- Pub/Sub push authentication ----------

const oauth = new OAuth2Client();

/**
 * The push subscription is configured with OIDC auth: Google signs a JWT whose audience is our endpoint URL
 * (GOOGLE_PLAY_RTDN_AUDIENCE) and whose email is the push service account (GOOGLE_PLAY_RTDN_SA_EMAIL).
 * verifyIdToken checks the signature against Google's published certs, expiry, issuer and audience.
 */
export async function verifyPushAuthorization(authorization: string | undefined): Promise<void> {
  const cfg = requireGoogleConfig();
  const m = /^Bearer\s+(\S+)$/i.exec(authorization ?? '');
  if (!m) throw new GoogleAuthError('missing bearer token');
  let payload;
  try {
    payload = (await oauth.verifyIdToken({ idToken: m[1], audience: cfg.rtdnAudience })).getPayload();
  } catch (err) {
    throw new GoogleAuthError(`invalid token: ${(err as Error).message}`);
  }
  if (!payload || payload.email !== cfg.rtdnServiceAccountEmail || payload.email_verified !== true) {
    throw new GoogleAuthError('token is not from the configured push service account');
  }
}

// ---------- Play Developer API ----------

const PLAY = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';

export interface PlayRequest { method: 'GET' | 'POST'; url: string; data?: unknown }
export type PlayHttp = (req: PlayRequest) => Promise<{ status: number; data: unknown }>;
let httpOverride: PlayHttp | null = null;
let auth: GoogleAuth | null = null;

export function __setPlayHttpForTests(fn: PlayHttp | null): void {
  httpOverride = fn;
  auth = null;
}

export function playApiAvailable(): boolean {
  return httpOverride !== null || getIapConfig().google !== null;
}

async function playRequest(req: PlayRequest): Promise<{ status: number; data: unknown }> {
  if (httpOverride) return httpOverride(req);
  const cfg = requireGoogleConfig();
  auth ??= new GoogleAuth({ credentials: JSON.parse(cfg.serviceAccountJson), scopes: ['https://www.googleapis.com/auth/androidpublisher'] });
  try {
    const res = await auth.request({ url: req.url, method: req.method, data: req.data, timeout: 20_000 });
    return { status: res.status, data: res.data };
  } catch (err) {
    const status = (err as { response?: { status?: number } }).response?.status;
    if (status === 404 || status === 410) throw new GoogleNotFoundError(`Play API ${status}`);
    throw err;
  }
}

export interface PlaySubscriptionV2 {
  startTime?: string;
  regionCode?: string;
  latestOrderId?: string;
  linkedPurchaseToken?: string;
  subscriptionState?: string;
  acknowledgementState?: string;
  testPurchase?: Record<string, unknown>;
  externalAccountIdentifiers?: { externalAccountId?: string; obfuscatedExternalAccountId?: string; obfuscatedExternalProfileId?: string };
  canceledStateContext?: Record<string, { cancelTime?: string } | undefined>;
  lineItems?: Array<{
    productId?: string;
    expiryTime?: string;
    latestSuccessfulOrderId?: string;
    autoRenewingPlan?: { autoRenewEnabled?: boolean; recurringPrice?: { currencyCode?: string; units?: string; nanos?: number } };
    offerDetails?: { basePlanId?: string; offerId?: string };
    deferredItemReplacement?: { productId?: string };
  }>;
}

export interface GoogleSubscription { vp: VerifiedPurchase; raw: PlaySubscriptionV2; orderId: string | null; pendingAck: boolean }

export async function fetchPlaySubscription(purchaseToken: string): Promise<PlaySubscriptionV2> {
  const { packageName } = requireGoogleConfig();
  const res = await playRequest({ method: 'GET', url: `${PLAY}/${encodeURIComponent(packageName)}/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}` });
  return res.data as PlaySubscriptionV2;
}

/** Acknowledge within 3 days or Google refunds the purchase. Idempotent on Google's side. */
export async function acknowledgePlaySubscription(subscriptionId: string, purchaseToken: string): Promise<void> {
  const { packageName } = requireGoogleConfig();
  await playRequest({
    method: 'POST', data: {},
    url: `${PLAY}/${encodeURIComponent(packageName)}/purchases/subscriptions/${encodeURIComponent(subscriptionId)}/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`,
  });
}

// ---------- mapping ----------

const toDate = (iso: string | undefined | null): Date | null => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
};

export function priceToCents(p: { units?: string; nanos?: number } | undefined): number | null {
  if (!p) return null;
  return Math.round((Number(p.units ?? 0) + (p.nanos ?? 0) / 1e9) * 100);
}

/** The decision table for subscriptionsv2 states. `voided` forces a revoked/refunded purchase to canceled. */
export function mapGoogleToPurchase(raw: PlaySubscriptionV2, purchaseToken: string, opts: { voided?: boolean; now?: Date } = {}): GoogleSubscription {
  const now = opts.now ?? new Date();
  const item = raw.lineItems?.[0];
  const expires = toDate(item?.expiryTime);
  const state = raw.subscriptionState ?? '';

  let status: VerifiedPurchase['status'];
  let graceUntil: Date | null = null;
  let endedAt: Date | null = null;
  let cancelAtPeriodEnd = false;
  if (opts.voided) {
    status = 'canceled';
    endedAt = now;
  } else {
    switch (state) {
      case 'SUBSCRIPTION_STATE_ACTIVE':
        status = 'active';
        cancelAtPeriodEnd = item?.autoRenewingPlan?.autoRenewEnabled === false;
        break;
      case 'SUBSCRIPTION_STATE_CANCELED':
        // Canceled by the user but paid through the current period: access stays until expiry.
        if (expires && expires.getTime() > now.getTime()) { status = 'active'; cancelAtPeriodEnd = true; } else { status = 'canceled'; endedAt = expires ?? now; }
        break;
      case 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD':
        status = 'past_due';
        graceUntil = expires && expires.getTime() > now.getTime() ? expires : expires ? new Date(expires.getTime() + getBillingConfig().graceDays * 86400_000) : null;
        break;
      case 'SUBSCRIPTION_STATE_ON_HOLD':
        status = 'unpaid';
        break;
      case 'SUBSCRIPTION_STATE_PAUSED':
        status = 'paused';
        break;
      case 'SUBSCRIPTION_STATE_EXPIRED':
        status = 'canceled';
        endedAt = expires ?? now;
        break;
      case 'SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED':
        status = 'incomplete_expired';
        break;
      default: // SUBSCRIPTION_STATE_PENDING and anything unknown: no access until Google says ACTIVE
        status = 'incomplete';
    }
  }

  const basePlanId = item?.offerDetails?.basePlanId;
  const productId = item?.productId ?? '';
  const parsed = parseProductId(productId, basePlanId);
  const next = item?.deferredItemReplacement?.productId;
  const nextPlan = next ? parseProductId(next, basePlanId) : null;
  const price = item?.autoRenewingPlan?.recurringPrice;
  const cancelCtx = raw.canceledStateContext ? Object.values(raw.canceledStateContext).find((c) => c?.cancelTime) : undefined;

  const vp: VerifiedPurchase = {
    provider: 'google',
    livemode: !raw.testPurchase,
    productId: basePlanId && !/\.(month|year)$/.test(productId) ? `${productId}.${basePlanId}` : productId,
    seats: parsed?.seats ?? null,
    interval: parsed?.interval ?? 'month',
    subscriptionId: purchaseToken,
    status,
    currentPeriodStart: null,
    expiresAt: expires,
    cancelAtPeriodEnd,
    canceledAt: opts.voided ? now : toDate(cancelCtx?.cancelTime),
    endedAt,
    graceUntil,
    pendingUpdate: nextPlan ? { productId: next, seats: nextPlan.seats, interval: nextPlan.interval } : null,
    householdId: normalizeHouseholdId(raw.externalAccountIdentifiers?.obfuscatedExternalAccountId),
    unitAmount: priceToCents(price),
    currency: price?.currencyCode ? price.currencyCode.toLowerCase() : null,
    replaces: raw.linkedPurchaseToken ?? null,
  };
  return {
    vp, raw,
    orderId: item?.latestSuccessfulOrderId ?? raw.latestOrderId ?? null,
    pendingAck: raw.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_PENDING',
  };
}

export async function fetchGoogleSubscription(purchaseToken: string, opts: { voided?: boolean } = {}): Promise<GoogleSubscription> {
  return mapGoogleToPurchase(await fetchPlaySubscription(purchaseToken), purchaseToken, opts);
}

/** Subscription id for the acknowledge call (the Play product, not our `.month` suffixed key). */
export function playSubscriptionId(raw: PlaySubscriptionV2): string | null {
  return raw.lineItems?.[0]?.productId ?? null;
}
