import Stripe from 'stripe';
import { UniqueConstraintError } from 'sequelize';
import { BillingCustomer, BillingSubscription, Household, User } from '../../database/models';
import logger from '../../shared/utils/logger';
import { getBillingConfig, getStripe } from './config';
import { resolveDuplicates } from './duplicates';
import { clearEntitlementCache } from './entitlement';
import { withLock } from './locks';
import { livemodeOf } from './mode';
import { raiseReviewItem } from './review';
import type { BillingInterval, BillingMode, SubscriptionStatus } from './types';

export interface MappedSubscription {
  status: SubscriptionStatus;
  interval: BillingInterval;
  seats: number | null;
  priceId: string | null;
  priceSet: string | null;
  unitAmount: number | null;
  currency: string | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: Date | null;
  endedAt: Date | null;
  pendingUpdate: Record<string, unknown> | null;
  customerId: string;
  metadata: Record<string, string>;
}

export function idOf(x: string | { id: string } | null | undefined): string | null {
  if (!x) return null;
  return typeof x === 'string' ? x : x.id;
}

const toDate = (sec: number | null | undefined): Date | null => (typeof sec === 'number' ? new Date(sec * 1000) : null);

function seatsOf(price: Stripe.Price | undefined): number | null {
  const fromMeta = Number(price?.metadata?.seats);
  if (Number.isInteger(fromMeta) && fromMeta >= 5 && fromMeta <= 10) return fromMeta;
  const m = /^rootaroo_hh(\d+)_(month|year)$/.exec(price?.lookup_key ?? '');
  const fromKey = m ? Number(m[1]) : NaN;
  return Number.isInteger(fromKey) && fromKey >= 5 && fromKey <= 10 ? fromKey : null;
}

export function mapStripeSubscription(sub: Stripe.Subscription): MappedSubscription {
  const item = sub.items.data[0];
  const price = item?.price;
  return {
    status: sub.status as SubscriptionStatus,
    interval: price?.recurring?.interval === 'year' ? 'year' : 'month',
    seats: seatsOf(price),
    priceId: price?.id ?? null,
    priceSet: price?.metadata?.price_set ?? null,
    unitAmount: price?.unit_amount ?? null,
    currency: price?.currency ?? null,
    currentPeriodStart: toDate(item?.current_period_start),
    currentPeriodEnd: toDate(item?.current_period_end),
    cancelAtPeriodEnd: sub.cancel_at_period_end,
    canceledAt: toDate(sub.canceled_at),
    endedAt: toDate(sub.ended_at),
    pendingUpdate: sub.pending_update ? (sub.pending_update as unknown as Record<string, unknown>) : null,
    customerId: idOf(sub.customer as string | { id: string })!,
    metadata: (sub.metadata ?? {}) as Record<string, string>,
  };
}

export function computeGraceUntil(
  status: SubscriptionStatus, existing: Date | null, latestInvoice: Stripe.Invoice | string | null, graceDays: number,
): Date | null {
  if (status !== 'past_due') return null;
  if (existing) return existing;
  if (!latestInvoice || typeof latestInvoice === 'string') return null;
  const base = latestInvoice.status_transitions?.finalized_at ?? latestInvoice.created;
  return new Date((base + graceDays * 86400) * 1000);
}

export async function resolveHouseholdForSubscription(
  mapped: MappedSubscription, mode: BillingMode,
): Promise<{ householdId: string; via: 'customer' | 'metadata' } | null> {
  const livemode = livemodeOf(mode);
  const cust = await BillingCustomer.findOne({ where: { provider: 'stripe', livemode, providerCustomerId: mapped.customerId } });
  if (cust) return { householdId: cust.householdId, via: 'customer' };
  const hh = mapped.metadata.householdId;
  if (hh && mapped.metadata.env === getBillingConfig().envTag) {
    const household = await Household.findByPk(hh, { paranoid: false, attributes: ['id'] });
    if (household) return { householdId: household.id, via: 'metadata' };
  }
  return null;
}

async function validPurchaser(userId: string | undefined): Promise<string | null> {
  if (!userId) return null;
  const user = await User.findByPk(userId, { paranoid: false, attributes: ['id'] });
  return user ? user.id : null;
}

async function ensureCustomerRow(householdId: string, customerId: string, livemode: boolean): Promise<void> {
  try {
    await BillingCustomer.findOrCreate({
      where: { householdId, provider: 'stripe', livemode },
      defaults: { householdId, provider: 'stripe', livemode, providerCustomerId: customerId },
    });
  } catch (err) {
    if (!(err instanceof UniqueConstraintError)) throw err;
  }
}

/**
 * §8.4: the only code that writes subscription state. Fetches fresh state inside a
 * per-subscription lock, so the last writer always writes the newest Stripe state.
 */
export async function upsertSubscription(
  subId: string, mode: BillingMode, opts: { eventCreated?: number; skipDuplicates?: boolean } = {},
): Promise<BillingSubscription | null> {
  const row = await withLock(`billing:sub:${subId}`, 30_000, async () => {
    const cfg = getBillingConfig();
    const livemode = livemodeOf(mode);
    const sub = await getStripe(mode).subscriptions.retrieve(subId, { expand: ['items.data.price', 'latest_invoice'] });
    if (sub.livemode !== livemode) throw new Error(`livemode mismatch for ${subId}`);
    const mapped = mapStripeSubscription(sub);
    if (mapped.metadata.env && mapped.metadata.env !== cfg.envTag) {
      logger.info(`[Billing] ignoring ${subId}: env ${mapped.metadata.env} != ${cfg.envTag}`);
      return null;
    }

    const link = await resolveHouseholdForSubscription(mapped, mode);
    if (!link) {
      await raiseReviewItem({ livemode, kind: 'unmatched_subscription', entityType: 'subscription', providerObjectId: subId, after: { customer: mapped.customerId, metadata: mapped.metadata } });
      return null;
    }
    if (link.via === 'metadata') await ensureCustomerRow(link.householdId, mapped.customerId, livemode);

    if (mapped.seats === null) {
      await raiseReviewItem({ livemode, kind: 'unknown_price', entityType: 'subscription', providerObjectId: subId, after: { priceId: mapped.priceId } });
    }

    const existing = await BillingSubscription.findOne({ where: { provider: 'stripe', livemode, providerSubscriptionId: subId } });
    const fields = {
      householdId: link.householdId,
      status: mapped.status,
      interval: mapped.interval,
      seats: mapped.seats ?? existing?.seats ?? 5,
      priceId: mapped.priceId,
      priceSet: mapped.priceSet,
      unitAmount: mapped.unitAmount,
      currency: mapped.currency,
      currentPeriodStart: mapped.currentPeriodStart,
      currentPeriodEnd: mapped.currentPeriodEnd,
      cancelAtPeriodEnd: mapped.cancelAtPeriodEnd,
      canceledAt: mapped.canceledAt,
      endedAt: mapped.endedAt,
      pendingUpdate: mapped.pendingUpdate,
      graceUntil: computeGraceUntil(mapped.status, existing?.graceUntil ?? null, sub.latest_invoice as Stripe.Invoice | string | null, cfg.graceDays),
      eventWatermark: Math.max(Number(existing?.eventWatermark ?? 0), opts.eventCreated ?? 0) || null,
      lastSyncedAt: new Date(),
    };

    if (existing) return existing.update(fields);
    try {
      return await BillingSubscription.create({
        ...fields, provider: 'stripe', livemode, providerSubscriptionId: subId,
        purchasedByUserId: await validPurchaser(mapped.metadata.purchasedByUserId),
      });
    } catch (err) {
      if (!(err instanceof UniqueConstraintError)) throw err;
      const raced = await BillingSubscription.findOne({ where: { provider: 'stripe', livemode, providerSubscriptionId: subId } });
      return raced!.update(fields);
    }
  }, { waitMs: 15_000 });

  if (row) {
    await clearEntitlementCache(row.householdId);
    if (!opts.skipDuplicates) await resolveDuplicates(row.householdId, mode);
  }
  return row;
}
