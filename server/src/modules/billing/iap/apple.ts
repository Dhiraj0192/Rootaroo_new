import { X509Certificate } from 'crypto';
import {
  AppStoreServerAPIClient, APIException, Environment, JWSRenewalInfoDecodedPayload, JWSTransactionDecodedPayload,
  ResponseBodyV2DecodedPayload, SignedDataVerifier, Status, VerificationException, VerificationStatus,
} from '@apple/app-store-server-library';
import { getBillingConfig } from '../config';
import { APPLE_ROOT_CA_G3_PEM } from './appleRootCaG3';
import { requireAppleConfig, getIapConfig } from './config';
import type { VerifiedPurchase } from './types';
import { normalizeHouseholdId, parseProductId } from './types';

export class AppleVerificationError extends Error {
  constructor(message: string, public retryable = false) {
    super(message);
  }
}

export type AppleEnvironment = 'Sandbox' | 'Production';

// ---------- verification ----------

let rootOverride: Buffer[] | null = null;
const verifiers = new Map<AppleEnvironment, SignedDataVerifier>();

/** Test hook: trust a self-signed test root instead of Apple Root CA G3. */
export function __setAppleRootsForTests(roots: Buffer[] | null): void {
  rootOverride = roots;
  verifiers.clear();
}

function trustedRoots(): Buffer[] {
  return rootOverride ?? [new X509Certificate(APPLE_ROOT_CA_G3_PEM).raw];
}

function verifierFor(env: AppleEnvironment): SignedDataVerifier {
  const existing = verifiers.get(env);
  if (existing) return existing;
  const cfg = requireAppleConfig();
  if (env === 'Production' && !cfg.appAppleId) throw new AppleVerificationError('APPLE_APP_APPLE_ID is not configured, so Production data cannot be verified');
  const v = new SignedDataVerifier(
    trustedRoots(), getIapConfig().appleOnlineChecks,
    env === 'Production' ? Environment.PRODUCTION : Environment.SANDBOX,
    cfg.bundleId, cfg.appAppleId ?? undefined,
  );
  verifiers.set(env, v);
  return v;
}

/** Reads the (unverified) payload only to pick the matching verifier; the verifier then checks signature, chain and environment. */
export function peekPayload(jws: string): Record<string, unknown> {
  const parts = typeof jws === 'string' ? jws.split('.') : [];
  if (parts.length !== 3) throw new AppleVerificationError('not a JWS');
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new AppleVerificationError('JWS payload is not JSON');
  }
}

function environmentOf(payload: Record<string, unknown>): AppleEnvironment {
  const data = (payload.data ?? payload.summary ?? payload) as { environment?: string };
  if (data.environment === 'Sandbox' || data.environment === 'Production') return data.environment;
  throw new AppleVerificationError('unsupported App Store environment');
}

export function livemodeOfEnvironment(env: AppleEnvironment): boolean {
  return env === 'Production';
}

function wrap(err: unknown): AppleVerificationError {
  if (err instanceof AppleVerificationError) return err;
  if (err instanceof VerificationException) {
    return new AppleVerificationError(`verification failed (${VerificationStatus[err.status] ?? err.status})`, err.status === VerificationStatus.RETRYABLE_VERIFICATION_FAILURE);
  }
  if (err instanceof Error && err.name !== 'Error') return new AppleVerificationError(err.message);
  return err instanceof Error ? new AppleVerificationError(err.message) : new AppleVerificationError('verification failed');
}

export interface VerifiedNotification {
  environment: AppleEnvironment;
  livemode: boolean;
  notification: ResponseBodyV2DecodedPayload;
  transaction: JWSTransactionDecodedPayload | null;
  renewal: JWSRenewalInfoDecodedPayload | null;
}

/** Chain (x5c) to Apple Root CA G3, leaf/intermediate OIDs, signature, bundle id and environment; then the nested JWS. */
export async function verifyNotification(signedPayload: string): Promise<VerifiedNotification> {
  try {
    const env = environmentOf(peekPayload(signedPayload));
    const verifier = verifierFor(env);
    const notification = await verifier.verifyAndDecodeNotification(signedPayload);
    const data = notification.data;
    const transaction = data?.signedTransactionInfo ? await verifier.verifyAndDecodeTransaction(data.signedTransactionInfo) : null;
    const renewal = data?.signedRenewalInfo ? await verifier.verifyAndDecodeRenewalInfo(data.signedRenewalInfo) : null;
    return { environment: env, livemode: livemodeOfEnvironment(env), notification, transaction, renewal };
  } catch (err) {
    throw wrap(err);
  }
}

export async function verifyTransaction(signedTransaction: string): Promise<{ transaction: JWSTransactionDecodedPayload; environment: AppleEnvironment }> {
  try {
    const env = environmentOf(peekPayload(signedTransaction));
    return { transaction: await verifierFor(env).verifyAndDecodeTransaction(signedTransaction), environment: env };
  } catch (err) {
    throw wrap(err);
  }
}

// ---------- mapping ----------

const toDate = (ms: number | undefined | null): Date | null => (typeof ms === 'number' ? new Date(ms) : null);

/** Apple reports prices in milliunits of the currency; minor units for the 2-decimal currencies we sell in are /10. */
export function priceToMinor(price: number | undefined): number | null {
  return typeof price === 'number' ? Math.round(price / 10) : null;
}

export interface MapInput {
  transaction: JWSTransactionDecodedPayload;
  renewal?: JWSRenewalInfoDecodedPayload | null;
  /** data.status from the notification or the Subscription Status API. */
  status?: number | null;
  notificationType?: string;
  subtype?: string;
  signedDate?: number;
  now?: Date;
}

const REVOKING = new Set(['REFUND', 'REVOKE']);

/** The decision table for how Apple's type/subtype/status become our status and grace. */
export function mapAppleToPurchase(input: MapInput): VerifiedPurchase {
  const { transaction: tx, renewal } = input;
  const now = input.now ?? new Date();
  const type = input.notificationType;
  const expires = toDate(tx.expiresDate);
  const revoked = toDate(tx.revocationDate);
  const graceExpiry = toDate(renewal?.gracePeriodExpiresDate);
  const fallbackGrace = expires ? new Date(expires.getTime() + getBillingConfig().graceDays * 86400_000) : null;

  let status: VerifiedPurchase['status'];
  let graceUntil: Date | null = null;
  let endedAt: Date | null = null;
  let canceledAt: Date | null = null;

  if (revoked || (type && REVOKING.has(type)) || input.status === Status.REVOKED) {
    status = 'canceled';
    endedAt = canceledAt = revoked ?? toDate(input.signedDate) ?? now;
  } else if (type === 'EXPIRED' || input.status === Status.EXPIRED) {
    status = 'canceled';
    endedAt = expires ?? now;
  } else if (type === 'GRACE_PERIOD_EXPIRED') {
    status = 'unpaid';
  } else if (type === 'DID_FAIL_TO_RENEW') {
    if (input.subtype === 'GRACE_PERIOD' || input.status === Status.BILLING_GRACE_PERIOD) {
      status = 'past_due';
      graceUntil = graceExpiry ?? fallbackGrace;
    } else {
      status = 'unpaid';
    }
  } else if (input.status === Status.BILLING_GRACE_PERIOD) {
    status = 'past_due';
    graceUntil = graceExpiry ?? fallbackGrace;
  } else if (input.status === Status.BILLING_RETRY) {
    status = 'unpaid';
  } else if (input.status == null && expires && expires.getTime() <= now.getTime()) {
    status = 'canceled';
    endedAt = expires;
  } else {
    status = 'active';
  }

  const parsed = parseProductId(tx.productId ?? '');
  const nextProduct = renewal?.autoRenewProductId;
  const nextPlan = nextProduct && nextProduct !== tx.productId ? parseProductId(nextProduct) : null;
  const autoRenewOff = renewal ? renewal.autoRenewStatus === 0 : false;

  return {
    provider: 'apple',
    livemode: tx.environment === 'Production',
    productId: tx.productId ?? '',
    seats: parsed?.seats ?? null,
    interval: parsed?.interval ?? 'month',
    subscriptionId: tx.originalTransactionId ?? tx.transactionId ?? '',
    status,
    currentPeriodStart: toDate(tx.purchaseDate),
    expiresAt: expires,
    cancelAtPeriodEnd: status === 'canceled' ? false : autoRenewOff,
    canceledAt,
    endedAt,
    graceUntil,
    pendingUpdate: nextPlan ? { productId: nextProduct, seats: nextPlan.seats, interval: nextPlan.interval } : null,
    householdId: normalizeHouseholdId(tx.appAccountToken),
    unitAmount: priceToMinor(tx.price),
    currency: tx.currency ? tx.currency.toLowerCase() : null,
  };
}

// ---------- App Store Server API ----------

type StatusApi = Pick<AppStoreServerAPIClient, 'getAllSubscriptionStatuses'>;
let clientFactory: ((env: AppleEnvironment) => StatusApi) | null = null;

export function __setAppleApiClientForTests(factory: ((env: AppleEnvironment) => StatusApi) | null): void {
  clientFactory = factory;
}

export function appleApiAvailable(): boolean {
  return clientFactory !== null || getIapConfig().apple !== null;
}

function apiClient(env: AppleEnvironment): StatusApi {
  if (clientFactory) return clientFactory(env);
  const c = requireAppleConfig();
  return new AppStoreServerAPIClient(c.privateKey, c.keyId, c.issuerId, c.bundleId, env === 'Production' ? Environment.PRODUCTION : Environment.SANDBOX);
}

export class AppleNotFoundError extends Error {}

/** getAllSubscriptionStatuses for the original transaction, verified and mapped. Used by reconciliation and the verify endpoint. */
export async function fetchAppleSubscription(originalTransactionId: string, livemode: boolean): Promise<VerifiedPurchase> {
  const env: AppleEnvironment = livemode ? 'Production' : 'Sandbox';
  let response;
  try {
    response = await apiClient(env).getAllSubscriptionStatuses(originalTransactionId);
  } catch (err) {
    if (err instanceof APIException && err.httpStatusCode === 404) throw new AppleNotFoundError(`Apple has no subscription ${originalTransactionId}`);
    throw err;
  }
  const items = (response.data ?? []).flatMap((g) => g.lastTransactions ?? []);
  const item = items.find((i) => i.originalTransactionId === originalTransactionId);
  if (!item?.signedTransactionInfo) throw new AppleNotFoundError(`Apple returned no status for ${originalTransactionId}`);
  const verifier = verifierFor(env);
  const transaction = await wrapAsync(() => verifier.verifyAndDecodeTransaction(item.signedTransactionInfo!));
  const renewal = item.signedRenewalInfo ? await wrapAsync(() => verifier.verifyAndDecodeRenewalInfo(item.signedRenewalInfo!)) : null;
  return mapAppleToPurchase({ transaction, renewal, status: item.status ?? null });
}

async function wrapAsync<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw wrap(err);
  }
}
