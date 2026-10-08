import { Op } from 'sequelize';
import { BillingSubscription } from '../../../database/models';
import logger from '../../../shared/utils/logger';
import { clearEntitlementCache } from '../entitlement';
import { diffSnapshots, snapshotSub } from '../reconcile';
import { raiseReviewItem, recordAutoFix } from '../review';
import { livemodeOf } from '../mode';
import type { BillingMode } from '../types';
import { AppleNotFoundError, appleApiAvailable, fetchAppleSubscription } from './apple';
import { acknowledgeIfNeeded } from './googleEvents';
import { fetchGoogleSubscription, GoogleNotFoundError, playApiAvailable } from './google';
import { upsertStoreSubscription } from './store';

export interface StoreReconCounts { storeChecked: number; storeFixed: number; storeMissing: number; storeErrors: number }

const pick = (o: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.map((k) => [k, o[k]]));
/** Rows that can still change on their own. Final rows (canceled, expired) are only revisited by the weekly run. */
const OPEN = ['active', 'trialing', 'past_due', 'unpaid', 'paused', 'incomplete'];

/**
 * Task 11.4 / spec section 10: refetch Apple and Google subscriptions from the store APIs, write them through the
 * same upsert as notifications, and record any drift. A store that is not configured is skipped; one failing
 * subscription never fails the run.
 */
export async function reconcileStoreSubscriptions(mode: BillingMode, kind: 'daily' | 'weekly' | 'manual', runId: string, now: Date): Promise<StoreReconCounts> {
  const counts: StoreReconCounts = { storeChecked: 0, storeFixed: 0, storeMissing: 0, storeErrors: 0 };
  const livemode = livemodeOf(mode);
  const providers: Array<'apple' | 'google'> = [];
  if (appleApiAvailable()) providers.push('apple');
  if (playApiAvailable()) providers.push('google');
  if (providers.length === 0) return counts;

  const rows = await BillingSubscription.findAll({
    where: { livemode, provider: { [Op.in]: providers }, ...(kind === 'weekly' ? {} : { status: { [Op.in]: OPEN } }) },
  });

  for (const local of rows) {
    const before = snapshotSub(local);
    try {
      let res;
      if (local.provider === 'apple') {
        res = await upsertStoreSubscription(await fetchAppleSubscription(local.providerSubscriptionId, livemode));
      } else {
        const g = await fetchGoogleSubscription(local.providerSubscriptionId);
        res = await upsertStoreSubscription(g.vp);
        await acknowledgeIfNeeded(g, local.providerSubscriptionId); // a missed acknowledge would be refunded by Google after 3 days
      }
      counts.storeChecked++;
      if (res.row) {
        const changed = diffSnapshots(before, snapshotSub(res.row));
        if (changed.length > 0) {
          await recordAutoFix({
            livemode, kind: 'subscription_drift', entityType: 'subscription', entityId: res.row.id, providerObjectId: local.providerSubscriptionId,
            before: pick(before, changed), after: pick(snapshotSub(res.row), changed), runId,
          });
          counts.storeFixed++;
        }
      }
    } catch (err) {
      if (err instanceof AppleNotFoundError || err instanceof GoogleNotFoundError) {
        counts.storeMissing++;
        if (OPEN.includes(local.status)) {
          await local.update({ status: 'canceled', graceUntil: null, endedAt: local.endedAt ?? now });
          await clearEntitlementCache(local.householdId);
          await raiseReviewItem({ livemode, kind: 'missing_in_store', entityType: 'subscription', entityId: local.id, providerObjectId: local.providerSubscriptionId, before, runId });
        }
      } else {
        counts.storeErrors++;
        logger.warn(`[Reconcile] ${local.provider} subscription ${local.providerSubscriptionId} failed: ${(err as Error).message}`);
      }
    }
  }
  return counts;
}
