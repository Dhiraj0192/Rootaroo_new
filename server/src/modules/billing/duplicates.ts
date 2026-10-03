import Stripe from 'stripe';
import { Op } from 'sequelize';
import { BillingSubscription } from '../../database/models';
import logger from '../../shared/utils/logger';
import { getBillingConfig, getStripe } from './config';
import { clearEntitlementCache } from './entitlement';
import { livemodeOf } from './mode';
import { alertStaff, notifyHouseholdAdmins } from './notify';
import { raiseReviewItem } from './review';
import { ALLOWED_STATUSES, BillingMode } from './types';

export interface DuplicateCandidate { id: string; status: string; created: number }

export function chooseKeeper<T extends DuplicateCandidate>(c: T[]): { keep: T; cancel: T[] } {
  const rank = (s: T) => (s.status === 'active' || s.status === 'trialing' ? 0 : 1);
  const sorted = [...c].sort((a, b) => rank(a) - rank(b) || a.created - b.created);
  return { keep: sorted[0], cancel: sorted.slice(1) };
}

const isAllowed = (s: string) => (ALLOWED_STATUSES as readonly string[]).includes(s);

async function refundLatestPaid(stripe: Stripe, sub: Stripe.Subscription, householdId: string, livemode: boolean): Promise<void> {
  const inv = typeof sub.latest_invoice === 'object' ? sub.latest_invoice : null;
  if (!inv || inv.status !== 'paid' || !inv.amount_paid) return;
  // Verify at implementation time: https://docs.stripe.com/api/invoice-payment/list.md (invoice filter, expand path).
  const payments = await stripe.invoicePayments.list({ invoice: inv.id!, limit: 10, expand: ['data.payment.payment_intent'] });
  const paid = payments.data.find((p) => p.status === 'paid');
  const pi = paid?.payment?.payment_intent;
  const piId = typeof pi === 'string' ? pi : pi?.id;
  if (!piId) {
    await raiseReviewItem({ livemode, kind: 'duplicate_refund_missing', entityType: 'subscription', providerObjectId: sub.id });
    return;
  }
  await stripe.refunds.create(
    { payment_intent: piId, reason: 'duplicate', metadata: { householdId, env: getBillingConfig().envTag, reason: 'duplicate_subscription', subscription: sub.id } },
    { idempotencyKey: `dup:${sub.id}` },
  );
}

/** §8.6: run after every upsert. Never calls upsertSubscription (no recursion). */
export async function resolveDuplicates(householdId: string, mode: BillingMode): Promise<{ kept: string; canceled: string[] } | null> {
  const livemode = livemodeOf(mode);
  const rows = await BillingSubscription.findAll({ where: { householdId, livemode, status: { [Op.in]: [...ALLOWED_STATUSES] } } });
  if (rows.length <= 1) return null;

  if (rows.some((r) => r.provider !== 'stripe')) {
    await raiseReviewItem({
      livemode, kind: 'cross_provider_duplicate', entityType: 'household', entityId: householdId,
      providerObjectId: rows.map((r) => r.providerSubscriptionId).sort().join(','),
      after: rows.map((r) => ({ provider: r.provider, id: r.providerSubscriptionId, status: r.status })),
    });
    await notifyHouseholdAdmins(householdId, 'billing_duplicate_store', 'Your household has two Rootaroo subscriptions',
      'Your household is subscribed through more than one store. Cancel the extra one in your App Store or Google Play subscription settings. Contact support if you need a refund.',
      {}, { email: true });
    return null;
  }

  const stripe = getStripe(mode);
  // A subscription Stripe no longer knows is reconciliation's job (missing_in_stripe), not a duplicate.
  const fresh = (await Promise.all(rows.map((r): Promise<Stripe.Subscription | null> => stripe.subscriptions.retrieve(r.providerSubscriptionId, { expand: ['latest_invoice'] })
    .catch((err: { code?: string }) => { if (err.code === 'resource_missing') return null; throw err; }))))
    .filter((x): x is Stripe.Subscription => x !== null);
  const allowed = fresh.filter((s) => isAllowed(s.status));
  if (allowed.length <= 1) return null; // local rows are stale; their own upserts correct them

  const { keep, cancel } = chooseKeeper(allowed);
  for (const sub of cancel) {
    const canceled = await stripe.subscriptions.cancel(sub.id, { prorate: false }, { idempotencyKey: `dupcancel:${sub.id}` });
    await BillingSubscription.update(
      {
        status: canceled.status,
        canceledAt: canceled.canceled_at ? new Date(canceled.canceled_at * 1000) : new Date(),
        endedAt: canceled.ended_at ? new Date(canceled.ended_at * 1000) : new Date(),
        graceUntil: null,
      },
      { where: { provider: 'stripe', livemode, providerSubscriptionId: sub.id } },
    );
    try {
      await refundLatestPaid(stripe, sub, householdId, livemode);
    } catch (err) {
      logger.error(`[Billing] duplicate refund failed for ${sub.id}:`, err);
      await raiseReviewItem({ livemode, kind: 'duplicate_refund_failed', entityType: 'subscription', providerObjectId: sub.id, after: { error: (err as Error).message } });
    }
  }

  const canceled = cancel.map((c) => c.id);
  await raiseReviewItem({
    livemode, kind: 'duplicate_subscription', entityType: 'household', entityId: householdId,
    providerObjectId: [keep.id, ...canceled].join(','), after: { kept: keep.id, canceled },
  });
  await alertStaff('Duplicate subscription resolved', `Household ${householdId}: kept ${keep.id}, canceled and refunded ${canceled.join(', ')}.`);
  await notifyHouseholdAdmins(householdId, 'billing_duplicate_refunded', 'We refunded a duplicate subscription',
    'Your household was charged for two subscriptions. We kept one and refunded the other in full.', {}, { email: true });
  await clearEntitlementCache(householdId);
  return { kept: keep.id, canceled };
}
