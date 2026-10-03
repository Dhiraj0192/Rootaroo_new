import type { BillingInterval, SubscriptionStatus } from '../types';

export type StoreProvider = 'apple' | 'google';

/**
 * Spec section 16 / Task 11.1: what a store purchase looks like after the signature (Apple) or the Play API
 * (Google) has vouched for it. Everything past this type is provider-neutral and flows through upsertStoreSubscription.
 */
export interface VerifiedPurchase {
  provider: StoreProvider;
  /** Apple Sandbox / Google license-test purchases are livemode=false. */
  livemode: boolean;
  productId: string;
  /** null when the product ID is not one of ours (raises an unknown_price review item). */
  seats: number | null;
  interval: BillingInterval;
  /** Apple originalTransactionId, or the Google purchaseToken. This is billing_subscriptions.provider_subscription_id. */
  subscriptionId: string;
  status: SubscriptionStatus;
  currentPeriodStart: Date | null;
  /** Store expiry of the paid period; becomes current_period_end. */
  expiresAt: Date | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: Date | null;
  endedAt: Date | null;
  /** Store-provided billing-grace expiry; only meaningful while status is past_due. */
  graceUntil: Date | null;
  /** A scheduled plan change (Apple downgrade, Google deferred change). */
  pendingUpdate: Record<string, unknown> | null;
  /** From appAccountToken (Apple) or obfuscatedExternalAccountId (Google). Null when the purchase was not tagged. */
  householdId: string | null;
  /** Google: the purchase token this one replaced (upgrade/downgrade). The old row is retired in the same write. */
  replaces?: string | null;
  /** Price in minor units (cents) and ISO currency, when the store reports it. */
  unitAmount: number | null;
  currency: string | null;
}

/** Product IDs are rootaroo.hh{5..10}.{month|year}. Google may use rootaroo.hh{N} with the base plan carrying the interval. */
const PRODUCT = /^rootaroo\.hh(10|[5-9])(?:\.(month|year))?$/;

export function parseProductId(productId: string, basePlanId?: string | null): { seats: number; interval: BillingInterval } | null {
  const m = PRODUCT.exec(productId);
  if (!m) return null;
  const seats = Number(m[1]);
  if (!Number.isInteger(seats) || seats < 5 || seats > 10) return null;
  const interval = (m[2] ?? basePlanId) as string | undefined | null;
  if (interval !== 'month' && interval !== 'year') return null;
  return { seats, interval };
}

export function productIdFor(seats: number, interval: BillingInterval): string {
  return `rootaroo.hh${seats}.${interval}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Household IDs are UUIDs; the stores echo them back in either case. */
export function normalizeHouseholdId(v: string | null | undefined): string | null {
  return typeof v === 'string' && UUID.test(v) ? v.toLowerCase() : null;
}
