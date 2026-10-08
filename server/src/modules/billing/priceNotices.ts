import { Op } from 'sequelize';
import { BillingPriceNotice, BillingSubscription } from '../../database/models';
import logger from '../../shared/utils/logger';
import { findPriceInSet } from './catalog';
import { getStripe } from './config';
import { formatUsd } from './copy';
import { livemodeOf } from './mode';
import { notifyHouseholdAdmins } from './notify';
import { raiseReviewItem } from './review';
import { upsertSubscription } from './sync';
import { ALLOWED_STATUSES, BillingInterval, BillingMode, SubscriptionStatus } from './types';

export const RENEWAL_GUARD_MS = 48 * 3600_000;

export function noticeDecision(
  notice: { applyAfter: Date },
  sub: { status: SubscriptionStatus; currentPeriodEnd: Date | null; endedAt: Date | null },
  now: Date,
): 'apply' | 'wait' | 'skip' {
  if (!ALLOWED_STATUSES.includes(sub.status) || sub.endedAt) return 'skip';
  if (now.getTime() < notice.applyAfter.getTime()) return 'wait';
  if (!sub.currentPeriodEnd || now.getTime() > sub.currentPeriodEnd.getTime() - RENEWAL_GUARD_MS) return 'wait';
  return 'apply';
}

export function effectiveRenewalDate(applyAfter: Date, currentPeriodEnd: Date, interval: BillingInterval): Date {
  if (applyAfter.getTime() <= currentPeriodEnd.getTime() - RENEWAL_GUARD_MS) return currentPeriodEnd;
  const next = new Date(currentPeriodEnd);
  if (interval === 'month') next.setUTCMonth(next.getUTCMonth() + 1);
  else next.setUTCFullYear(next.getUTCFullYear() + 1);
  return next;
}

export async function scheduleMigration(mode: BillingMode, from: string, to: string, noticeDays: number, now: Date = new Date()): Promise<{ scheduled: number; skipped: number }> {
  if (noticeDays < 30) throw new Error('notice must be at least 30 days');
  const livemode = livemodeOf(mode);
  const subs = await BillingSubscription.findAll({ where: { livemode, provider: 'stripe', priceSet: from, status: { [Op.in]: [...ALLOWED_STATUSES] } } });
  let scheduled = 0;
  let skipped = 0;
  const applyAfter = new Date(now.getTime() + noticeDays * 86400_000);
  for (const sub of subs) {
    const target = await findPriceInSet(mode, to, sub.interval, sub.seats);
    if (!target) {
      skipped++;
      await raiseReviewItem({ livemode, kind: 'price_migration_missing_price', entityType: 'subscription', providerObjectId: sub.providerSubscriptionId, after: { to, interval: sub.interval, seats: sub.seats } });
      continue;
    }
    const [notice, created] = await BillingPriceNotice.findOrCreate({
      where: { subscriptionId: sub.id, toPriceSet: to },
      defaults: { subscriptionId: sub.id, toPriceSet: to, fromPriceId: sub.priceId ?? 'unknown', noticeSentAt: now, applyAfter },
    });
    if (!created) continue;
    scheduled++;
    const renewal = sub.currentPeriodEnd ? effectiveRenewalDate(notice.applyAfter, sub.currentPeriodEnd, sub.interval).toISOString().slice(0, 10) : 'your next renewal';
    await notifyHouseholdAdmins(sub.householdId, 'billing_price_change', 'Your Rootaroo price is changing',
      `Your Rootaroo price is changing from ${formatUsd(sub.unitAmount ?? 0)} to ${formatUsd(target.amount)} per ${sub.interval}, starting with your renewal on ${renewal}. You can cancel any time before then in Manage subscription.`,
      { type: 'billing_price_change', renewal }, { email: true });
  }
  return { scheduled, skipped };
}

export async function applyDueNotices(mode: BillingMode, now: Date = new Date()): Promise<{ applied: number; skipped: number; failed: number; waiting: number }> {
  const livemode = livemodeOf(mode);
  const out = { applied: 0, skipped: 0, failed: 0, waiting: 0 };
  const notices = await BillingPriceNotice.findAll({ where: { status: 'scheduled' } });
  for (const notice of notices) {
    const sub = await BillingSubscription.findByPk(notice.subscriptionId);
    if (!sub || sub.livemode !== livemode) continue;
    const decision = noticeDecision(notice, sub, now);
    if (decision === 'wait') { out.waiting++; continue; }
    if (decision === 'skip') {
      await notice.update({ status: 'skipped', reason: `subscription ${sub.status}` });
      out.skipped++;
      continue;
    }
    try {
      const target = await findPriceInSet(mode, notice.toPriceSet, sub.interval, sub.seats);
      if (!target) throw new Error(`no ${notice.toPriceSet} price for ${sub.seats}/${sub.interval}`);
      if (sub.priceId !== target.priceId) {
        const stripe = getStripe(mode);
        const current = await stripe.subscriptions.retrieve(sub.providerSubscriptionId);
        await stripe.subscriptions.update(sub.providerSubscriptionId,
          { items: [{ id: current.items.data[0].id, price: target.priceId }], proration_behavior: 'none' },
          { idempotencyKey: `pricenotice:${notice.id}` });
        await upsertSubscription(sub.providerSubscriptionId, mode);
      }
      await notice.update({ status: 'applied', appliedAt: now });
      out.applied++;
    } catch (err) {
      logger.error(`[Billing] price notice ${notice.id} failed:`, err);
      await notice.update({ status: 'failed', reason: (err as Error).message.slice(0, 500) });
      await raiseReviewItem({ livemode, kind: 'price_notice_failed', entityType: 'subscription', providerObjectId: sub.providerSubscriptionId, after: { notice: notice.id } });
      out.failed++;
    }
  }
  return out;
}
