/* eslint-disable no-console */
/**
 * Wave 10 lifecycle scenarios that need no hosted Checkout page (E5-E9, E10, E11-E15).
 * Usage (from server/, env loaded):  npx tsx scripts/e2e/lifecycle.ts [E5 E6 ...]
 * Subscriptions are created directly in Stripe on a test clock; our webhook, worker and
 * upsertSubscription path (via the stripe CLI listener) does everything else.
 */
import { spawn, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import type Stripe from 'stripe';
import { BillingCustomer, BillingSubscription, BillingTransaction, Household, NotificationHistory } from '../../src/database/models';
import { getCatalog, priceFor } from '../../src/modules/billing/catalog';
import { computeEntitlement } from '../../src/modules/billing/entitlement';
import { resolveMode } from '../../src/modules/billing/mode';
import {
  Household_, Scenario, adminGet, adminSend, call, closeAll, dbSnapshot, guardedStatus, planChange, seedHousehold, serverLogContains,
  sleep, status, stripe, waitFor, EVIDENCE_DIR,
} from './harness';

const ENV_TAG = process.env.BILLING_ENV_TAG || 'dev';
const DAY = 86400;
const nowSec = () => Math.floor(Date.now() / 1000);

// ── Stripe helpers ──
interface Ctx { h: Household_; clockId: string; customerId: string; subId: string; interval: 'month' | 'year'; seats: number }

function monthsBack(ts: number, months: number): number {
  const d = new Date(ts * 1000);
  d.setUTCMonth(d.getUTCMonth() - months);
  return Math.floor(d.getTime() / 1000);
}

async function priceIdFor(interval: 'month' | 'year', seats: number): Promise<string> {
  return priceFor(await getCatalog('test'), interval, seats).priceId;
}

async function setDefaultCard(customerId: string, pm: string): Promise<void> {
  const attached = await stripe().paymentMethods.attach(pm, { customer: customerId });
  await stripe().customers.update(customerId, { invoice_settings: { default_payment_method: attached.id } });
}

async function waitSub(h: Household_, pred: (s: BillingSubscription) => boolean, label: string, timeoutMs = 90_000): Promise<BillingSubscription> {
  return waitFor(async () => {
    const s = await BillingSubscription.findOne({ where: { householdId: h.householdId }, order: [['createdAt', 'DESC']] });
    return s && pred(s) ? s : false;
  }, timeoutMs, 1500, label);
}

async function waitTxn(h: Household_, where: Record<string, unknown>, label: string, timeoutMs = 90_000): Promise<BillingTransaction> {
  return waitFor(() => BillingTransaction.findOne({ where: { householdId: h.householdId, ...where } }), timeoutMs, 1500, label);
}

async function advanceClock(clockId: string, to: number): Promise<void> {
  await stripe().testHelpers.testClocks.advance(clockId, { frozen_time: to });
  await waitFor(async () => (await stripe().testHelpers.testClocks.retrieve(clockId)).status === 'ready', 240_000, 2000, 'test clock ready');
}

/** Household via the API + Stripe customer on a test clock + subscription; the webhook path creates our rows. */
async function makeSub(label: string, opts: { startTs?: number; interval?: 'month' | 'year'; seats?: number; card?: string; waitActive?: boolean; noClock?: boolean } = {}): Promise<Ctx> {
  const interval = opts.interval ?? 'month';
  const seats = opts.seats ?? 5;
  const h = await seedHousehold(label);
  // Objects attached to a test clock are hidden from account-wide list calls, so scenarios that exercise
  // reconciliation discovery (E11, E12) use noClock: real-time objects, listed like production ones.
  const clock = opts.noClock ? null : await stripe().testHelpers.testClocks.create({ frozen_time: opts.startTs ?? nowSec(), name: `e2e-${label}-${Date.now()}` });
  const customer = await stripe().customers.create({
    email: h.email, name: h.name, ...(clock ? { test_clock: clock.id } : {}), metadata: { householdId: h.householdId, env: ENV_TAG },
  });
  await BillingCustomer.create({ householdId: h.householdId, provider: 'stripe', livemode: false, providerCustomerId: customer.id, billingEmail: h.email });
  await setDefaultCard(customer.id, opts.card ?? 'pm_card_visa');
  const sub = await stripe().subscriptions.create({
    customer: customer.id, items: [{ price: await priceIdFor(interval, seats) }],
    metadata: { householdId: h.householdId, purchasedByUserId: h.userId, env: ENV_TAG },
  });
  if (opts.waitActive !== false) await waitSub(h, (s) => s.status === 'active', `${label} subscription active`);
  return { h, clockId: clock?.id ?? '', customerId: customer.id, subId: sub.id, interval, seats };
}

async function entitlementOf(h: Household_) {
  const r = await status(h);
  return { http: r.status, ent: r.json?.data?.entitlement, sub: r.json?.data?.subscription };
}

async function renewalInvoice(customerId: string): Promise<Stripe.Invoice> {
  const list = await stripe().invoices.list({ customer: customerId, limit: 10 });
  const inv = list.data.find((i) => i.billing_reason === 'subscription_cycle');
  if (!inv) throw new Error('no renewal invoice');
  return inv;
}

async function runReconcile(): Promise<any> {
  const r = await adminSend('POST', '/reconciliation/run', { mode: 'test' });
  return r;
}

// ── E5 ──
async function E5(): Promise<void> {
  const s = new Scenario('E5', 'Renewal fails, grace, blocked, recovery (test clock)');
  // Part A: renewal two days ago, so grace (7 days) is still running now.
  const a = await makeSub('E5grace', { startTs: monthsBack(nowSec() - 2 * DAY, 1) });
  s.check('A: initially active and allowed', (await entitlementOf(a.h)).ent?.reason === 'active');
  await setDefaultCard(a.customerId, 'pm_card_chargeCustomerFail');
  const subA = await stripe().subscriptions.retrieve(a.subId);
  const periodEndA = subA.items.data[0].current_period_end;
  await advanceClock(a.clockId, periodEndA + 3 * 3600);
  const rowA = await waitSub(a.h, (x) => x.status === 'past_due' && !!x.graceUntil, 'A past_due', 120_000);
  const invA = await renewalInvoice(a.customerId);
  const expectA = (invA.status_transitions.finalized_at as number) + 7 * DAY;
  s.check('A: past_due with grace_until = invoice finalized + 7 days', Math.floor(rowA.graceUntil!.getTime() / 1000) === expectA, { got: rowA.graceUntil, expect: new Date(expectA * 1000) });
  const entA = await entitlementOf(a.h);
  s.check('A: allowed during grace (reason grace, guarded route not 402)', entA.ent?.allowed === true && entA.ent?.reason === 'grace' && (await guardedStatus(a.h)) !== 402, entA.ent);
  s.put('A', { entitlement: entA.ent, graceUntil: rowA.graceUntil, finalizedAt: invA.status_transitions.finalized_at });

  // Part B: renewal 14 days ago, so grace has already ended in real time.
  const b = await makeSub('E5blocked', { startTs: monthsBack(nowSec() - 14 * DAY, 1) });
  await setDefaultCard(b.customerId, 'pm_card_chargeCustomerFail');
  const subB = await stripe().subscriptions.retrieve(b.subId);
  await advanceClock(b.clockId, subB.items.data[0].current_period_end + 3 * 3600);
  const rowB = await waitSub(b.h, (x) => x.status === 'past_due' && !!x.graceUntil, 'B past_due', 120_000);
  const invB = await renewalInvoice(b.customerId);
  s.check('B: grace_until = invoice finalized + 7 days', Math.floor(rowB.graceUntil!.getTime() / 1000) === (invB.status_transitions.finalized_at as number) + 7 * DAY);
  s.check('B: grace_until is in the past in real time', rowB.graceUntil!.getTime() < Date.now(), rowB.graceUntil);
  const entB = await entitlementOf(b.h);
  s.check('B: blocked after grace (allowed=false, guarded route 402)', entB.ent?.allowed === false && (await guardedStatus(b.h)) === 402, entB.ent);
  s.put('B_blocked', { entitlement: entB.ent, graceUntil: rowB.graceUntil });

  // Recovery: new card, pay the open invoice.
  await setDefaultCard(b.customerId, 'pm_card_visa');
  await stripe().invoices.pay(invB.id!);
  const back = await waitSub(b.h, (x) => x.status === 'active', 'B active again', 120_000);
  const entB2 = await entitlementOf(b.h);
  s.check('B: restored after payment method update and invoice pay', back.status === 'active' && back.graceUntil === null && entB2.ent?.allowed === true && (await guardedStatus(b.h)) !== 402, entB2.ent);
  s.check('B: renewal payment in the ledger', !!(await waitTxn(b.h, { type: 'payment', billingReason: 'subscription_cycle' }, 'renewal payment row')));
  s.check('B: failed_payment row recorded', !!(await BillingTransaction.findOne({ where: { householdId: b.h.householdId, type: 'failed_payment' } })));
  s.put('B_recovered', { entitlement: entB2.ent, snapshot: await dbSnapshot(b.h.householdId) });
  s.put('A_snapshot', await dbSnapshot(a.h.householdId));
  s.finish();
}

// ── E6 ──
async function E6(): Promise<void> {
  const s = new Scenario('E6', 'Seat increase 5 to 7 and interval month to year');
  const c = await makeSub('E6');
  const before = await BillingSubscription.findOne({ where: { householdId: c.h.householdId } });
  s.check('starts at 5 seats, version 0', before!.seats === 5 && before!.planChangeVersion === 0);
  const r1 = await planChange(c.h, 'month', 7);
  s.check('seat change accepted and applied (not pending)', r1.status === 200 && r1.json.data.changed === true && r1.json.data.pendingUpdate === false, r1.json);
  const afterSeats = await waitSub(c.h, (x) => x.seats === 7, 'seats 7');
  s.check('seats 7 after payment, plan_change_version 1', afterSeats.seats === 7 && afterSeats.planChangeVersion === 1, { v: afterSeats.planChangeVersion });
  const prorationPaid = await waitTxn(c.h, { type: 'payment', billingReason: 'subscription_update' }, 'proration payment row');
  s.check('proration invoice paid (ledger payment, subscription_update)', prorationPaid.amount > 0, { amount: prorationPaid.amount });
  const r2 = await planChange(c.h, 'year', 7);
  s.check('interval change accepted', r2.status === 200 && r2.json.data.changed === true, r2.json);
  const year = await waitSub(c.h, (x) => x.interval === 'year', 'interval year');
  s.check('year plan rootaroo_hh7_year = 12775, seats 7, version 2', year.unitAmount === 12775 && year.seats === 7 && year.planChangeVersion === 2, { unit: year.unitAmount, v: year.planChangeVersion });
  const st = await entitlementOf(c.h);
  s.check('entitlement allowed with 7 seats', st.ent?.allowed === true && st.ent?.seatsAllowed === 7, st.ent);
  const noop = await planChange(c.h, 'year', 7);
  s.check('repeat of the same plan is a no-op', noop.json?.data?.changed === false, noop.json);
  s.put('snapshot', await dbSnapshot(c.h.householdId));
  s.finish();
}

// ── E7 ──
async function E7(): Promise<void> {
  const s = new Scenario('E7', 'Failed upgrade leaves pending_update; it expires; admin notified');
  const c = await makeSub('E7');
  await setDefaultCard(c.customerId, 'pm_card_chargeCustomerFail');
  const r = await planChange(c.h, 'month', 7);
  s.check('plan change returns pendingUpdate', r.status === 200 && r.json.data.pendingUpdate === true, r.json?.data && { ...r.json.data, hostedInvoiceUrl: !!r.json.data.hostedInvoiceUrl });
  const row = await waitSub(c.h, (x) => x.pendingUpdate !== null, 'pending_update stored');
  s.check('seats unchanged (5) while the payment is outstanding', row.seats === 5, { seats: row.seats });
  const second = await planChange(c.h, 'month', 8);
  s.check('second change refused with PLAN_CHANGE_PENDING (409)', second.status === 409 && JSON.stringify(second.json).includes('PLAN_CHANGE_PENDING'), { status: second.status });
  const stripeSub = await stripe().subscriptions.retrieve(c.subId);
  const expiresAt = (stripeSub.pending_update as any)?.expires_at as number;
  s.check('Stripe holds a pending_update with an expiry', typeof expiresAt === 'number');
  await advanceClock(c.clockId, expiresAt + 3600);
  const cleared = await waitSub(c.h, (x) => x.pendingUpdate === null, 'pending_update cleared', 120_000);
  s.check('after expiry: seats still 5, pending_update cleared', cleared.seats === 5);
  const note = await waitFor(() => NotificationHistory.findOne({ where: { userId: c.h.userId, type: 'billing_plan_change_failed' } }), 90_000, 2000, 'plan-change-failed notification');
  s.check('admin notified (billing_plan_change_failed)', !!note, { title: note?.title });
  s.put('snapshot', await dbSnapshot(c.h.householdId));

  // Part B: the same failure, then paying the invoice applies the change.
  const d = await makeSub('E7pay');
  await setDefaultCard(d.customerId, 'pm_card_chargeCustomerFail');
  const rb = await planChange(d.h, 'month', 6);
  await waitSub(d.h, (x) => x.pendingUpdate !== null, 'B pending');
  await setDefaultCard(d.customerId, 'pm_card_visa');
  const latest = (await stripe().subscriptions.retrieve(d.subId)).latest_invoice;
  await stripe().invoices.pay(typeof latest === 'string' ? latest : latest!.id!);
  const applied = await waitSub(d.h, (x) => x.seats === 6 && x.pendingUpdate === null, 'B change applied after payment', 120_000);
  s.check('B: seats move to 6 only after the invoice is paid', applied.seats === 6 && rb.json.data.pendingUpdate === true);
  s.finish();
}

// ── E8 ──
async function E8(): Promise<void> {
  const s = new Scenario('E8', 'Cancel at period end (portal equivalent), access until the end, blocked after');
  const c = await makeSub('E8');
  await stripe().subscriptions.update(c.subId, { cancel_at_period_end: true });
  const row = await waitSub(c.h, (x) => x.cancelAtPeriodEnd, 'cancel flag');
  const ent = await entitlementOf(c.h);
  s.check('cancel_at_period_end stored, still allowed (reason active)', row.cancelAtPeriodEnd && ent.ent?.allowed === true && ent.sub?.cancelAtPeriodEnd === true, ent.ent);
  const periodEnd = (await stripe().subscriptions.retrieve(c.subId)).items.data[0].current_period_end;
  await advanceClock(c.clockId, periodEnd + 3600);
  const ended = await waitSub(c.h, (x) => x.status === 'canceled', 'canceled', 120_000);
  const ent2 = await entitlementOf(c.h);
  s.check('after the period end: canceled, blocked (402)', ended.status === 'canceled' && ent2.ent?.allowed === false && (await guardedStatus(c.h)) === 402, ent2.ent);
  s.put('snapshot', await dbSnapshot(c.h.householdId));
  s.finish();
}

// ── E9 ──
async function paymentIntentOf(invoiceId: string): Promise<string> {
  const pays = await stripe().invoicePayments.list({ invoice: invoiceId, limit: 5, expand: ['data.payment.payment_intent'] });
  const p = pays.data.find((x) => x.status === 'paid');
  const pi = p?.payment?.payment_intent;
  const id = typeof pi === 'string' ? pi : pi?.id;
  if (!id) throw new Error('no payment intent for invoice');
  return id;
}

async function E9(): Promise<void> {
  const s = new Scenario('E9', 'Partial and full refund');
  const sumBefore = (await adminGet(`/summary?mode=test&from=2020-01-01&to=2031-01-01`)).json.data;
  const c = await makeSub('E9');
  const pay = await waitTxn(c.h, { type: 'payment' }, 'payment row');
  const pi = await paymentIntentOf(pay.providerInvoiceId!);
  await stripe().refunds.create({ payment_intent: pi, amount: 300 });
  const part = await waitTxn(c.h, { type: 'refund' }, 'partial refund row');
  s.check('partial refund row: amount 300, status succeeded, positive', part.amount === 300 && part.status === 'succeeded', { amount: part.amount, status: part.status });
  await stripe().refunds.create({ payment_intent: pi, amount: pay.amount - 300 });
  await waitFor(async () => (await BillingTransaction.count({ where: { householdId: c.h.householdId, type: 'refund', status: 'succeeded' } })) === 2, 90_000, 1500, 'two refund rows');
  const refunds = await BillingTransaction.findAll({ where: { householdId: c.h.householdId, type: 'refund' } });
  s.check('refunds total the payment (full refund)', refunds.reduce((a, r) => a + r.amount, 0) === pay.amount, refunds.map((r) => r.amount));
  s.check('refund rows are matched to the household', refunds.every((r) => r.householdId === c.h.householdId && r.matchStatus === 'matched'));
  // fee/net: now or after reconcile
  let fresh = await BillingTransaction.findByPk(pay.id);
  if (fresh!.fee === null) { await runReconcile(); fresh = await BillingTransaction.findByPk(pay.id); }
  const sumAfter = (await adminGet(`/summary?mode=test&from=2020-01-01&to=2031-01-01`)).json.data;
  const dGross = sumAfter.gross - sumBefore.gross;
  const dRef = sumAfter.refunds - sumBefore.refunds;
  s.check('summary: gross +payment, refunds +payment, net moved by -fee', dGross === pay.amount && dRef === pay.amount && sumAfter.net - sumBefore.net === -(fresh!.fee ?? 0), { dGross, dRef, net: sumAfter.net - sumBefore.net, fee: fresh!.fee });
  s.put('summary', { before: sumBefore, after: sumAfter });
  s.put('snapshot', await dbSnapshot(c.h.householdId));
  s.finish();
}

// ── E10 ──
async function E10(): Promise<void> {
  const s = new Scenario('E10', 'Dispute (card 4000 0000 0000 0259 via pm_card_createDispute)');
  const c = await makeSub('E10', { card: 'pm_card_createDispute' });
  const dispute = await waitTxn(c.h, { type: 'dispute' }, 'dispute row', 120_000);
  s.check('ledger dispute row (positive amount, matched household)', dispute.amount > 0 && dispute.householdId === c.h.householdId, { amount: dispute.amount, status: dispute.status, funds: dispute.fundsState });
  const items = await waitFor(async () => {
    const r = (await adminGet(`/reconciliation/items?mode=test&status=needs_review&limit=200`)).json;
    const m = (r.data as any[]).filter((i) => i.kind === 'dispute_opened' && i.providerObjectId === dispute.providerObjectId);
    return m.length ? m : false;
  }, 60_000, 2000, 'dispute review item');
  s.check('review item dispute_opened raised', items.length >= 1);
  const alerted = serverLogContains('Dispute opened');
  s.check('staff alert recorded (server log, mailer unconfigured in dev)', alerted || !process.env.E2E_SERVER_LOG, { checkedLog: !!process.env.E2E_SERVER_LOG });
  s.check('payment ledger row exists alongside the dispute (events may arrive out of order)', !!(await waitTxn(c.h, { type: 'payment' }, 'payment row', 60_000)));
  s.put('snapshot', await dbSnapshot(c.h.householdId));
  s.finish();
}

// ── E11 ──
const LISTEN_ARGS = [
  'listen', '--latest', '--events',
  'customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,customer.subscription.pending_update_applied,customer.subscription.pending_update_expired,invoice.paid,invoice.payment_failed,invoice.payment_action_required,checkout.session.completed,checkout.session.expired,refund.created,refund.updated,refund.failed,charge.dispute.created,charge.dispute.updated,charge.dispute.funds_withdrawn,charge.dispute.funds_reinstated,charge.dispute.closed,customer.updated',
  '--forward-to', 'localhost:3000/api/v1/billing/webhooks/stripe/test',
];
function stopListener(): void { try { execSync('taskkill /IM stripe.exe /F', { stdio: 'ignore' }); } catch { /* none running */ } }
function startListener(): void {
  const log = fs.openSync(process.env.E2E_LISTENER_LOG || path.join(process.env.TEMP || '.', 'e2e-listen.log'), 'a');
  const child = spawn('stripe', LISTEN_ARGS, { detached: true, shell: true, windowsHide: true, stdio: ['ignore', log, log], env: { ...process.env, STRIPE_API_KEY: process.env.STRIPE_TEST_SECRET_KEY } });
  child.on('error', (err) => console.error('listener spawn failed', err.message));
  child.unref();
}

async function E11(): Promise<void> {
  const s = new Scenario('E11', 'Missed webhook repaired by reconciliation');
  stopListener();
  await sleep(2000);
  const c = await makeSub('E11', { waitActive: false, noClock: true });
  await sleep(15_000);
  const missing = await BillingSubscription.findOne({ where: { householdId: c.h.householdId } });
  s.check('listener stopped: no local subscription row, still 402', missing === null && (await guardedStatus(c.h)) === 402);
  startListener();
  await sleep(6000);
  const r = await runReconcile();
  s.check('manual reconciliation run accepted', r.status === 200 || r.status === 201, { status: r.status });
  const fixed = await waitSub(c.h, (x) => x.status === 'active', 'subscription repaired', 60_000);
  s.check('subscription row created by reconcile; entitlement restored', fixed.status === 'active' && (await guardedStatus(c.h)) !== 402);
  const pay = await waitTxn(c.h, { type: 'payment' }, 'payment row via reconcile', 60_000);
  s.check('ledger payment row recovered', !!pay);
  const runs = (await adminGet('/reconciliation/runs?mode=test&limit=3')).json;
  s.check('reconciliation run row recorded (succeeded)', runs.data?.[0]?.status === 'succeeded', runs.data?.[0]);
  s.put('run', runs.data?.[0]);
  s.put('snapshot', await dbSnapshot(c.h.householdId));
  s.finish();
}

// ── E12 ──
async function E12(): Promise<void> {
  const s = new Scenario('E12', 'Planted drift repaired by reconciliation');
  const c = await makeSub('E12', { noClock: true });
  // Let the creation events (invoice.paid, subscription.created...) drain, or a late webhook would repair the drift before reconcile does.
  await waitTxn(c.h, { type: 'payment' }, 'payment row');
  await sleep(10_000);
  await BillingSubscription.update({ status: 'canceled', seats: 9, cancelAtPeriodEnd: true }, { where: { householdId: c.h.householdId } });
  s.check('drift planted: blocked locally', (await BillingSubscription.findOne({ where: { householdId: c.h.householdId } }))!.status === 'canceled');
  const r = await runReconcile();
  s.check('reconciliation run accepted', r.status === 200 || r.status === 201, { status: r.status });
  const row = await waitSub(c.h, (x) => x.status === 'active' && x.seats === 5 && !x.cancelAtPeriodEnd, 'drift repaired', 60_000);
  s.check('status, seats and cancel flag restored from Stripe', row.status === 'active' && row.seats === 5 && row.cancelAtPeriodEnd === false);
  const items = (await adminGet('/reconciliation/items?mode=test&status=auto_fixed&limit=200')).json.data as any[];
  const mine = items.filter((i) => i.kind === 'subscription_drift' && i.providerObjectId === c.subId);
  s.check('auto_fixed subscription_drift item lists the changed fields', mine.length >= 1 && ['status', 'seats', 'cancelAtPeriodEnd'].every((f) => f in (mine[0].before ?? {})), mine[0]);
  s.put('item', mine[0]);
  s.put('snapshot', await dbSnapshot(c.h.householdId));
  s.finish();
}

// ── E13 ──
async function E13(): Promise<void> {
  const s = new Scenario('E13', 'Test cohort bypass and mode isolation');
  const h = await seedHousehold('E13');
  s.check('live cohort, no subscription: 402', (await guardedStatus(h)) === 402);
  const r = await adminSend('POST', `/households/${h.householdId}/cohort`, { cohort: 'test', reason: 'e2e cohort bypass check' });
  s.check('admin cohort API switches to test', r.status === 200 && r.json.data.to === 'test', r.json);
  const ent = await entitlementOf(h);
  s.check('test cohort allowed with no subscription (reason test_cohort, seats 10)', ent.ent?.allowed === true && ent.ent?.reason === 'test_cohort' && ent.ent?.seatsAllowed === 10 && (await guardedStatus(h)) !== 402, ent.ent);
  const back = await adminSend('POST', `/households/${h.householdId}/cohort`, { cohort: 'live', reason: 'e2e revert' });
  s.check('back to live: 402 again', back.status === 200 && (await guardedStatus(h)) === 402);

  // Mode isolation. In a non-production server every household resolves to test mode; in production a live-cohort
  // household resolves to live, where a test-mode subscription (livemode = false) is not even loaded.
  const c = await makeSub('E13sub');
  const hh = await Household.findByPk(c.h.householdId);
  const prodMode = resolveMode({ billingCohort: hh!.billingCohort }, 'production');
  s.check('production resolves a live-cohort household to live mode', prodMode === 'live');
  const liveRows = await BillingSubscription.findAll({ where: { householdId: c.h.householdId, livemode: true } });
  const snapshots = liveRows.map((x) => ({ id: x.id, provider: x.provider, status: x.status, seats: x.seats, interval: x.interval, currentPeriodEnd: x.currentPeriodEnd?.toISOString() ?? null, cancelAtPeriodEnd: x.cancelAtPeriodEnd, createdAt: x.createdAt }));
  const prodEnt = computeEntitlement({ cohort: hh!.billingCohort, mode: prodMode, subscriptions: snapshots as any, now: new Date() });
  s.check('a test subscription does not unlock the household in live mode (no livemode=true rows, blocked)', liveRows.length === 0 && prodEnt.allowed === false, prodEnt);
  const devEnt = await entitlementOf(c.h);
  s.check('in this dev server (test mode) the same subscription does unlock it', devEnt.ent?.allowed === true && devEnt.ent?.mode === 'test', devEnt.ent);
  const cross = await adminGet(`/subscriptions?mode=live&limit=200`);
  s.check('staff API in live mode does not list the test subscription', !(cross.json.data as any[]).some((x) => x.householdId === c.h.householdId));
  s.finish();
}

// ── E14 ──
async function E14(): Promise<void> {
  const s = new Scenario('E14', 'Duplicate subscriptions resolved (API route)');
  const c = await makeSub('E14');
  const keeperSub = await BillingSubscription.findOne({ where: { householdId: c.h.householdId } });
  await sleep(2000);
  const dup = await stripe().subscriptions.create({
    customer: c.customerId, items: [{ price: await priceIdFor('month', 5) }],
    metadata: { householdId: c.h.householdId, purchasedByUserId: c.h.userId, env: ENV_TAG },
  });
  const resolved = await waitFor(async () => {
    const rows = await BillingSubscription.findAll({ where: { householdId: c.h.householdId } });
    return rows.length === 2 && rows.some((r) => r.status === 'canceled') ? rows : false;
  }, 120_000, 2000, 'duplicate resolved');
  const kept = resolved.find((r) => r.status === 'active');
  const cancelled = resolved.find((r) => r.status === 'canceled');
  s.check('healthy (older) subscription kept, the other cancelled', kept?.providerSubscriptionId === c.subId && cancelled?.providerSubscriptionId === dup.id, { kept: kept?.providerSubscriptionId, cancelled: cancelled?.providerSubscriptionId });
  const refund = await waitTxn(c.h, { type: 'refund' }, 'overlap refund row', 90_000);
  const payments = await BillingTransaction.findAll({ where: { householdId: c.h.householdId, type: 'payment' } });
  s.check('overlap refunded: one refund equal to the duplicate payment, original payment untouched', payments.length === 2 && payments.some((p) => p.amount === refund.amount), { refund: refund.amount, payments: payments.map((p) => p.amount) });
  const items = (await adminGet('/reconciliation/items?mode=test&status=needs_review&limit=200')).json.data as any[];
  s.check('review item duplicate_subscription raised', items.some((i) => i.kind === 'duplicate_subscription' && i.entityId === c.h.householdId));
  s.check('household still entitled', (await entitlementOf(c.h)).ent?.allowed === true);
  s.check('keeper row unchanged id', keeperSub!.providerSubscriptionId === c.subId);
  s.put('snapshot', await dbSnapshot(c.h.householdId));
  s.finish();
}

// ── E15 ──
function parseCsv(text: string): string[][] { return text.trim().split(/\r?\n/).map((l) => l.split(',')); }

async function E15(): Promise<void> {
  const s = new Scenario('E15', 'Staff API: filters, CSV, summary arithmetic, review resolve, event replay');
  const c = await makeSub('E15');
  const pay = await waitTxn(c.h, { type: 'payment' }, 'payment');
  const pi = await paymentIntentOf(pay.providerInvoiceId!);
  await stripe().refunds.create({ payment_intent: pi, amount: 200 });
  await waitTxn(c.h, { type: 'refund' }, 'refund');
  const ping = await adminGet('/ping');
  s.check('billing admin key accepted', ping.status === 200);
  const noKey = await fetch(`${process.env.E2E_BASE_URL || 'http://localhost:3000'}/api/v1/billing-admin/ping`);
  s.check('missing key rejected (401)', noKey.status === 401);
  const byHh = (await adminGet(`/transactions?mode=test&householdId=${c.h.householdId}`)).json;
  s.check('transactions filtered by household: payment + refund only', byHh.data.length === 2 && byHh.data.every((t: any) => t.householdId === c.h.householdId), byHh.data.map((t: any) => t.type));
  const byUser = (await adminGet(`/transactions?mode=test&userId=${c.h.userId}`)).json;
  s.check('transactions filtered by user', byUser.data.length === 2);
  const byType = (await adminGet(`/transactions?mode=test&householdId=${c.h.householdId}&type=refund`)).json;
  s.check('type filter', byType.data.length === 1 && byType.data[0].amount === 200);
  const csvRes = await fetch(`${process.env.E2E_BASE_URL || 'http://localhost:3000'}/api/v1/billing-admin/transactions.csv?mode=test&householdId=${c.h.householdId}`, { headers: { 'x-admin-billing-key': process.env.ADMIN_BILLING_API_KEY! } });
  const csv = parseCsv(await csvRes.text());
  s.check('CSV: header + one row per transaction', csvRes.status === 200 && (csvRes.headers.get('content-type') || '').includes('csv') && csv.length === 3, { rows: csv.length });
  const one = (await adminGet(`/transactions/${byHh.data[0].id}`)).json;
  s.check('transaction detail loads', one.success === true && one.data.id === byHh.data[0].id);

  // summary arithmetic vs raw ledger over the same window
  const sum = (await adminGet('/summary?mode=test&from=2020-01-01&to=2031-01-01')).json.data;
  const all = await BillingTransaction.findAll({ where: { livemode: false } });
  const agg = (f: (t: BillingTransaction) => boolean, k: 'amount' | 'fee' | 'disputeFee') => all.filter(f).reduce((a, t) => a + (t[k] ?? 0), 0);
  const gross = agg((t) => t.type === 'payment', 'amount');
  const refunds = agg((t) => t.type === 'refund' && t.status === 'succeeded', 'amount');
  const disputes = agg((t) => t.type === 'dispute' && t.fundsState === 'withdrawn', 'amount');
  const fees = agg((t) => t.type === 'payment', 'fee');
  const dFees = agg((t) => t.type === 'dispute', 'disputeFee');
  s.check('summary matches the ledger and net = gross - refunds - disputes - fees - dispute fees',
    sum.gross === gross && sum.refunds === refunds && sum.disputes === disputes && sum.fees === fees && sum.disputeFees === dFees && sum.net === gross - refunds - disputes - fees - dFees,
    { sum, expected: { gross, refunds, disputes, fees, dFees } });
  s.put('summary', sum);

  // review queue resolve
  const open = (await adminGet('/reconciliation/items?mode=test&status=needs_review&limit=50')).json.data as any[];
  if (open.length === 0) {
    s.check('review queue has an item to resolve (E10/E14 run first)', false);
  } else {
    const item = open[0];
    const res = await adminSend('POST', `/reconciliation/items/${item.id}/resolve`, { resolution: 'resolved', note: 'E2E resolve check' });
    s.check('review item resolved with a note', res.status === 200 && res.json.data?.resolution === 'resolved', res.json);
    const again = (await adminGet('/reconciliation/items?mode=test&status=resolved&limit=200')).json.data as any[];
    s.check('resolved item listed under status=resolved', again.some((i) => i.id === item.id));
  }

  // event replay
  const ev = await waitFor(async () => (await import('../../src/database/models')).BillingEvent.findOne({ where: { type: 'invoice.paid', status: 'processed' }, order: [['createdAt', 'DESC']] }), 30_000, 1000, 'processed event');
  const rep = await adminSend('POST', `/events/${ev.providerEventId}/replay`);
  s.check('event replay accepted', rep.status === 200, rep.json);
  const replayed = await waitFor(async () => {
    const e = await (await import('../../src/database/models')).BillingEvent.findOne({ where: { providerEventId: ev.providerEventId } });
    return e && e.status === 'processed' ? e : false;
  }, 30_000, 1000, 'replayed event processed');
  s.check('replayed event processed again without duplicating ledger rows', !!replayed && (await BillingTransaction.count({ where: { householdId: c.h.householdId, type: 'payment' } })) === 1);
  const audit = await adminGet(`/households/${c.h.householdId}`);
  s.check('household billing view lists subscription and recent transactions', audit.json.data.subscriptions.length === 1 && audit.json.data.recentTransactions.length === 2);
  s.finish();
}

const ALL: Record<string, () => Promise<void>> = { E5, E6, E7, E8, E9, E10, E11, E12, E13, E14, E15 };

(async () => {
  const wanted = process.argv.slice(2);
  const run = wanted.length ? wanted : Object.keys(ALL);
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  let failed = 0;
  for (const id of run) {
    try { await ALL[id](); } catch (err) {
      failed++;
      console.error(`=== ${id}: ERROR ${(err as Error).message}`);
      const sc = new Scenario(id, 'errored');
      sc.check('scenario completed without throwing', false, (err as Error).message);
      sc.finish();
    }
  }
  await closeAll();
  process.exit(failed ? 1 : 0);
})();
