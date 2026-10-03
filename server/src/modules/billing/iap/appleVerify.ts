import { AppError } from '../../../shared/utils/errors';
import logger from '../../../shared/utils/logger';
import { requireAdminContext } from '../context';
import { getEntitlement } from '../entitlement';
import { BillingConflictError } from '../errors';
import type { Entitlement } from '../types';
import { AppleNotFoundError, AppleVerificationError, appleApiAvailable, fetchAppleSubscription, mapAppleToPurchase, verifyTransaction } from './apple';
import { requireAppleConfig } from './config';
import { recordStoreTransaction, upsertStoreSubscription } from './store';
import { normalizeHouseholdId, parseProductId } from './types';

export interface VerifyResult { entitlement: Entitlement }

export const mismatch = () => new BillingConflictError('PURCHASE_HOUSEHOLD_MISMATCH', 'This purchase belongs to a different household');

/**
 * POST /billing/iap/apple/verify (household admin only). The signedTransaction comes from the device, so it is
 * untrusted until the JWS chain verifies to Apple Root CA G3; the appAccountToken must be this household's id.
 */
export async function verifyAppleTransaction(userId: string, signedTransaction: string): Promise<VerifyResult> {
  requireAppleConfig();
  const ctx = await requireAdminContext(userId);

  let verified;
  try {
    verified = await verifyTransaction(signedTransaction);
  } catch (err) {
    if (err instanceof AppleVerificationError) {
      throw new AppError(err.retryable ? 503 : 400, 'The purchase could not be verified', err.retryable ? 'IAP_VERIFICATION_UNAVAILABLE' : 'IAP_VERIFICATION_FAILED');
    }
    throw err;
  }
  const { transaction } = verified;
  if (!parseProductId(transaction.productId ?? '')) throw new AppError(400, 'Unknown product', 'IAP_UNKNOWN_PRODUCT');
  if (normalizeHouseholdId(transaction.appAccountToken) !== ctx.household.id.toLowerCase()) throw mismatch();

  // Prefer Apple's own status (renewal state, billing retry); the device transaction alone cannot say whether it renews.
  let vp = mapAppleToPurchase({ transaction });
  if (appleApiAvailable() && transaction.originalTransactionId) {
    try {
      vp = await fetchAppleSubscription(transaction.originalTransactionId, vp.livemode);
    } catch (err) {
      if (!(err instanceof AppleNotFoundError)) logger.warn(`[IAP] Apple status lookup failed, using the signed transaction: ${(err as Error).message}`);
    }
  }

  const res = await upsertStoreSubscription(vp, { purchasedByUserId: userId, expectedHouseholdId: ctx.household.id });
  if (res.outcome === 'household_mismatch') throw mismatch();
  if (res.outcome === 'unmatched') throw new AppError(404, 'Household not found', 'NOT_FOUND');
  if (res.row && res.row.status === 'active' && transaction.transactionId) {
    await recordStoreTransaction({
      row: res.row, type: 'payment', objectId: transaction.transactionId, amount: vp.unitAmount, currency: vp.currency,
      at: new Date(transaction.purchaseDate ?? Date.now()), status: 'paid', reason: 'subscription_create', eventId: null,
    });
  }
  return { entitlement: await getEntitlement(ctx.household.id, { bypassCache: true }) };
}
