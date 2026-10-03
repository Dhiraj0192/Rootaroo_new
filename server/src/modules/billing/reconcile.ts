import Stripe from 'stripe';
import { Op } from 'sequelize';
import {
  BillingCustomer, BillingReconciliationItem, Household, BillingReconciliationRun, BillingSubscription, BillingTransaction,
} from '../../database/models';
import logger from '../../shared/utils/logger';
import { getBillingConfig, getStripe } from './config';
import { sweepCheckouts } from './checkoutSweep';
import { setCancelAtPeriodEndForHousehold, syncBillingEmail } from './deletion';
import { clearEntitlementCache } from './entitlement';
import { envOfEventObject } from './handlers';
import { fetchPaymentFees, recordDispute, recordInvoice, recordRefund } from './ledger';
import { livemodeOf } from './mode';
import { getAdminRecipients } from './notify';
import { raiseReviewItem, recordAutoFix } from './review';
import { reconcileStoreSubscriptions, StoreReconCounts } from './iap/reconcileStore';
import { upsertSubscription } from './sync';
import { ALLOWED_STATUSES, BillingMode } from './types';

export type ReconKind = 'daily' | 'weekly' | 'manual';
export interface ReconCounts {
  subscriptionsChecked: number; subscriptionsFixed: number; missingInStripe: number; ledgerUpserts: number;
  feesFilled: number; emailDriftFixed: number; checkoutRowsFixed: number; reviewItems: number;
}
export type ReconRunCounts = ReconCounts & Partial<StoreReconCounts>;

export const SUB_FIELDS = ['status', 'seats', 'interval', 'priceId', 'unitAmount', 'currentPeriodEnd', 'cancelAtPeriodEnd', 'pendingUpdate', 'graceUntil'] as const;

export function snapshotSub(row: BillingSubscription): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of SUB_FIELDS) {
    const v = (row as unknown as Record<string, unknown>)[f];
    out[f] = v instanceof Date ? v.toISOString() : v === undefined ? null : v;
  }
  return out;
}

export function diffSnapshots(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  return SUB_FIELDS.filter((f) => JSON.stringify(a[f] ?? null) !== JSON.stringify(b[f] ?? null));
}

const pick = (o: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.map((k) => [k, o[k]]));

export async function runReconciliation(mode: BillingMode, kind: ReconKind, now: Date = new Date()): Promise<BillingReconciliationRun> {
  const livemode = livemodeOf(mode);
  const stripe = getStripe(mode);
  const envTag = getBillingConfig().envTag;
  const envOk = (obj: unknown) => { const e = envOfEventObject(obj); return !e || e === envTag; };
  const run = await BillingReconciliationRun.create({ livemode, kind, startedAt: now, status: 'running' });
  const counts: ReconCounts = { subscriptionsChecked: 0, subscriptionsFixed: 0, missingInStripe: 0, ledgerUpserts: 0, feesFilled: 0, emailDriftFixed: 0, checkoutRowsFixed: 0, reviewItems: 0 };
  let storeCounts: StoreReconCounts | null = null;
  const since = Math.floor((now.getTime() - (kind === 'weekly' ? 35 : 2) * 86400_000) / 1000);

  try {
    // (a)+(b) collect subscriptions to re-fetch
    const subIds = new Set<string>();
    const localAllowed = await BillingSubscription.findAll({ where: { livemode, provider: 'stripe', status: { [Op.in]: [...ALLOWED_STATUSES] } } });
    localAllowed.forEach((r) => subIds.add(r.providerSubscriptionId));
    const listParams: Stripe.SubscriptionListParams = kind === 'weekly' ? { status: 'all', limit: 100 } : { status: 'all', limit: 100, created: { gte: since } };
    for await (const sub of stripe.subscriptions.list(listParams)) if (envOk(sub)) subIds.add(sub.id);
    if (kind !== 'weekly') {
      const recent = await BillingTransaction.findAll({ where: { livemode, provider: 'stripe', occurredAt: { [Op.gte]: new Date(since * 1000) }, subscriptionId: { [Op.ne]: null } }, attributes: ['subscriptionId'] });
      const rows = await BillingSubscription.findAll({ where: { id: [...new Set(recent.map((t) => t.subscriptionId!))] }, attributes: ['providerSubscriptionId'] });
      rows.forEach((r) => subIds.add(r.providerSubscriptionId));
    }

    for (const subId of subIds) {
      const local = await BillingSubscription.findOne({ where: { provider: 'stripe', livemode, providerSubscriptionId: subId } });
      const before = local ? snapshotSub(local) : null;
      try {
        const row = await upsertSubscription(subId, mode);
        counts.subscriptionsChecked++;
        if (before && row) {
          const changed = diffSnapshots(before, snapshotSub(row));
          if (changed.length > 0) {
            await recordAutoFix({ livemode, kind: 'subscription_drift', entityType: 'subscription', entityId: row.id, providerObjectId: subId, before: pick(before, changed), after: pick(snapshotSub(row), changed), runId: run.id });
            counts.subscriptionsFixed++;
          }
        }
      } catch (err) {
        if ((err as { code?: string }).code !== 'resource_missing' || !local) throw err;
        await local.update({ status: 'canceled', graceUntil: null, endedAt: local.endedAt ?? now });
        await clearEntitlementCache(local.householdId);
        await raiseReviewItem({ livemode, kind: 'missing_in_stripe', entityType: 'subscription', entityId: local.id, providerObjectId: subId, before, runId: run.id });
        counts.missingInStripe++;
      }
    }

    // (b1) Apple / Google subscriptions through the store APIs (Task 11.4)
    const store = await reconcileStoreSubscriptions(mode, kind, run.id, now);
    storeCounts = store;

    // (b2) deletion drift: a household scheduled for deletion must have every allowed subscription set to cancel
    // (the fire-and-forget hook in household/service.ts can fail). Rows were just refreshed from Stripe above.
    const scheduled = await Household.findAll({ where: { scheduledDeletionAt: { [Op.ne]: null } }, attributes: ['id'] });
    if (scheduled.length > 0) {
      const drifting = await BillingSubscription.findAll({
        where: { livemode, provider: 'stripe', status: { [Op.in]: [...ALLOWED_STATUSES] }, cancelAtPeriodEnd: false, householdId: scheduled.map((h) => h.id) },
      });
      for (const sub of drifting) {
        try {
          const fixed = await setCancelAtPeriodEndForHousehold(sub.householdId, true, 'recon-hh-delete', { livemode });
          if (fixed.includes(sub.providerSubscriptionId)) {
            await recordAutoFix({ livemode, kind: 'deletion_drift', entityType: 'subscription', entityId: sub.id, providerObjectId: sub.providerSubscriptionId, before: { cancelAtPeriodEnd: false }, after: { cancelAtPeriodEnd: true }, runId: run.id });
          }
        } catch (err) {
          logger.warn(`[Reconcile] deletion drift fix failed for ${sub.providerSubscriptionId}: ${(err as Error).message}`);
          await raiseReviewItem({ livemode, kind: 'deletion_drift', entityType: 'subscription', entityId: sub.id, providerObjectId: sub.providerSubscriptionId, after: { error: (err as Error).message }, runId: run.id });
        }
      }
    }

    // (c) ledger
    for await (const inv of stripe.invoices.list({ created: { gte: since }, limit: 100 })) {
      if (!envOk(inv)) continue;
      if (inv.status === 'paid') {
        const row = await recordInvoice(inv, mode, 'payment', null);
        counts.ledgerUpserts++;
        if (row.amount !== inv.amount_paid) {
          await raiseReviewItem({ livemode, kind: 'amount_mismatch', entityType: 'invoice', providerObjectId: inv.id!, before: { ledger: row.amount }, after: { stripe: inv.amount_paid }, runId: run.id });
        }
      } else if (inv.status === 'open' && inv.attempted) {
        await recordInvoice(inv, mode, 'failed_payment', null);
        counts.ledgerUpserts++;
      }
    }
    for await (const refund of stripe.refunds.list({ created: { gte: since }, limit: 100 })) {
      await recordRefund(refund, mode, null);
      counts.ledgerUpserts++;
    }
    for await (const dispute of stripe.disputes.list({ created: { gte: since }, limit: 100 })) {
      await recordDispute(dispute, mode, null);
      counts.ledgerUpserts++;
    }

    // (d) missing fees
    const noFee = await BillingTransaction.findAll({ where: { livemode, provider: 'stripe', type: 'payment', fee: null }, limit: 500 });
    for (const t of noFee) {
      const fees = await fetchPaymentFees(t.providerObjectId, mode);
      if (fees && fees.fee !== null) {
        await t.update({ fee: fees.fee, net: fees.net, providerChargeId: fees.chargeId, receiptUrl: fees.receiptUrl ?? t.receiptUrl });
        counts.feesFilled++;
      }
    }

    // (e) billing email drift (section 5.11 retry path)
    for (const c of await BillingCustomer.findAll({ where: { livemode, provider: 'stripe' } })) {
      try {
        const [admin] = await getAdminRecipients(c.householdId);
        const expected = admin?.email ?? null;
        const remote = await stripe.customers.retrieve(c.providerCustomerId);
        if (!remote || (remote as Stripe.DeletedCustomer).deleted) continue;
        const remoteEmail = (remote as Stripe.Customer).email ?? null;
        if (remoteEmail !== expected || c.billingEmail !== expected) {
          await syncBillingEmail(c.householdId);
          await recordAutoFix({ livemode, kind: 'email_drift', entityType: 'customer', entityId: c.id, providerObjectId: c.providerCustomerId, before: { stripe: remoteEmail, local: c.billingEmail }, after: { email: expected }, runId: run.id });
          counts.emailDriftFixed++;
        }
      } catch (err) {
        logger.warn(`[Reconcile] email drift check failed for ${c.providerCustomerId}: ${(err as Error).message}`);
      }
    }

    // stale checkout rows
    const sweep = await sweepCheckouts(mode, now);
    counts.checkoutRowsFixed = sweep.completed + sweep.expired + sweep.failed;

    // duplicates section 8.6 could not resolve
    const allowedNow = await BillingSubscription.findAll({ where: { livemode, status: { [Op.in]: [...ALLOWED_STATUSES] } }, attributes: ['householdId', 'providerSubscriptionId'] });
    const byHousehold = new Map<string, string[]>();
    for (const r of allowedNow) byHousehold.set(r.householdId, [...(byHousehold.get(r.householdId) ?? []), r.providerSubscriptionId]);
    for (const [householdId, ids] of byHousehold) {
      if (ids.length > 1) await raiseReviewItem({ livemode, kind: 'unresolved_duplicate', entityType: 'household', entityId: householdId, providerObjectId: ids.sort().join(','), runId: run.id });
    }

    counts.reviewItems = await BillingReconciliationItem.count({ where: { livemode, resolution: 'needs_review', createdAt: { [Op.gte]: now } } });
    await run.update({ status: 'succeeded', finishedAt: new Date(), counts: { ...counts, ...(storeCounts ?? {}) } });
    return run;
  } catch (err) {
    await run.update({ status: 'failed', finishedAt: new Date(), counts: { ...counts } });
    throw err;
  }
}
