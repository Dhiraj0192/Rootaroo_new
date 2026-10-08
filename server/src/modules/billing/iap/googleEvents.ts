import { BillingEvent } from '../../../database/models';
import logger from '../../../shared/utils/logger';
import { notifyHouseholdAdmins } from '../notify';
import { raiseReviewItem } from '../review';
import { registerProviderDispatcher } from '../worker';
import {
  acknowledgePlaySubscription, fetchGoogleSubscription, GoogleNotFoundError, GoogleSubscription, playSubscriptionId,
} from './google';
import { recordStoreTransaction, upsertStoreSubscription } from './store';

/** RTDN SubscriptionNotification types (https://developer.android.com/google/play/billing/rtdn-reference). */
export const GOOGLE_NOTIFICATION_NAMES: Record<number, string> = {
  1: 'SUBSCRIPTION_RECOVERED', 2: 'SUBSCRIPTION_RENEWED', 3: 'SUBSCRIPTION_CANCELED', 4: 'SUBSCRIPTION_PURCHASED', 5: 'SUBSCRIPTION_ON_HOLD',
  6: 'SUBSCRIPTION_IN_GRACE_PERIOD', 7: 'SUBSCRIPTION_RESTARTED', 8: 'SUBSCRIPTION_PRICE_CHANGE_CONFIRMED', 9: 'SUBSCRIPTION_DEFERRED',
  10: 'SUBSCRIPTION_PAUSED', 11: 'SUBSCRIPTION_PAUSE_SCHEDULE_CHANGED', 12: 'SUBSCRIPTION_REVOKED', 13: 'SUBSCRIPTION_EXPIRED',
  17: 'SUBSCRIPTION_ITEMS_CHANGED', 18: 'SUBSCRIPTION_CANCELLATION_SCHEDULED', 19: 'SUBSCRIPTION_PRICE_CHANGE_UPDATED',
  20: 'SUBSCRIPTION_PENDING_PURCHASE_CANCELED', 22: 'SUBSCRIPTION_PRICE_STEP_UP_CONSENT_UPDATED',
};

/** A new paid period was charged. */
const PAYS = new Set([1, 2, 4, 7]);
/** Charge failed; the store is retrying. */
const FAILS = new Set([5, 6]);

export interface DeveloperNotification {
  version?: string;
  packageName?: string;
  eventTimeMillis?: string | number;
  subscriptionNotification?: { version?: string; notificationType: number; purchaseToken: string; subscriptionId?: string };
  voidedPurchaseNotification?: { purchaseToken: string; orderId: string; productType: number; refundType?: number };
  oneTimeProductNotification?: unknown;
  pendingRefundReviewNotification?: unknown;
  testNotification?: { version?: string };
}

export interface StoredGoogleEvent { notification: DeveloperNotification; publishTime?: string }

export function googleEventType(n: DeveloperNotification): string {
  if (n.subscriptionNotification) return GOOGLE_NOTIFICATION_NAMES[n.subscriptionNotification.notificationType] ?? `SUBSCRIPTION_${n.subscriptionNotification.notificationType}`;
  if (n.voidedPurchaseNotification) return 'VOIDED_PURCHASE';
  if (n.testNotification) return 'TEST';
  if (n.oneTimeProductNotification) return 'ONE_TIME_PRODUCT';
  if (n.pendingRefundReviewNotification) return 'PENDING_REFUND_REVIEW';
  return 'UNKNOWN';
}

/** Acknowledge a freshly purchased subscription once it grants access. Failure is a review item, never a lost purchase. */
export async function acknowledgeIfNeeded(g: GoogleSubscription, purchaseToken: string): Promise<boolean> {
  if (!g.pendingAck || !['active', 'past_due'].includes(g.vp.status)) return false;
  const productId = playSubscriptionId(g.raw);
  if (!productId) return false;
  try {
    await acknowledgePlaySubscription(productId, purchaseToken);
    return true;
  } catch (err) {
    logger.error(`[IAP] Play acknowledge failed for ${productId}: ${(err as Error).message}`);
    await raiseReviewItem({
      livemode: g.vp.livemode, kind: 'google_ack_failed', entityType: 'subscription', providerObjectId: purchaseToken,
      after: { productId, error: (err as Error).message },
    });
    return false;
  }
}

async function applyGoogle(row: BillingEvent, g: GoogleSubscription, token: string, type: number | 'void', eventSec: number | undefined) {
  if (row.livemode !== g.vp.livemode) await row.update({ livemode: g.vp.livemode }); // unknown at receipt: testPurchase is only visible in the Play API
  const res = await upsertStoreSubscription(g.vp, { eventCreated: eventSec });
  if (res.outcome !== 'applied') return null;
  const sub = res.row;
  const at = new Date(eventSec ? eventSec * 1000 : Date.now());
  const base = { row: sub, amount: g.vp.unitAmount, currency: g.vp.currency, at, eventId: row.providerEventId };

  if (type !== 'void' && PAYS.has(type) && g.orderId) {
    await recordStoreTransaction({ ...base, type: 'payment', objectId: g.orderId, status: 'paid', reason: type === 4 ? 'subscription_create' : 'subscription_cycle' });
  } else if (type !== 'void' && FAILS.has(type) && g.orderId) {
    await recordStoreTransaction({ ...base, type: 'failed_payment', objectId: `${g.orderId}:retry`, status: 'failed', reason: 'subscription_cycle' });
    if (row.attempts === 0) {
      await notifyHouseholdAdmins(sub.householdId, 'billing_payment_failed', 'Your Rootaroo payment failed',
        'Google Play could not renew your subscription. Update your payment method in Google Play (Payments & subscriptions) to keep access.',
        { type: 'billing_payment_failed' });
    }
  }
  await acknowledgeIfNeeded(g, token);
  return sub;
}

/** Task 11.3: process one persisted RTDN. The notification only says "look again"; the Play API is the truth. */
export async function processGoogleEvent(row: BillingEvent): Promise<'processed' | 'ignored'> {
  const { notification: n } = row.payload as unknown as StoredGoogleEvent;
  const eventSec = n.eventTimeMillis !== undefined ? Math.floor(Number(n.eventTimeMillis) / 1000) : undefined;

  if (n.subscriptionNotification) {
    const { purchaseToken, notificationType } = n.subscriptionNotification;
    let g: GoogleSubscription;
    try {
      g = await fetchGoogleSubscription(purchaseToken);
    } catch (err) {
      if (err instanceof GoogleNotFoundError) {
        // Purchase tokens are retained for 60 days after expiry; an unknown one is not ours to guess about.
        await raiseReviewItem({ livemode: row.livemode, kind: 'missing_in_store', entityType: 'subscription', providerObjectId: purchaseToken, after: { type: notificationType } });
        return 'processed';
      }
      throw err; // transient: the worker retries with backoff
    }
    await applyGoogle(row, g, purchaseToken, notificationType, eventSec);
    return 'processed';
  }

  if (n.voidedPurchaseNotification) {
    const v = n.voidedPurchaseNotification;
    if (v.productType !== 1) return 'ignored'; // one-time products: we sell none
    const g = await fetchGoogleSubscription(v.purchaseToken, { voided: true });
    const sub = await applyGoogle(row, g, v.purchaseToken, 'void', eventSec);
    if (sub) {
      await recordStoreTransaction({
        row: sub, type: 'refund', objectId: v.orderId, amount: g.vp.unitAmount, currency: g.vp.currency,
        at: new Date(eventSec ? eventSec * 1000 : Date.now()), status: 'succeeded', reason: v.refundType === 2 ? 'partial_refund' : 'refund', eventId: row.providerEventId,
      });
    }
    return 'processed';
  }
  return 'ignored'; // test, one-time product and pending-refund-review notifications
}

export function registerGoogleDispatcher(): void {
  registerProviderDispatcher('google', processGoogleEvent);
}
