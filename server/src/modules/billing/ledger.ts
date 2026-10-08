import Stripe from 'stripe';
import { Op, UniqueConstraintError } from 'sequelize';
import { BillingCustomer, BillingSubscription, BillingTransaction, Household, User } from '../../database/models';
import type { FundsState, LedgerType } from '../../database/models/BillingTransaction';
import logger from '../../shared/utils/logger';
import { getStripe } from './config';
import { livemodeOf } from './mode';
import { raiseReviewItem } from './review';
import { idOf } from './sync';
import type { BillingMode } from './types';

export const ANONYMIZED_EMAIL = 'deleted user';

export interface LedgerLink {
  householdId: string | null;
  userId: string | null;
  subscriptionId: string | null;
  matchStatus: 'matched' | 'unmatched';
  householdNameSnapshot: string | null;
  payerEmailSnapshot: string | null;
}

export type LedgerFields = Partial<{
  status: string; billingReason: string | null; amount: number; fee: number | null; net: number | null; disputeFee: number | null;
  fundsState: FundsState | null; currency: string; householdId: string | null; userId: string | null; subscriptionId: string | null;
  matchStatus: 'matched' | 'unmatched'; householdNameSnapshot: string | null; payerEmailSnapshot: string | null;
  providerInvoiceId: string | null; providerChargeId: string | null; receiptUrl: string | null; description: string | null;
  occurredAt: Date; lastEventId: string | null;
}>;

type Ref = string | { id: string } | null | undefined;
const toDate = (sec: number) => new Date(sec * 1000);

export function invoiceSubscriptionId(inv: Stripe.Invoice): string | null {
  return idOf(inv.parent?.subscription_details?.subscription as Ref);
}

const ANONYMIZED_LOGIN = /^deleted-.+@deleted\.rootaroo\.local$/;

/** A user that is gone (soft-deleted, or whose login was anonymised) must never leave an email in the ledger. */
async function isGoneUser(user: User | null): Promise<boolean> {
  return !user || user.deletedAt != null || ANONYMIZED_LOGIN.test(user.email ?? '');
}

async function snapshots(householdId: string | null, purchaser: { linked: boolean; userId: string | null } | null, email: string | null | undefined) {
  const household = householdId ? await Household.findByPk(householdId, { paranoid: false, attributes: ['name'] }) : null;
  let payerEmail = email ?? null;
  let userId: string | null = purchaser?.userId ?? null;
  if (purchaser?.linked) {
    const user = userId ? await User.findByPk(userId, { paranoid: false, attributes: ['id', 'email', 'deletedAt'] }) : null;
    if (await isGoneUser(user)) {
      userId = null;
      payerEmail = ANONYMIZED_EMAIL;
    } else if (!payerEmail) {
      payerEmail = user!.email;
    }
  }
  if (payerEmail && payerEmail !== ANONYMIZED_EMAIL) {
    const owner = await User.findOne({ where: { email: payerEmail }, paranoid: false, attributes: ['id', 'deletedAt'] });
    if (owner && owner.deletedAt != null) payerEmail = ANONYMIZED_EMAIL;
  }
  return { userId, householdNameSnapshot: household?.name ?? null, payerEmailSnapshot: payerEmail };
}

const UNMATCHED = (email: string | null): LedgerLink => ({
  householdId: null, userId: null, subscriptionId: null, matchStatus: 'unmatched', householdNameSnapshot: null, payerEmailSnapshot: email,
});

async function linkCustomer(customerId: string | null, livemode: boolean, email: string | null): Promise<LedgerLink | null> {
  if (!customerId) return null;
  const c = await BillingCustomer.findOne({ where: { provider: 'stripe', livemode, providerCustomerId: customerId } });
  if (!c) return null;
  return { householdId: c.householdId, subscriptionId: null, matchStatus: 'matched', ...(await snapshots(c.householdId, null, email ?? c.billingEmail)) };
}

export async function linkInvoice(inv: Stripe.Invoice, mode: BillingMode): Promise<LedgerLink> {
  const livemode = livemodeOf(mode);
  const subId = invoiceSubscriptionId(inv);
  if (subId) {
    const sub = await BillingSubscription.findOne({ where: { provider: 'stripe', livemode, providerSubscriptionId: subId } });
    if (sub) {
      return {
        householdId: sub.householdId, subscriptionId: sub.id, matchStatus: 'matched',
        ...(await snapshots(sub.householdId, { linked: true, userId: sub.purchasedByUserId }, inv.customer_email)),
      };
    }
  }
  return (await linkCustomer(idOf(inv.customer as Ref), livemode, inv.customer_email ?? null)) ?? UNMATCHED(inv.customer_email ?? null);
}

/** Store (Apple/Google) ledger rows link through the local subscription row: there is no Stripe customer. */
export async function linkSubscriptionRow(sub: BillingSubscription): Promise<LedgerLink> {
  return {
    householdId: sub.householdId, subscriptionId: sub.id, matchStatus: 'matched',
    ...(await snapshots(sub.householdId, { linked: true, userId: sub.purchasedByUserId }, null)),
  };
}

export async function fetchPaymentFees(invoiceId: string, mode: BillingMode): Promise<{ fee: number | null; net: number | null; chargeId: string; receiptUrl: string | null } | null> {
  const stripe = getStripe(mode);
  // invoice -> InvoicePayment -> payment.payment_intent -> latest_charge -> balance_transaction.
  // Expansion is limited to 4 levels, so the charge is retrieved separately.
  const payments = await stripe.invoicePayments.list({ invoice: invoiceId, limit: 10, expand: ['data.payment.payment_intent'] });
  const paid = payments.data.find((p) => p.status === 'paid');
  const pi = paid?.payment?.payment_intent;
  if (!pi || typeof pi === 'string') return null;
  const chargeId = idOf(pi.latest_charge as Ref);
  if (!chargeId) return null;
  const charge = await stripe.charges.retrieve(chargeId, { expand: ['balance_transaction'] });
  const bt = charge.balance_transaction;
  if (!bt || typeof bt === 'string') return { fee: null, net: null, chargeId, receiptUrl: charge.receipt_url ?? null };
  return { fee: bt.fee, net: bt.net, chargeId, receiptUrl: charge.receipt_url ?? null };
}

export function mergeLedgerFields(existing: BillingTransaction | null, fields: LedgerFields): LedgerFields {
  const out: LedgerFields = { ...fields };
  if (!existing) return out;
  for (const key of ['fee', 'net', 'providerChargeId', 'receiptUrl', 'disputeFee', 'providerInvoiceId'] as const) {
    if ((out[key] === null || out[key] === undefined) && existing[key] !== null && existing[key] !== undefined) {
      (out as Record<string, unknown>)[key] = existing[key];
    }
  }
  if (existing.matchStatus === 'matched' && out.matchStatus === 'matched') {
    // A later link may know less (subscription row not yet written): never blank a known link.
    for (const key of ['householdId', 'userId', 'subscriptionId'] as const) {
      if ((out[key] === null || out[key] === undefined) && existing[key]) (out as Record<string, unknown>)[key] = existing[key];
    }
  }
  if (existing.matchStatus === 'matched' && out.matchStatus === 'unmatched') {
    out.matchStatus = 'matched';
    out.householdId = existing.householdId;
    out.userId = existing.userId;
    out.subscriptionId = existing.subscriptionId;
    out.householdNameSnapshot = existing.householdNameSnapshot;
    out.payerEmailSnapshot = existing.payerEmailSnapshot;
  }
  if (existing.payerEmailSnapshot === ANONYMIZED_EMAIL) {
    out.userId = null;
    out.payerEmailSnapshot = ANONYMIZED_EMAIL;
  }
  return out;
}

export async function upsertLedgerRow(
  identity: { provider: 'stripe' | 'apple' | 'google'; livemode: boolean; type: LedgerType; providerObjectId: string },
  fields: LedgerFields,
): Promise<BillingTransaction> {
  const existing = await BillingTransaction.findOne({ where: identity });
  if (existing) return existing.update(mergeLedgerFields(existing, fields));
  try {
    return await BillingTransaction.create({ ...identity, ...fields });
  } catch (err) {
    if (!(err instanceof UniqueConstraintError)) throw err;
    const raced = (await BillingTransaction.findOne({ where: identity }))!;
    return raced.update(mergeLedgerFields(raced, fields));
  }
}

export async function recordInvoice(inv: Stripe.Invoice, mode: BillingMode, type: 'payment' | 'failed_payment', eventId: string | null): Promise<BillingTransaction> {
  const livemode = livemodeOf(mode);
  const link = await linkInvoice(inv, mode);
  let fees: Awaited<ReturnType<typeof fetchPaymentFees>> = null;
  if (type === 'payment') {
    fees = await fetchPaymentFees(inv.id!, mode).catch((err: Error) => {
      logger.warn(`[Billing] fee lookup failed for ${inv.id}: ${err.message}`);
      return null;
    });
  }
  const at = type === 'payment'
    ? inv.status_transitions?.paid_at ?? inv.created
    : inv.status_transitions?.finalized_at ?? inv.created;
  const row = await upsertLedgerRow({ provider: 'stripe', livemode, type, providerObjectId: inv.id! }, {
    status: type === 'payment' ? 'paid' : 'failed',
    billingReason: inv.billing_reason ?? null,
    amount: type === 'payment' ? inv.amount_paid : inv.amount_due,
    fee: fees?.fee ?? null,
    net: fees?.net ?? null,
    currency: inv.currency,
    ...link,
    providerInvoiceId: inv.id!,
    providerChargeId: fees?.chargeId ?? null,
    receiptUrl: fees?.receiptUrl ?? null,
    description: (inv.lines?.data?.[0]?.description ?? inv.billing_reason ?? '').slice(0, 500) || null,
    occurredAt: toDate(at),
    lastEventId: eventId,
  });
  if (row.matchStatus === 'unmatched') {
    await raiseReviewItem({ livemode, kind: 'unmatched_invoice', entityType: 'invoice', providerObjectId: inv.id!, after: { customer: idOf(inv.customer as Ref) } });
  }
  return row;
}

export async function resolvePaymentLink(paymentIntentId: string | null, chargeId: string | null, mode: BillingMode): Promise<LedgerLink & { invoiceId: string | null }> {
  const stripe = getStripe(mode);
  if (paymentIntentId) {
    const payments = await stripe.invoicePayments.list({ payment: { type: 'payment_intent', payment_intent: paymentIntentId }, limit: 1, expand: ['data.invoice'] });
    const inv = payments.data[0]?.invoice;
    if (inv && typeof inv === 'object') return { ...(await linkInvoice(inv as Stripe.Invoice, mode)), invoiceId: inv.id ?? null };
  }
  if (chargeId) {
    const charge = await stripe.charges.retrieve(chargeId);
    const link = await linkCustomer(idOf(charge.customer as Ref), livemodeOf(mode), charge.billing_details?.email ?? null);
    if (link) return { ...link, invoiceId: null };
  }
  return { ...UNMATCHED(null), invoiceId: null };
}

export async function recordRefund(refund: Stripe.Refund, mode: BillingMode, eventId: string | null): Promise<BillingTransaction> {
  const livemode = livemodeOf(mode);
  const chargeId = idOf(refund.charge as Ref);
  const { invoiceId, ...link } = await resolvePaymentLink(idOf(refund.payment_intent as Ref), chargeId, mode);
  const row = await upsertLedgerRow({ provider: 'stripe', livemode, type: 'refund', providerObjectId: refund.id }, {
    status: refund.status ?? 'pending', amount: refund.amount, currency: refund.currency, ...link,
    providerInvoiceId: invoiceId, providerChargeId: chargeId, description: refund.reason ? `refund: ${refund.reason}` : 'refund',
    occurredAt: toDate(refund.created), lastEventId: eventId,
  });
  if (row.matchStatus === 'unmatched') await raiseReviewItem({ livemode, kind: 'unmatched_refund', entityType: 'transaction', providerObjectId: refund.id });
  return row;
}

export function disputeFunds(d: Stripe.Dispute): { fundsState: FundsState; disputeFee: number } {
  const bts = (d.balance_transactions ?? []) as Array<{ amount: number; fee: number }>;
  const withdrawn = bts.some((b) => b.amount < 0);
  const reinstated = bts.some((b) => b.amount > 0);
  return {
    fundsState: !withdrawn ? 'none' : reinstated ? 'reinstated' : 'withdrawn',
    disputeFee: bts.reduce((sum, b) => sum + b.fee, 0),
  };
}

export async function recordDispute(d: Stripe.Dispute, mode: BillingMode, eventId: string | null): Promise<BillingTransaction> {
  const livemode = livemodeOf(mode);
  const chargeId = idOf(d.charge as Ref);
  const { invoiceId, ...link } = await resolvePaymentLink(idOf(d.payment_intent as Ref), chargeId, mode);
  const funds = disputeFunds(d);
  return upsertLedgerRow({ provider: 'stripe', livemode, type: 'dispute', providerObjectId: d.id }, {
    status: d.status, amount: d.amount, currency: d.currency, disputeFee: funds.disputeFee, fundsState: funds.fundsState, ...link,
    providerInvoiceId: invoiceId, providerChargeId: chargeId, description: `dispute: ${d.reason}`, occurredAt: toDate(d.created), lastEventId: eventId,
  });
}

export async function anonymizeUserLedger(userId: string, email?: string | null): Promise<number> {
  const where = email ? { [Op.or]: [{ userId }, { payerEmailSnapshot: email }] } : { userId };
  const [count] = await BillingTransaction.update({ userId: null, payerEmailSnapshot: ANONYMIZED_EMAIL }, { where });
  return count;
}
