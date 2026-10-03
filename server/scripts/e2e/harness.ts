/* eslint-disable no-console */
/**
 * Wave 10 E2E harness. Talks to a running dev server (default http://localhost:3000) through the real API,
 * uses the server's own models/Stripe client for DB snapshots and Stripe-side setup.
 * Run with the server env loaded: `set -a && . ./.env.impl && set +a` (DB rootaroo_impl).
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Op } from 'sequelize';
import {
  BillingCheckoutSession, BillingCustomer, BillingEvent, BillingReconciliationItem, BillingReconciliationRun,
  BillingSubscription, BillingTransaction, Household, sequelize,
} from '../../src/database/models';
import { getStripe } from '../../src/modules/billing/config';

export const BASE = process.env.E2E_BASE_URL || 'http://localhost:3000';
export const API = `${BASE}/api/v1`;
export const EVIDENCE_DIR = path.resolve(__dirname, '../../../docs/superpowers/evidence/e2e');
export const SERVER_LOG = process.env.E2E_SERVER_LOG || '';
export const PASSWORD = ['E2e', 'Pass', crypto.randomBytes(6).toString('hex')].join('-');

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const stripe = () => getStripe('test');

// ── redaction: evidence never carries keys, signing secrets, bearer tokens or tokenized URLs ──
const SECRET_PATTERNS: RegExp[] = [/(sk|rk|pk)_(test|live)_[A-Za-z0-9]+/g, /whsec_[A-Za-z0-9+/=]+/g, /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g];
const TOKEN_URL = /https?:\/\/(checkout|billing|invoice|pay)\.stripe\.com\/[^\s"']*/g;

export function redact<T>(value: T): T {
  const s = JSON.stringify(value, (_k, v) => (typeof v === 'string' ? scrub(v) : v));
  return JSON.parse(s) as T;
}
function scrub(v: string): string {
  let out = v.replace(TOKEN_URL, (m) => `<stripe-url:${new URL(m).host}>`);
  for (const p of SECRET_PATTERNS) out = out.replace(p, '<redacted>');
  if (/^https?:\/\/[^?]*\/(i|invoice|receipts?)\//.test(out)) out = '<url-redacted>';
  return out;
}

export interface Result { scenario: string; title: string; pass: boolean; startedAt: string; assertions: { name: string; ok: boolean; detail?: unknown }[]; data: Record<string, unknown> }

export class Scenario {
  readonly result: Result;
  constructor(id: string, title: string) {
    this.result = { scenario: id, title, pass: false, startedAt: new Date().toISOString(), assertions: [], data: {} };
    console.log(`\n=== ${id}: ${title}`);
  }
  check(name: string, ok: boolean, detail?: unknown): void {
    this.result.assertions.push({ name, ok, ...(detail !== undefined ? { detail } : {}) });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`);
  }
  put(key: string, value: unknown): void { this.result.data[key] = value; }
  finish(): Result {
    this.result.pass = this.result.assertions.length > 0 && this.result.assertions.every((a) => a.ok);
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    fs.writeFileSync(path.join(EVIDENCE_DIR, `${this.result.scenario}.json`), JSON.stringify(redact(this.result), null, 2) + '\n');
    console.log(`=== ${this.result.scenario}: ${this.result.pass ? 'PASS' : 'FAIL'}`);
    return this.result;
  }
}

// ── API client ──
export interface Household_ { email: string; userId: string; householdId: string; token: string; name: string }
const creds = new Map<string, string>(); // email -> password

async function raw(method: string, url: string, token: string | null, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}

export async function login(email: string): Promise<string> {
  const r = await raw('POST', `${API}/auth/login`, null, { email, password: creds.get(email) });
  if (r.status !== 200) throw new Error(`login failed ${r.status}`);
  return r.json.data.tokens.accessToken;
}

/** Authenticated call; re-logs in once on 401 (access tokens last 15 minutes). */
export async function call(h: Household_, method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
  let r = await raw(method, `${API}${p}`, h.token, body, headers);
  if (r.status === 401) { h.token = await login(h.email); r = await raw(method, `${API}${p}`, h.token, body, headers); }
  return r;
}

/** Seeds a fresh user + household through the real API (register, then household create). */
export async function seedHousehold(label: string, opts: { cohort?: 'live' | 'test' } = {}): Promise<Household_> {
  const email = `e2e-${label.toLowerCase()}-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}@example.test`;
  creds.set(email, PASSWORD);
  const reg = await raw('POST', `${API}/auth/register`, null, { email, password: PASSWORD, displayName: `E2E ${label}` });
  if (reg.status !== 201 && reg.status !== 200) throw new Error(`register failed ${reg.status}: ${reg.text.slice(0, 200)}`);
  const token = reg.json.data.tokens.accessToken as string;
  const name = `E2E ${label} Household`;
  const hh = await raw('POST', `${API}/households`, token, { name });
  if (hh.status !== 201 && hh.status !== 200) throw new Error(`household create failed ${hh.status}: ${hh.text.slice(0, 200)}`);
  const h: Household_ = { email, userId: reg.json.data.user.id, householdId: hh.json.data.id, token, name };
  if (opts.cohort) await Household.update({ billingCohort: opts.cohort }, { where: { id: h.householdId } });
  return h;
}

export const checkout = (h: Household_, interval: 'month' | 'year', seats: number) => call(h, 'POST', '/billing/checkout', { interval, seats }, { 'x-platform': 'android', 'x-store-country': 'US' });
export const status = (h: Household_) => call(h, 'GET', '/billing/status', undefined, { 'x-platform': 'android', 'x-store-country': 'US' });
export const sync = (h: Household_, sessionId: string) => call(h, 'POST', `/billing/checkout/${sessionId}/sync`);
export const planChange = (h: Household_, interval: 'month' | 'year', seats: number) => call(h, 'POST', '/billing/plan', { interval, seats });
export const portal = (h: Household_) => call(h, 'POST', '/billing/portal');
/** A guarded endpoint: 402 when the household is not entitled. */
export const guardedStatus = async (h: Household_) => (await call(h, 'GET', '/tasks')).status;

export function adminHeaders(): Record<string, string> {
  const key = process.env.ADMIN_BILLING_API_KEY;
  if (!key) throw new Error('ADMIN_BILLING_API_KEY not set (load server/.env.impl)');
  return { 'x-admin-billing-key': key };
}
export const adminGet = (p: string) => raw('GET', `${API}/billing-admin${p}`, null, undefined, adminHeaders());
export const adminSend = (method: 'POST' | 'PUT', p: string, body?: unknown) => raw(method, `${API}/billing-admin${p}`, null, body ?? {}, adminHeaders());

export async function waitFor<T>(predicate: () => Promise<T | false | null | undefined> | T | false | null | undefined, timeoutMs = 60_000, intervalMs = 1500, label = 'condition'): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await predicate();
    if (v) return v as T;
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await sleep(intervalMs);
  }
}

const j = (row: any) => (row ? JSON.parse(JSON.stringify(row.toJSON())) : null);

/** billing_* rows for a household as JSON. */
export async function dbSnapshot(householdId: string) {
  const subs = await BillingSubscription.findAll({ where: { householdId }, order: [['createdAt', 'ASC']] });
  const customers = await BillingCustomer.findAll({ where: { householdId } });
  const txns = await BillingTransaction.findAll({ where: { householdId }, order: [['occurredAt', 'ASC'], ['createdAt', 'ASC']] });
  const sessions = await BillingCheckoutSession.findAll({ where: { householdId }, order: [['createdAt', 'ASC']] });
  const reviews = await BillingReconciliationItem.findAll({
    where: { [Op.or]: [{ entityId: householdId }, { entityId: subs.map((s) => s.id) }, { providerObjectId: subs.map((s) => s.providerSubscriptionId) }] },
    order: [['createdAt', 'ASC']],
  });
  return {
    subscriptions: subs.map(j), customers: customers.map(j), transactions: txns.map(j),
    checkoutSessions: sessions.map((s) => { const o = j(s); delete o.url; return o; }), reviewItems: reviews.map(j),
  };
}

export async function eventTypesSince(since: Date): Promise<string[]> {
  const rows = await BillingEvent.findAll({ where: { createdAt: { [Op.gte]: since } }, order: [['createdAt', 'ASC']], attributes: ['type', 'status'] });
  return rows.map((r) => `${r.type}:${r.status}`);
}

export async function latestRun(kind?: string) {
  return BillingReconciliationRun.findOne({ where: kind ? { kind } : {}, order: [['createdAt', 'DESC']] });
}

export function serverLogContains(needle: string): boolean {
  if (!SERVER_LOG || !fs.existsSync(SERVER_LOG)) return false;
  return fs.readFileSync(SERVER_LOG, 'utf8').includes(needle);
}

export async function closeAll(): Promise<void> {
  try { await sequelize.close(); } catch { /* ignore */ }
}
