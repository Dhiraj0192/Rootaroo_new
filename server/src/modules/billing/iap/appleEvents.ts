import type { JWSRenewalInfoDecodedPayload, JWSTransactionDecodedPayload, ResponseBodyV2DecodedPayload } from '@apple/app-store-server-library';
import { BillingEvent, BillingTransaction } from '../../../database/models';
import { notifyHouseholdAdmins } from '../notify';
import { registerProviderDispatcher } from '../worker';
import { mapAppleToPurchase, priceToMinor } from './apple';
import { recordStoreTransaction, upsertStoreSubscription } from './store';

export interface StoredAppleEvent {
  notification: ResponseBodyV2DecodedPayload;
  transaction: JWSTransactionDecodedPayload | null;
  renewal: JWSRenewalInfoDecodedPayload | null;
}

/** Notification types with nothing to apply to a subscription row. */
const IGNORED = new Set([
  'TEST', 'CONSUMPTION_REQUEST', 'REFUND_DECLINED', 'ONE_TIME_CHARGE', 'EXTERNAL_PURCHASE_TOKEN', 'RESCIND_CONSENT', 'METADATA_UPDATE', 'MIGRATION',
]);
/** A new paid period was charged. */
const PAYS = new Set(['SUBSCRIBED', 'DID_RENEW', 'OFFER_REDEEMED']);

export function appleEventType(n: ResponseBodyV2DecodedPayload): string {
  return n.subtype ? `${n.notificationType}.${n.subtype}` : String(n.notificationType);
}

/** Task 11.2: apply one verified, persisted App Store Server Notification V2 through the shared store path. */
export async function processAppleEvent(row: BillingEvent): Promise<'processed' | 'ignored'> {
  const { notification, transaction, renewal } = row.payload as unknown as StoredAppleEvent;
  const type = String(notification.notificationType);
  if (IGNORED.has(type) || !transaction) return 'ignored';

  const vp = mapAppleToPurchase({
    transaction, renewal, status: notification.data?.status ?? null, notificationType: type,
    subtype: notification.subtype ? String(notification.subtype) : undefined, signedDate: notification.signedDate,
  });
  const signedSec = typeof notification.signedDate === 'number' ? Math.floor(notification.signedDate / 1000) : undefined;
  const res = await upsertStoreSubscription(vp, { eventCreated: signedSec });
  if (res.outcome !== 'applied') return 'processed'; // stale, unmatched or mismatched: review items already raised

  const sub = res.row;
  const at = new Date(notification.signedDate ?? Date.now());
  const txId = transaction.transactionId ?? vp.subscriptionId;
  const amount = priceToMinor(transaction.price);
  const base = { row: sub, amount, currency: vp.currency, at, eventId: row.providerEventId };

  if (PAYS.has(type)) {
    await recordStoreTransaction({
      ...base, type: 'payment', objectId: txId, status: 'paid', at: new Date(transaction.purchaseDate ?? at.getTime()),
      reason: type === 'SUBSCRIBED' ? 'subscription_create' : 'subscription_cycle',
    });
  } else if (type === 'REFUND' || type === 'REVOKE') {
    await recordStoreTransaction({ ...base, type: 'refund', objectId: txId, status: 'succeeded', reason: type.toLowerCase() });
  } else if (type === 'REFUND_REVERSED') {
    await BillingTransaction.update({ status: 'reversed', lastEventId: row.providerEventId }, { where: { provider: 'apple', livemode: sub.livemode, type: 'refund', providerObjectId: txId } });
  } else if (type === 'DID_FAIL_TO_RENEW') {
    await recordStoreTransaction({ ...base, type: 'failed_payment', objectId: `${txId}:retry`, status: 'failed', reason: 'subscription_cycle' });
    if (row.attempts === 0) {
      await notifyHouseholdAdmins(sub.householdId, 'billing_payment_failed', 'Your Rootaroo payment failed',
        'Apple could not renew your subscription. Update your payment method in your Apple ID settings (Settings > your name > Subscriptions) to keep access.',
        { type: 'billing_payment_failed' });
    }
  }
  return 'processed';
}

export function registerAppleDispatcher(): void {
  registerProviderDispatcher('apple', processAppleEvent);
}
