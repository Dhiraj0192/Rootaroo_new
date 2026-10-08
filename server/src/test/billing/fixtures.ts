import Stripe from 'stripe';
import { LAUNCH_FORMULA, LAUNCH_PRICE_SET, PriceFormula, amountFor, lookupKey, SEAT_SIZES, INTERVALS } from '../../modules/billing/catalog';
import type { BillingInterval } from '../../modules/billing/types';

let n = 0;
const nextId = (prefix: string) => `${prefix}_${String(++n).padStart(8, '0')}`;
const nowSec = () => Math.floor(Date.now() / 1000);

export function stripePrice(o: Partial<{ id: string; seats: number; interval: BillingInterval; priceSet: string; amount: number; active: boolean; lookupKey: string | null }> = {}): Stripe.Price {
  const seats = o.seats ?? 5;
  const interval = o.interval ?? 'month';
  return {
    id: o.id ?? nextId('price'),
    object: 'price',
    active: o.active ?? true,
    currency: 'usd',
    unit_amount: o.amount ?? amountFor(LAUNCH_FORMULA, interval, seats),
    recurring: { interval, interval_count: 1 },
    lookup_key: o.lookupKey === undefined ? lookupKey(interval, seats) : o.lookupKey,
    metadata: { price_set: o.priceSet ?? LAUNCH_PRICE_SET, seats: String(seats), interval },
    product: `prod_hh${seats}`,
    livemode: false,
  } as unknown as Stripe.Price;
}

export function catalogPrices(priceSet = LAUNCH_PRICE_SET, formula: PriceFormula = LAUNCH_FORMULA): Stripe.Price[] {
  return INTERVALS.flatMap((interval) => SEAT_SIZES.map((seats) => stripePrice({
    id: `price_${priceSet.replace('-', '')}_${seats}_${interval}`, seats, interval, priceSet, amount: amountFor(formula, interval, seats),
  })));
}

export function stripeInvoice(o: Partial<{
  id: string; customer: string; subscriptionId: string | null; subscriptionEnv: string; status: Stripe.Invoice.Status;
  billingReason: string; amountPaid: number; amountDue: number; created: number; finalizedAt: number | null; paidAt: number | null;
  hostedInvoiceUrl: string; livemode: boolean; customerEmail: string | null; attempted: boolean;
}> = {}): Stripe.Invoice {
  const created = o.created ?? nowSec();
  const subId = o.subscriptionId === undefined ? 'sub_default' : o.subscriptionId;
  return {
    id: o.id ?? nextId('in'),
    object: 'invoice',
    customer: o.customer ?? 'cus_default',
    customer_email: o.customerEmail === undefined ? 'payer@example.test' : o.customerEmail,
    status: o.status ?? 'paid',
    billing_reason: o.billingReason ?? 'subscription_create',
    amount_paid: o.amountPaid ?? 899,
    amount_due: o.amountDue ?? 899,
    currency: 'usd',
    created,
    attempted: o.attempted ?? true,
    livemode: o.livemode ?? false,
    hosted_invoice_url: o.hostedInvoiceUrl ?? 'https://invoice.stripe.com/i/test',
    status_transitions: { finalized_at: o.finalizedAt === undefined ? created : o.finalizedAt, paid_at: o.paidAt === undefined ? created : o.paidAt },
    parent: subId ? { type: 'subscription_details', subscription_details: { subscription: subId, metadata: { env: o.subscriptionEnv ?? 'dev' } } } : null,
    lines: { data: [{ description: '1 × Rootaroo Household: 5 members' }] },
  } as unknown as Stripe.Invoice;
}

export function stripeSubscription(o: Partial<{
  id: string; customer: string; status: Stripe.Subscription.Status; seats: number; interval: BillingInterval; priceSet: string;
  amount: number; priceId: string; householdId: string; purchasedByUserId: string; env: string; created: number;
  periodStart: number; periodEnd: number; cancelAtPeriodEnd: boolean; canceledAt: number | null; endedAt: number | null;
  latestInvoice: Stripe.Invoice | string | null; pendingUpdate: Record<string, unknown> | null; livemode: boolean; itemId: string;
}> = {}): Stripe.Subscription {
  const seats = o.seats ?? 5;
  const interval = o.interval ?? 'month';
  const start = o.periodStart ?? nowSec();
  const end = o.periodEnd ?? start + (interval === 'month' ? 30 : 365) * 86400;
  const price = stripePrice({ id: o.priceId, seats, interval, priceSet: o.priceSet, amount: o.amount });
  return {
    id: o.id ?? nextId('sub'),
    object: 'subscription',
    customer: o.customer ?? 'cus_default',
    status: o.status ?? 'active',
    created: o.created ?? start,
    livemode: o.livemode ?? false,
    cancel_at_period_end: o.cancelAtPeriodEnd ?? false,
    canceled_at: o.canceledAt ?? null,
    ended_at: o.endedAt ?? null,
    pending_update: o.pendingUpdate ?? null,
    latest_invoice: o.latestInvoice === undefined ? stripeInvoice({ customer: o.customer, created: start }) : o.latestInvoice,
    metadata: {
      ...(o.householdId ? { householdId: o.householdId } : {}),
      ...(o.purchasedByUserId ? { purchasedByUserId: o.purchasedByUserId } : {}),
      env: o.env ?? 'dev',
    },
    items: { object: 'list', data: [{ id: o.itemId ?? nextId('si'), price, quantity: 1, current_period_start: start, current_period_end: end }] },
  } as unknown as Stripe.Subscription;
}

export function stripeCheckoutSession(o: Partial<{
  id: string; status: Stripe.Checkout.Session.Status; paymentStatus: Stripe.Checkout.Session.PaymentStatus; customer: string;
  clientReferenceId: string; subscription: string | Stripe.Subscription | null; url: string; livemode: boolean; env: string;
}> = {}): Stripe.Checkout.Session {
  const livemode = o.livemode ?? false;
  return {
    id: o.id ?? `cs_${livemode ? 'live' : 'test'}_${String(++n).padStart(10, '0')}`,
    object: 'checkout.session',
    status: o.status ?? 'open',
    payment_status: o.paymentStatus ?? 'unpaid',
    customer: o.customer ?? 'cus_default',
    client_reference_id: o.clientReferenceId ?? null,
    subscription: o.subscription ?? null,
    url: o.url ?? 'https://checkout.stripe.com/c/pay/test',
    livemode,
    metadata: { env: o.env ?? 'dev' },
  } as unknown as Stripe.Checkout.Session;
}

export function stripeRefund(o: Partial<{ id: string; amount: number; status: string; paymentIntent: string | null; charge: string | null; created: number }> = {}): Stripe.Refund {
  return {
    id: o.id ?? nextId('re'), object: 'refund', amount: o.amount ?? 899, currency: 'usd', status: o.status ?? 'succeeded',
    payment_intent: o.paymentIntent === undefined ? 'pi_default' : o.paymentIntent,
    charge: o.charge === undefined ? 'ch_default' : o.charge, created: o.created ?? nowSec(), metadata: {},
  } as unknown as Stripe.Refund;
}

export function stripeDispute(o: Partial<{
  id: string; amount: number; status: Stripe.Dispute.Status; paymentIntent: string | null; charge: string; created: number;
  balanceTransactions: Array<{ amount: number; fee: number }>;
}> = {}): Stripe.Dispute {
  return {
    id: o.id ?? nextId('dp'), object: 'dispute', amount: o.amount ?? 899, currency: 'usd', status: o.status ?? 'needs_response',
    payment_intent: o.paymentIntent === undefined ? 'pi_default' : o.paymentIntent, charge: o.charge ?? 'ch_default',
    created: o.created ?? nowSec(), reason: 'fraudulent',
    balance_transactions: (o.balanceTransactions ?? []).map((bt, i) => ({ id: `txn_${i}`, ...bt })),
  } as unknown as Stripe.Dispute;
}

export function stripeEvent(type: string, object: unknown, o: Partial<{ id: string; livemode: boolean; created: number }> = {}): Stripe.Event {
  return {
    id: o.id ?? nextId('evt'), object: 'event', type, livemode: o.livemode ?? false, created: o.created ?? nowSec(),
    api_version: '2026-09-30.endive', data: { object }, pending_webhooks: 1, request: { id: null, idempotency_key: null },
  } as unknown as Stripe.Event;
}
