import { UniqueConstraintError } from 'sequelize';
import { BillingSubscription, Household, User } from '../../../database/models';
import { clearEntitlementCache } from '../entitlement';
import { resolveDuplicates } from '../duplicates';
import { upsertLedgerRow, linkSubscriptionRow } from '../ledger';
import { withLock } from '../locks';
import { modeFromLivemode } from '../mode';
import { raiseReviewItem } from '../review';
import { amountFor, LAUNCH_FORMULA } from '../catalog';
import type { VerifiedPurchase } from './types';
import { normalizeHouseholdId } from './types';

export interface StoreUpsertOptions {
  /** Seconds. Notifications carry the store's signed date; a notification older than the row's watermark is skipped. */
  eventCreated?: number;
  skipDuplicates?: boolean;
  /** The household admin who completed the purchase in the app (verify endpoint only). */
  purchasedByUserId?: string;
  /** When the call comes from the verify endpoint, a household mismatch is an error for the caller, not just a review item. */
  expectedHouseholdId?: string;
}

export type StoreUpsertResult =
  | { outcome: 'applied'; row: BillingSubscription }
  | { outcome: 'stale'; row: BillingSubscription }
  | { outcome: 'unmatched'; row: null }
  | { outcome: 'household_mismatch'; row: null };

async function validPurchaser(userId: string | undefined): Promise<string | null> {
  if (!userId) return null;
  const user = await User.findByPk(userId, { paranoid: false, attributes: ['id'] });
  return user ? user.id : null;
}

/**
 * Task 11.1: the store counterpart of upsertSubscription and, like it, the only writer of store subscription
 * rows. Entitlement, grace, duplicates (review-only for stores) and the review queue are the shared code paths.
 */
export async function upsertStoreSubscription(vp: VerifiedPurchase, opts: StoreUpsertOptions = {}): Promise<StoreUpsertResult> {
  const result = await withLock(`billing:sub:${vp.provider}:${vp.subscriptionId}`, 30_000, async (): Promise<StoreUpsertResult> => {
    const where = { provider: vp.provider, livemode: vp.livemode, providerSubscriptionId: vp.subscriptionId } as const;
    const existing = await BillingSubscription.findOne({ where });

    const taggedHousehold = normalizeHouseholdId(vp.householdId);
    // A row that exists is the authority on who owns the subscription; a purchase can never be moved between households.
    if (existing && taggedHousehold && existing.householdId !== taggedHousehold) {
      await raiseReviewItem({
        livemode: vp.livemode, kind: 'store_household_mismatch', entityType: 'subscription', entityId: existing.id,
        providerObjectId: vp.subscriptionId, after: { provider: vp.provider, tagged: taggedHousehold, owner: existing.householdId },
      });
      return { outcome: 'household_mismatch', row: null };
    }
    const householdId = existing?.householdId ?? taggedHousehold;
    const household = householdId ? await Household.findByPk(householdId, { paranoid: false, attributes: ['id'] }) : null;
    if (!household) {
      await raiseReviewItem({
        livemode: vp.livemode, kind: 'unmatched_subscription', entityType: 'subscription', providerObjectId: vp.subscriptionId,
        after: { provider: vp.provider, productId: vp.productId, tagged: vp.householdId },
      });
      return { outcome: 'unmatched', row: null };
    }
    if (opts.expectedHouseholdId && opts.expectedHouseholdId.toLowerCase() !== household.id.toLowerCase()) {
      return { outcome: 'household_mismatch', row: null };
    }

    if (existing && opts.eventCreated !== undefined && existing.eventWatermark !== null && opts.eventCreated < Number(existing.eventWatermark)) {
      return { outcome: 'stale', row: existing };
    }

    if (vp.replaces) {
      const old = await BillingSubscription.findOne({ where: { provider: vp.provider, livemode: vp.livemode, providerSubscriptionId: vp.replaces, householdId: household.id } });
      if (old && old.status !== 'canceled') await old.update({ status: 'canceled', endedAt: new Date(), graceUntil: null, cancelAtPeriodEnd: false, lastSyncedAt: new Date() });
    }

    if (vp.seats === null) {
      await raiseReviewItem({ livemode: vp.livemode, kind: 'unknown_price', entityType: 'subscription', providerObjectId: vp.subscriptionId, after: { productId: vp.productId } });
    }

    const fields = {
      householdId: household.id,
      status: vp.status,
      interval: vp.interval,
      seats: vp.seats ?? existing?.seats ?? 5,
      priceId: vp.productId,
      priceSet: null,
      unitAmount: vp.unitAmount,
      currency: vp.currency,
      currentPeriodStart: vp.currentPeriodStart,
      currentPeriodEnd: vp.expiresAt,
      cancelAtPeriodEnd: vp.cancelAtPeriodEnd,
      canceledAt: vp.canceledAt,
      endedAt: vp.endedAt,
      pendingUpdate: vp.pendingUpdate,
      graceUntil: vp.status === 'past_due' ? (vp.graceUntil ?? existing?.graceUntil ?? null) : null,
      eventWatermark: Math.max(Number(existing?.eventWatermark ?? 0), opts.eventCreated ?? 0) || null,
      lastSyncedAt: new Date(),
    };

    if (existing) {
      return { outcome: 'applied', row: await existing.update({ ...fields, ...(existing.purchasedByUserId ? {} : { purchasedByUserId: await validPurchaser(opts.purchasedByUserId) }) }) };
    }
    try {
      return { outcome: 'applied', row: await BillingSubscription.create({ ...fields, ...where, purchasedByUserId: await validPurchaser(opts.purchasedByUserId) }) };
    } catch (err) {
      if (!(err instanceof UniqueConstraintError)) throw err;
      const raced = (await BillingSubscription.findOne({ where }))!;
      return { outcome: 'applied', row: await raced.update(fields) };
    }
  }, { waitMs: 15_000 });

  if (result.row && result.outcome === 'applied') {
    await clearEntitlementCache(result.row.householdId);
    if (!opts.skipDuplicates) await resolveDuplicates(result.row.householdId, modeFromLivemode(vp.livemode));
  }
  return result;
}

export interface StorePaymentInput {
  row: BillingSubscription;
  type: 'payment' | 'refund' | 'failed_payment';
  objectId: string;
  /** Minor units. Falls back to the list price when the store did not report one. */
  amount: number | null;
  currency: string | null;
  at: Date;
  status: string;
  reason: string;
  eventId: string | null;
}

/** Task 11.4: store money movements go to the same ledger as Stripe's. Fees are unknown (the store keeps its cut). */
export async function recordStoreTransaction(input: StorePaymentInput): Promise<void> {
  const { row } = input;
  const fallback = amountFor(LAUNCH_FORMULA, row.interval, row.seats);
  await upsertLedgerRow({ provider: row.provider as 'apple' | 'google', livemode: row.livemode, type: input.type, providerObjectId: input.objectId }, {
    status: input.status,
    billingReason: input.reason,
    amount: input.amount ?? fallback,
    currency: (input.currency ?? 'USD').toLowerCase(),
    ...(await linkSubscriptionRow(row)),
    providerInvoiceId: null,
    description: `${row.provider} ${row.priceId ?? 'subscription'} ${input.reason}`.slice(0, 500),
    occurredAt: input.at,
    lastEventId: input.eventId,
  });
}

