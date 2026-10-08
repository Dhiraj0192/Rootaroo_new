import { AppError } from '../../../shared/utils/errors';
import { requireAdminContext } from '../context';
import { getEntitlement } from '../entitlement';
import { raiseReviewItem } from '../review';
import { acknowledgeIfNeeded } from './googleEvents';
import { fetchGoogleSubscription, GoogleNotFoundError } from './google';
import { requireGoogleConfig } from './config';
import { recordStoreTransaction, upsertStoreSubscription } from './store';
import { mismatch, VerifyResult } from './appleVerify';
import { parseProductId } from './types';

/**
 * POST /billing/iap/google/verify (household admin only). The purchase token comes from the device, so the Play
 * API is asked about it (service account); obfuscatedExternalAccountId must be this household's id. Entitlement
 * is stored before the acknowledge, so a failed acknowledge never costs the customer their access.
 */
export async function verifyGooglePurchase(userId: string, body: { purchaseToken: string; productId: string }): Promise<VerifyResult> {
  requireGoogleConfig();
  const ctx = await requireAdminContext(userId);

  let g;
  try {
    g = await fetchGoogleSubscription(body.purchaseToken);
  } catch (err) {
    if (err instanceof GoogleNotFoundError) throw new AppError(400, 'The purchase could not be verified', 'IAP_VERIFICATION_FAILED');
    throw new AppError(503, 'The purchase could not be verified right now', 'IAP_VERIFICATION_UNAVAILABLE');
  }
  const lineProduct = g.raw.lineItems?.[0]?.productId;
  if (!lineProduct || (body.productId !== lineProduct && body.productId !== g.vp.productId) || !parseProductId(g.vp.productId)) {
    throw new AppError(400, 'Unknown or mismatched product', 'IAP_UNKNOWN_PRODUCT');
  }
  if (g.vp.householdId !== ctx.household.id.toLowerCase()) throw mismatch();

  const res = await upsertStoreSubscription(g.vp, { purchasedByUserId: userId, expectedHouseholdId: ctx.household.id });
  if (res.outcome === 'household_mismatch') throw mismatch();
  if (res.outcome === 'unmatched') throw new AppError(404, 'Household not found', 'NOT_FOUND');
  if (res.row.status === 'active' && g.orderId) {
    await recordStoreTransaction({
      row: res.row, type: 'payment', objectId: g.orderId, amount: g.vp.unitAmount, currency: g.vp.currency,
      at: new Date(), status: 'paid', reason: 'subscription_create', eventId: null,
    });
  }
  const acked = await acknowledgeIfNeeded(g, body.purchaseToken);
  if (g.pendingAck && !acked && g.vp.status === 'active') {
    // acknowledgeIfNeeded already raised google_ack_failed; the RTDN retry and reconciliation acknowledge again.
    await raiseReviewItem({ livemode: g.vp.livemode, kind: 'google_ack_pending', entityType: 'subscription', providerObjectId: body.purchaseToken });
  }
  return { entitlement: await getEntitlement(ctx.household.id, { bypassCache: true }) };
}
