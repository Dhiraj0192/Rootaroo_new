export type BillingMode = 'test' | 'live';
export type BillingCohort = 'live' | 'test';
export type BillingInterval = 'month' | 'year';
export type BillingProvider = 'stripe' | 'apple' | 'google';
export type SubscriptionStatus =
  | 'incomplete' | 'incomplete_expired' | 'trialing' | 'active'
  | 'past_due' | 'unpaid' | 'canceled' | 'paused';

/** Statuses that can grant access (past_due only while in grace). */
export const ALLOWED_STATUSES: readonly SubscriptionStatus[] = ['active', 'trialing', 'past_due'];

export type EntitlementReason = 'test_cohort' | 'active' | 'grace' | 'subscription_required';

export interface EntitlementSubscription {
  id: string;
  provider: BillingProvider;
  status: SubscriptionStatus;
  seats: number;
  interval: BillingInterval;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

export interface Entitlement {
  allowed: boolean;
  reason: EntitlementReason;
  mode: BillingMode;
  subscription: EntitlementSubscription | null;
  graceUntil: string | null;
  seatsAllowed: number;
}

export type PurchaseMethod = 'stripe_checkout' | 'apple_iap' | 'google_play' | 'none';
export type ClientPlatform = 'ios' | 'android' | 'web';
export interface ClientContext { platform: ClientPlatform; country: string }

export type CheckoutState = 'open' | 'processing' | 'complete' | 'expired';
export interface PendingCheckout { sessionId: string; state: CheckoutState }
