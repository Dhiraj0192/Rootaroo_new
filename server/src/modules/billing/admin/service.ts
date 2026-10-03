import { Op, WhereOptions } from 'sequelize';
import { BillingSubscription, BillingTransaction, Household } from '../../../database/models';
import type { LedgerType } from '../../../database/models/BillingTransaction';
import { NotFoundError, ValidationError } from '../../../shared/utils/errors';

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

export async function getTransaction(id: string) {
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
