import { Op, WhereOptions } from 'sequelize';
import { BillingCustomer, BillingEvent, BillingReconciliationItem, BillingReconciliationRun, BillingSubscription, BillingTransaction, Household, HouseholdMember, User } from '../../../database/models';
import { getEntitlement } from '../entitlement';
import { enqueueEvent } from '../worker';
import type { Entitlement } from '../types';
import type { LedgerType } from '../../../database/models/BillingTransaction';
import { AppError, NotFoundError, ValidationError } from '../../../shared/utils/errors';

export function ping(): { ok: true } { return { ok: true }; }

export function encodeCursor(at: Date, id: string): string {
  return Buffer.from(`${at.toISOString()}|${id}`).toString('base64url');
}

export function decodeCursor(c: string | undefined): { at: Date; id: string } | null {
  if (!c) return null;
  const raw = Buffer.from(c, 'base64url').toString('utf8');
  const [iso, id] = raw.split('|');
  const at = new Date(iso);
  if (!id || Number.isNaN(at.getTime())) throw new ValidationError('Invalid cursor');
  return { at, id };
}

export function stripeDashboardUrl(provider: string, livemode: boolean, type: LedgerType, objectId: string): string | null {
  if (provider !== 'stripe') return null;
  const path = type === 'refund' ? 'refunds' : type === 'dispute' ? 'disputes' : 'invoices';
  // Sandboxes may need the account path segment; verify the link format in the Dashboard at implementation time.
  return `https://dashboard.stripe.com/${livemode ? '' : 'test/'}${path}/${objectId}`;
}

export interface TxFilters {
  mode: 'test' | 'live'; householdId?: string; userId?: string; email?: string; type?: LedgerType; status?: string;
  matchStatus?: 'matched' | 'unmatched'; billingReason?: string; from?: Date; to?: Date; cursor?: string; limit: number;
}

export interface TransactionView {
  id: string; provider: string; mode: 'test' | 'live'; type: LedgerType; status: string; billingReason: string | null;
  amount: number; fee: number | null; net: number | null; disputeFee: number | null; fundsState: string | null; currency: string;
  householdId: string | null; householdName: string | null; userId: string | null; payerEmail: string | null; subscriptionId: string | null;
  matchStatus: string; providerObjectId: string; providerInvoiceId: string | null; providerChargeId: string | null;
  receiptUrl: string | null; description: string | null; occurredAt: string; stripeDashboardUrl: string | null;
}

export function toView(t: BillingTransaction): TransactionView {
  return {
    id: t.id, provider: t.provider, mode: t.livemode ? 'live' : 'test', type: t.type, status: t.status, billingReason: t.billingReason,
    amount: t.amount, fee: t.fee, net: t.net, disputeFee: t.disputeFee, fundsState: t.fundsState, currency: t.currency,
    householdId: t.householdId, householdName: t.householdNameSnapshot, userId: t.userId, payerEmail: t.payerEmailSnapshot,
    subscriptionId: t.subscriptionId, matchStatus: t.matchStatus, providerObjectId: t.providerObjectId, providerInvoiceId: t.providerInvoiceId,
    providerChargeId: t.providerChargeId, receiptUrl: t.receiptUrl, description: t.description, occurredAt: t.occurredAt.toISOString(),
    stripeDashboardUrl: stripeDashboardUrl(t.provider, t.livemode, t.type, t.providerObjectId),
  };
}

function txWhere(f: TxFilters): WhereOptions {
  const where: Record<string | symbol, unknown> = { livemode: f.mode === 'live' };
  if (f.householdId) where.householdId = f.householdId;
  if (f.userId) where.userId = f.userId;
  if (f.email) where.payerEmailSnapshot = f.email;
  if (f.type) where.type = f.type;
  if (f.status) where.status = f.status;
  if (f.matchStatus) where.matchStatus = f.matchStatus;
  if (f.billingReason) where.billingReason = f.billingReason;
  if (f.from || f.to) where.occurredAt = { ...(f.from ? { [Op.gte]: f.from } : {}), ...(f.to ? { [Op.lte]: f.to } : {}) };
  const cursor = decodeCursor(f.cursor);
  if (cursor) where[Op.or] = [{ occurredAt: { [Op.lt]: cursor.at } }, { occurredAt: cursor.at, id: { [Op.lt]: cursor.id } }];
  return where as WhereOptions;
}

export async function listTransactions(f: TxFilters): Promise<{ data: TransactionView[]; nextCursor: string | null }> {
  const rows = await BillingTransaction.findAll({ where: txWhere(f), order: [['occurredAt', 'DESC'], ['id', 'DESC']], limit: f.limit + 1 });
  const page = rows.slice(0, f.limit);
  const last = page[page.length - 1];
  return { data: page.map(toView), nextCursor: rows.length > f.limit && last ? encodeCursor(last.occurredAt, last.id) : null };
}

export async function getTransaction(id: string): Promise<TransactionView & { subscription: Record<string, unknown> | null; household: Record<string, unknown> | null }> {
  const t = await BillingTransaction.findByPk(id);
  if (!t) throw new NotFoundError('Transaction');
  const subscription = t.subscriptionId ? await BillingSubscription.findByPk(t.subscriptionId) : null;
  const household = t.householdId ? await Household.findByPk(t.householdId, { paranoid: false }) : null;
  return {
    ...toView(t),
    subscription: subscription ? subscription.toJSON() : null,
    household: household ? { id: household.id, name: household.name, billingCohort: household.billingCohort, deletedAt: household.deletedAt } : null,
  };
}

const CSV_COLUMNS = ['id', 'occurred_at', 'mode', 'type', 'status', 'billing_reason', 'amount', 'fee', 'net', 'dispute_fee', 'currency', 'household_id', 'household_name', 'user_id', 'payer_email', 'match_status', 'provider_object_id', 'stripe_dashboard_url'];

/** Quotes as needed and defuses spreadsheet formulas: household names and emails are user-controlled. */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function writeTransactionsCsv(f: TxFilters, write: (chunk: string) => void): Promise<number> {
  write(`${CSV_COLUMNS.join(',')}\n`);
  let cursor: string | undefined = f.cursor;
  let count = 0;
  for (;;) {
    const page = await listTransactions({ ...f, cursor, limit: 200 });
    for (const t of page.data) {
      write(`${[t.id, t.occurredAt, t.mode, t.type, t.status, t.billingReason, t.amount, t.fee, t.net, t.disputeFee, t.currency, t.householdId, t.householdName, t.userId, t.payerEmail, t.matchStatus, t.providerObjectId, t.stripeDashboardUrl].map(csvCell).join(',')}\n`);
      count++;
    }
    if (!page.nextCursor) return count;
    cursor = page.nextCursor;
  }
}

export interface Summary {
  mode: 'test' | 'live'; from: string; to: string; currency: 'usd';
  gross: number; refunds: number; disputes: number; fees: number; disputeFees: number; net: number; mrr: number;
  counts: { active: number; pastDue: number; inGrace: number; failedCyclePayments: number };
}

export async function getSummary(mode: 'test' | 'live', from: Date, to: Date, now: Date = new Date()): Promise<Summary> {
  const livemode = mode === 'live';
  const inRange = { livemode, occurredAt: { [Op.between]: [from, to] } };
  const sum = async (field: 'amount' | 'fee' | 'disputeFee', where: Record<string, unknown>) =>
    Number((await BillingTransaction.sum(field, { where: { ...inRange, ...where } })) ?? 0);

  const gross = await sum('amount', { type: 'payment' });
  const refunds = await sum('amount', { type: 'refund', status: 'succeeded' });
  const disputes = await sum('amount', { type: 'dispute', fundsState: 'withdrawn' });
  const fees = await sum('fee', { type: 'payment' });
  const disputeFees = await sum('disputeFee', { type: 'dispute' });
  const failedCyclePayments = await BillingTransaction.count({ where: { ...inRange, type: 'failed_payment', billingReason: 'subscription_cycle' } });

  const subs = await BillingSubscription.findAll({ where: { livemode, status: { [Op.in]: ['active', 'trialing', 'past_due'] } } });
  const healthy = subs.filter((s) => s.status === 'active' || s.status === 'trialing');
  const pastDue = subs.filter((s) => s.status === 'past_due');
  const inGrace = pastDue.filter((s) => s.graceUntil && s.graceUntil.getTime() > now.getTime());
  const mrr = [...healthy, ...inGrace].reduce((acc, s) => acc + (s.interval === 'year' ? Math.round((s.unitAmount ?? 0) / 12) : s.unitAmount ?? 0), 0);

  return {
    mode, from: from.toISOString(), to: to.toISOString(), currency: 'usd',
    gross, refunds, disputes, fees, disputeFees, net: gross - refunds - disputes - fees - disputeFees, mrr,
    counts: { active: healthy.length, pastDue: pastDue.length, inGrace: inGrace.length, failedCyclePayments },
  };
}

export async function listSubscriptions(mode: 'test' | 'live', status: string | undefined, cursor: string | undefined, limit: number): Promise<{ data: Record<string, unknown>[]; nextCursor: string | null }> {
  const where: Record<string | symbol, unknown> = { livemode: mode === 'live' };
  if (status) where.status = status;
  const c = decodeCursor(cursor);
  if (c) where[Op.or] = [{ updatedAt: { [Op.lt]: c.at } }, { updatedAt: c.at, id: { [Op.lt]: c.id } }];
  const rows = await BillingSubscription.findAll({ where: where as WhereOptions, order: [['updatedAt', 'DESC'], ['id', 'DESC']], limit: limit + 1 });
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    data: page.map((s) => ({ ...s.toJSON(), mode: s.livemode ? 'live' : 'test' })),
    nextCursor: rows.length > limit && last ? encodeCursor(last.updatedAt, last.id) : null,
  };
}

export interface HouseholdBillingView {
  household: Record<string, unknown>; entitlement: Entitlement; subscriptions: Record<string, unknown>[]; customers: Record<string, unknown>[];
  members: { userId: string; role: string; displayName: string | null; email: string | null }[]; recentTransactions: TransactionView[];
}

export async function getHouseholdBilling(householdId: string): Promise<HouseholdBillingView> {
  const household = await Household.findByPk(householdId, { paranoid: false });
  if (!household) throw new NotFoundError('Household');
  const [subs, customers, members, recent] = await Promise.all([
    BillingSubscription.findAll({ where: { householdId }, order: [['createdAt', 'DESC']] }),
    BillingCustomer.findAll({ where: { householdId } }),
    HouseholdMember.findAll({ where: { householdId }, include: [{ model: User, as: 'user', required: false, paranoid: false }] }),
    BillingTransaction.findAll({ where: { householdId }, order: [['occurredAt', 'DESC']], limit: 20 }),
  ]);
  return {
    household: { id: household.id, name: household.name, billingCohort: household.billingCohort, deletedAt: household.deletedAt, scheduledDeletionAt: household.scheduledDeletionAt },
    entitlement: await getEntitlement(householdId, { bypassCache: true }),
    subscriptions: subs.map((s) => ({ ...s.toJSON(), mode: s.livemode ? 'live' : 'test' })),
    customers: customers.map((c) => ({ ...c.toJSON(), mode: c.livemode ? 'live' : 'test' })),
    members: members.map((m) => ({ userId: m.userId, role: m.role, displayName: m.user?.displayName ?? null, email: m.user?.email ?? null })),
    recentTransactions: recent.map(toView),
  };
}

async function page<T extends { createdAt: Date; id: string }>(
  finder: (where: WhereOptions, limit: number) => Promise<T[]>, base: Record<string, unknown>, cursor: string | undefined, limit: number,
): Promise<{ data: T[]; nextCursor: string | null }> {
  const where: Record<string | symbol, unknown> = { ...base };
  const c = decodeCursor(cursor);
  if (c) where[Op.or] = [{ createdAt: { [Op.lt]: c.at } }, { createdAt: c.at, id: { [Op.lt]: c.id } }];
  const rows = await finder(where as WhereOptions, limit + 1);
  const data = rows.slice(0, limit);
  const last = data[data.length - 1];
  return { data, nextCursor: rows.length > limit && last ? encodeCursor(last.createdAt, last.id) : null };
}

export function listRuns(mode: 'test' | 'live', cursor: string | undefined, limit: number) {
  return page((where, l) => BillingReconciliationRun.findAll({ where, order: [['createdAt', 'DESC'], ['id', 'DESC']], limit: l }), { livemode: mode === 'live' }, cursor, limit);
}

export function listItems(mode: 'test' | 'live', status: string | undefined, cursor: string | undefined, limit: number) {
  return page((where, l) => BillingReconciliationItem.findAll({ where, order: [['createdAt', 'DESC'], ['id', 'DESC']], limit: l }),
    { livemode: mode === 'live', ...(status ? { resolution: status } : {}) }, cursor, limit);
}

export async function resolveItem(id: string, resolution: 'resolved' | 'ignored', note: string): Promise<BillingReconciliationItem> {
  const item = await BillingReconciliationItem.findByPk(id);
  if (!item) throw new NotFoundError('Review item');
  return item.update({ resolution, resolutionNote: note, resolvedBy: 'billing-key', resolvedAt: new Date() });
}

/** Re-queues a stored webhook event. Refused while a worker holds it, so one event is never processed twice at once. */
export async function replayEvent(idOrProviderId: string): Promise<BillingEvent> {
  const isUuid = /^[0-9a-f-]{36}$/i.test(idOrProviderId);
  const row = await BillingEvent.findOne({ where: isUuid ? { id: idOrProviderId } : { providerEventId: idOrProviderId } });
  if (!row) throw new NotFoundError('Event');
  const [claimed] = await BillingEvent.update(
    { status: 'received', attempts: 0, lockedAt: null, lastError: null },
    { where: { id: row.id, status: { [Op.ne]: 'processing' } } },
  );
  if (claimed === 0) throw new AppError(409, 'This event is being processed right now. Try again in a moment.', 'EVENT_PROCESSING');
  enqueueEvent(row.id);
  return (await BillingEvent.findByPk(row.id))!;
}
