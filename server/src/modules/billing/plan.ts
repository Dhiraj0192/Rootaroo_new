import Stripe from 'stripe';
import { Op } from 'sequelize';
import { BillingCustomer, BillingPriceNotice, BillingSubscription } from '../../database/models';
import { assertSeats, CatalogPrice, findPriceInSet, getCatalog, priceFor } from './catalog';
import { checkoutLockName, paymentIssueError } from './checkout';
import { getStripe } from './config';
import { requireAdminContext } from './context';
import { getEntitlement } from './entitlement';
import { BillingConflictError } from './errors';
import { withLock } from './locks';
import { livemodeOf } from './mode';
import { upsertSubscription } from './sync';
import type { BillingInterval, BillingMode, Entitlement } from './types';

export interface PlanChangeResult { changed: boolean; pendingUpdate: boolean; hostedInvoiceUrl: string | null; entitlement: Entitlement }

export async function choosePlanPrice(mode: BillingMode, sub: BillingSubscription, interval: BillingInterval, seats: number): Promise<CatalogPrice> {
  const notice = await BillingPriceNotice.findOne({ where: { subscriptionId: sub.id, status: 'scheduled' } });
  if (notice) {
    const p = await findPriceInSet(mode, notice.toPriceSet, interval, seats);
    if (p) return p;
  }
  if (sub.priceSet) {
    const p = await findPriceInSet(mode, sub.priceSet, interval, seats);
    if (p) return p;
  }
  return priceFor(await getCatalog(mode), interval, seats);
}

export async function changePlan(userId: string, body: { interval: BillingInterval; seats: number }): Promise<PlanChangeResult> {
  const ctx = await requireAdminContext(userId);
  assertSeats(body.seats);
  const { household, mode } = ctx;
  const livemode = livemodeOf(mode);
  return withLock(checkoutLockName(household.id, mode), 60_000, async () => {
    const sub = await BillingSubscription.findOne({
      where: { householdId: household.id, livemode, status: { [Op.in]: ['active', 'trialing', 'past_due'] } }, order: [['createdAt', 'DESC']],
    });
    if (!sub) throw new BillingConflictError('NO_ACTIVE_SUBSCRIPTION', 'There is no active subscription to change');
    if (sub.provider !== 'stripe') {
      throw new BillingConflictError('PURCHASE_METHOD_MISMATCH', 'Change your plan in the store where you subscribed', { provider: sub.provider });
    }
    if (sub.status === 'past_due') {
      const customer = await BillingCustomer.findOne({ where: { householdId: household.id, provider: 'stripe', livemode } });
      throw await paymentIssueError(mode, customer?.providerCustomerId ?? null);
    }
    if (sub.pendingUpdate) {
      // A previous change is still waiting on payment; a second update would stack on top of it.
      const pendingSub = await getStripe(mode).subscriptions.retrieve(sub.providerSubscriptionId, { expand: ['latest_invoice'] });
      const pendingInvoice = typeof pendingSub.latest_invoice === 'object' ? (pendingSub.latest_invoice as Stripe.Invoice | null) : null;
      throw new BillingConflictError('PLAN_CHANGE_PENDING', 'Your previous plan change is still waiting for payment', {
        hostedInvoiceUrl: pendingInvoice?.status === 'open' ? pendingInvoice.hosted_invoice_url ?? null : null,
      });
    }
    if (body.seats < ctx.memberCount) {
      throw new BillingConflictError('SEATS_BELOW_MEMBERS', `Your household has ${ctx.memberCount} members`, { memberCount: ctx.memberCount });
    }
    if (body.seats === sub.seats && body.interval === sub.interval) {
      return { changed: false, pendingUpdate: sub.pendingUpdate !== null, hostedInvoiceUrl: null, entitlement: await getEntitlement(household.id) };
    }

    const price = await choosePlanPrice(mode, sub, body.interval, body.seats);
    const stripe = getStripe(mode);
    const current = await stripe.subscriptions.retrieve(sub.providerSubscriptionId);
    const intervalChange = body.interval !== sub.interval;
    // billing_cycle_anchor is a supported attribute for pending updates
    // (https://docs.stripe.com/billing/subscriptions/pending-updates-reference.md).
    const updated = await stripe.subscriptions.update(sub.providerSubscriptionId, {
      items: [{ id: current.items.data[0].id, price: price.priceId }],
      payment_behavior: 'pending_if_incomplete',
      proration_behavior: intervalChange ? 'create_prorations' : 'always_invoice',
      ...(intervalChange ? { billing_cycle_anchor: { type: 'now' as const } } : {}),
      expand: ['latest_invoice'],
    }, { idempotencyKey: `plan:${sub.providerSubscriptionId}:${body.interval}:${body.seats}:v${sub.planChangeVersion}` });
    // Advance only after Stripe accepted the change: a retry of a failed attempt keeps the same key (Stripe dedupes it),
    // while A -> B -> A -> B gets a fresh key per applied change instead of replaying a cached response.
    await sub.increment('planChangeVersion');
    await upsertSubscription(sub.providerSubscriptionId, mode);
    const invoice = typeof updated.latest_invoice === 'object' ? (updated.latest_invoice as Stripe.Invoice | null) : null;
    const pending = updated.pending_update !== null && updated.pending_update !== undefined;
    return {
      changed: true,
      pendingUpdate: pending,
      hostedInvoiceUrl: pending && invoice?.status === 'open' ? invoice.hosted_invoice_url ?? null : null,
      entitlement: await getEntitlement(household.id, { bypassCache: true }),
    };
  }, { waitMs: 10_000 });
}
