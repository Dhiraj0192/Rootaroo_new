import Stripe from 'stripe';
import { Op } from 'sequelize';
import { BillingCheckoutSession, BillingCustomer, BillingSubscription, BillingTransaction } from '../../database/models';
import { getStripe } from './config';
import { formatUsd } from './copy';
import { invoiceSubscriptionId, linkInvoice, recordDispute, recordInvoice, recordRefund } from './ledger';
import { livemodeOf } from './mode';
import { alertStaff, notifyHouseholdAdmins } from './notify';
import { raiseReviewItem } from './review';
import { idOf, upsertSubscription } from './sync';
import type { BillingMode } from './types';

export type HandlerOutcome = 'processed' | 'ignored';
export const NOTIFY_FAILED_REASONS = ['subscription_cycle', 'subscription_create'];
type Ref = string | { id: string } | null | undefined;

export function envOfEventObject(obj: unknown): string | undefined {
  const o = obj as { metadata?: Record<string, string> | null; parent?: { subscription_details?: { metadata?: Record<string, string> | null } | null } | null };
  return o?.metadata?.env ?? o?.parent?.subscription_details?.metadata?.env ?? undefined;
}

async function handleLostDispute(row: BillingTransaction, mode: BillingMode): Promise<void> {
  const livemode = livemodeOf(mode);
  const sub = await BillingSubscription.findOne({
    where: { householdId: row.householdId, livemode, provider: 'stripe', status: { [Op.in]: ['active', 'trialing', 'past_due'] } },
  });
  if (sub && !sub.cancelAtPeriodEnd) {
    await getStripe(mode).subscriptions.update(sub.providerSubscriptionId, { cancel_at_period_end: true }, { idempotencyKey: `dispute-lost:${row.providerObjectId}` });
    await upsertSubscription(sub.providerSubscriptionId, mode);
  }
  await raiseReviewItem({ livemode, kind: 'dispute_lost', entityType: 'dispute', entityId: row.householdId, providerObjectId: row.providerObjectId, after: { subscription: sub?.providerSubscriptionId ?? null } });
}

export async function dispatchEvent(event: Stripe.Event, mode: BillingMode): Promise<HandlerOutcome> {
  const obj = event.data.object as unknown;
  const livemode = livemodeOf(mode);
  const opts = { eventCreated: event.created };

  switch (event.type as string) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
    case 'checkout.session.async_payment_failed': {
      const session = obj as Stripe.Checkout.Session;
      await BillingCheckoutSession.update({ status: 'complete' }, { where: { providerSessionId: session.id } });
      const subId = idOf(session.subscription as Ref);
      if (subId) await upsertSubscription(subId, mode, opts);
      return 'processed';
    }
    case 'checkout.session.expired': {
      const session = obj as Stripe.Checkout.Session;
      await BillingCheckoutSession.update({ status: 'expired' }, { where: { providerSessionId: session.id, status: { [Op.in]: ['open', 'creating'] } } });
      return 'processed';
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
    case 'customer.subscription.pending_update_applied':
      await upsertSubscription((obj as Stripe.Subscription).id, mode, opts);
      return 'processed';
    case 'customer.subscription.pending_update_expired': {
      const row = await upsertSubscription((obj as Stripe.Subscription).id, mode, opts);
      if (row) {
        await notifyHouseholdAdmins(row.householdId, 'billing_plan_change_failed', 'Your plan change did not go through',
          'The payment for your plan change was not completed, so your household stays on its current plan. You can try again from Subscription.',
          { type: 'billing_plan_change_failed' });
      }
      return 'processed';
    }
    case 'invoice.paid': {
      const inv = obj as Stripe.Invoice;
      // Upsert first so the local subscription row exists when the ledger row is linked.
      const subId = invoiceSubscriptionId(inv);
      if (subId) await upsertSubscription(subId, mode, opts);
      await recordInvoice(inv, mode, 'payment', event.id);
      return 'processed';
    }
    case 'invoice.payment_failed': {
      const inv = obj as Stripe.Invoice;
      const failedSubId = invoiceSubscriptionId(inv);
      if (failedSubId) await upsertSubscription(failedSubId, mode, opts);
      const row = await recordInvoice(inv, mode, 'failed_payment', event.id);
      if (row?.householdId && NOTIFY_FAILED_REASONS.includes(inv.billing_reason ?? '')) {
        await notifyHouseholdAdmins(row.householdId, 'billing_payment_failed', 'Your Rootaroo payment failed',
          `We couldn't charge ${formatUsd(inv.amount_due)}. Update your card to keep access: ${inv.hosted_invoice_url ?? 'More → Subscription → Manage subscription'}`,
          { type: 'billing_payment_failed', url: inv.hosted_invoice_url ?? null });
      }
      return 'processed';
    }
    case 'invoice.payment_action_required': {
      const inv = obj as Stripe.Invoice;
      const link = await linkInvoice(inv, mode);
      if (link.householdId) {
        await notifyHouseholdAdmins(link.householdId, 'billing_action_required', 'Confirm your Rootaroo payment',
          `Your bank needs you to confirm this payment: ${inv.hosted_invoice_url ?? ''}`, { type: 'billing_action_required', url: inv.hosted_invoice_url ?? null });
      }
      return 'processed';
    }
    case 'refund.created':
    case 'refund.updated':
    case 'refund.failed':
      await recordRefund(obj as Stripe.Refund, mode, event.id);
      return 'processed';
    case 'charge.dispute.created': {
      const d = obj as Stripe.Dispute;
      const row = await recordDispute(d, mode, event.id);
      await raiseReviewItem({ livemode, kind: 'dispute_opened', entityType: 'dispute', entityId: row.householdId, providerObjectId: d.id, after: { amount: d.amount, reason: d.reason } });
      await alertStaff('Dispute opened', `Dispute ${d.id} for ${formatUsd(d.amount)} (${d.reason}), household ${row.householdId ?? 'unmatched'}.`);
      return 'processed';
    }
    case 'charge.dispute.updated':
    case 'charge.dispute.funds_withdrawn':
    case 'charge.dispute.funds_reinstated':
      await recordDispute(obj as Stripe.Dispute, mode, event.id);
      return 'processed';
    case 'charge.dispute.closed': {
      const d = obj as Stripe.Dispute;
      const row = await recordDispute(d, mode, event.id);
      if (d.status === 'lost' && row.householdId) await handleLostDispute(row, mode);
      return 'processed';
    }
    case 'radar.early_fraud_warning.created': {
      const w = obj as { id: string; charge?: Ref };
      await raiseReviewItem({ livemode, kind: 'early_fraud_warning', entityType: 'early_fraud_warning', providerObjectId: w.id, after: { charge: idOf(w.charge) } });
      await alertStaff('Early fraud warning', `Radar early fraud warning ${w.id} on charge ${idOf(w.charge) ?? 'unknown'}.`);
      return 'processed';
    }
    case 'customer.updated': {
      const c = obj as Stripe.Customer;
      await BillingCustomer.update({ billingEmail: c.email ?? null }, { where: { provider: 'stripe', livemode, providerCustomerId: c.id } });
      return 'processed';
    }
    default:
      return 'ignored';
  }
}
