/**
 * Local billing scenario seed (dev only).
 *   cd server && set -a && . ./.env.impl && set +a && npx tsx scripts/dev/seed-billing.ts [--reset]
 *
 * Writes rows directly (no Stripe calls). Everything is tagged: emails seed+<scenario>-<role>@rootaroo.test,
 * households "[seed] ...", provider ids *_seed_*. --reset deletes only tagged rows, then recreates them.
 * Refuses to run unless DB_NAME is rootaroo_impl or *_test, NODE_ENV is not production, and the DB is not port 3306.
 */
import bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';

// Test-only login password for every seeded user. Not a secret.
const SEED_PASSWORD = 'SeedPass#2026';
const EMAIL_DOMAIN = 'rootaroo.test';
const HH_PREFIX = '[seed] ';
const DAY = 86_400_000;

export function assertSafeTarget(e: NodeJS.ProcessEnv): void {
  const name = e.DB_NAME ?? '';
  const problems: string[] = [];
  if (!(name === 'rootaroo_impl' || name.endsWith('_test'))) problems.push(`DB_NAME "${name}" is not rootaroo_impl or *_test`);
  if (e.NODE_ENV === 'production') problems.push('NODE_ENV is production');
  if ((e.DB_PORT ?? '3306') === '3306') problems.push('DB_PORT is 3306 (or unset); the throwaway DB runs on 3307');
  if (e.DB_SOCKET) problems.push('DB_SOCKET is set (would bypass the port check)');
  if (problems.length) throw new Error(`Refusing to seed: ${problems.join('; ')}`);
}

interface Sub {
  provider?: 'stripe' | 'apple' | 'google'; status: string; interval: 'month' | 'year'; seats: number; start: number; end: number;
  cancelAtPeriodEnd?: boolean; canceledAt?: number | null; endedAt?: number | null; graceUntil?: number | null; pending?: Record<string, unknown> | null;
  idSuffix?: string; createdAgo?: number;
}
interface Scenario {
  key: string; title: string; members: number; cohort?: 'live' | 'test'; subs: Sub[]; expected: { allowed: boolean; reason: string };
}

const now = Date.now();
const mo = (o: Partial<Sub> = {}): Sub => ({ status: 'active', interval: 'month', seats: 5, start: -10 * DAY, end: 20 * DAY, ...o });

const SCENARIOS: Scenario[] = [
  { key: 'a', title: 'No subscription', members: 3, subs: [], expected: { allowed: false, reason: 'subscription_required' } },
  { key: 'b', title: 'Active monthly 5 seats', members: 5, subs: [mo()], expected: { allowed: true, reason: 'active' } },
  { key: 'c', title: 'Active yearly 7 seats', members: 6, subs: [mo({ interval: 'year', seats: 7, start: -100 * DAY, end: 265 * DAY })], expected: { allowed: true, reason: 'active' } },
  { key: 'd', title: 'Active 5 seats full', members: 5, subs: [mo()], expected: { allowed: true, reason: 'active' } },
  { key: 'e', title: '10 seats, 10 members', members: 10, subs: [mo({ seats: 10 })], expected: { allowed: true, reason: 'active' } },
  { key: 'f', title: 'Past due, in grace', members: 5, subs: [mo({ status: 'past_due', graceUntil: 4 * DAY })], expected: { allowed: true, reason: 'grace' } },
  { key: 'g', title: 'Past due, grace expired', members: 5, subs: [mo({ status: 'past_due', graceUntil: -2 * DAY })], expected: { allowed: false, reason: 'subscription_required' } },
  { key: 'h', title: 'Cancel at period end', members: 5, subs: [mo({ cancelAtPeriodEnd: true, canceledAt: -1 * DAY, end: 12 * DAY })], expected: { allowed: true, reason: 'active' } },
  { key: 'i', title: 'Canceled ended', members: 5, subs: [mo({ status: 'canceled', canceledAt: -3 * DAY, endedAt: -3 * DAY, end: -3 * DAY, start: -33 * DAY })], expected: { allowed: false, reason: 'subscription_required' } },
  { key: 'j', title: 'Test cohort no sub', members: 3, cohort: 'test', subs: [], expected: { allowed: true, reason: 'test_cohort' } },
  { key: 'k', title: 'Pending plan update', members: 5, subs: [mo({ pending: { seats: 7, interval: 'month', priceId: 'price_seed_hh7_month' } })], expected: { allowed: true, reason: 'active' } },
  { key: 'l', title: 'Apple IAP active', members: 5, subs: [mo({ provider: 'apple' })], expected: { allowed: true, reason: 'active' } },
  { key: 'm', title: 'Google Play active', members: 5, subs: [mo({ provider: 'google' })], expected: { allowed: true, reason: 'active' } },
  {
    key: 'n', title: 'Duplicate subscriptions', members: 5,
    subs: [mo({ idSuffix: 'a', createdAgo: 20 * DAY, start: -20 * DAY, end: 10 * DAY }), mo({ idSuffix: 'b', createdAgo: 2 * DAY, start: -2 * DAY, end: 28 * DAY })],
    expected: { allowed: true, reason: 'active' },
  },
];

const email = (key: string, role: string) => `seed+${key}-${role}@${EMAIL_DOMAIN}`;
const amountFor = (interval: 'month' | 'year', seats: number) => (interval === 'month' ? 899 + 199 * (seats - 5) : 7999 + 2388 * (seats - 5));
const feeFor = (amt: number) => Math.round(amt * 0.029 + 30);

async function main(): Promise<void> {
  assertSafeTarget(process.env);
  const reset = process.argv.includes('--reset');

  // Import after the guard so nothing connects before it passes.
  const { default: sequelize } = await import('../../src/config/database');
  const { default: redis } = await import('../../src/config/redis');
  const m = await import('../../src/database/models');
  const { getEntitlement, clearEntitlementCache, assertSeatAvailable } = await import('../../src/modules/billing/entitlement');
  const { productIdFor } = await import('../../src/modules/billing/iap/types');
  const { QueryTypes, Op } = await import('sequelize');

  const dbRow = (await sequelize.query('SELECT DATABASE() AS d', { type: QueryTypes.SELECT })) as { d: string }[];
  assertSafeTarget({ ...process.env, DB_NAME: dbRow[0].d });

  // ---------- reset ----------
  const existing = (await sequelize.query('SELECT id FROM households WHERE name LIKE :p', { replacements: { p: `${HH_PREFIX}%` }, type: QueryTypes.SELECT })) as { id: string }[];
  const existingUsers = (await sequelize.query('SELECT id FROM users WHERE email LIKE :p', { replacements: { p: `seed+%@${EMAIL_DOMAIN}` }, type: QueryTypes.SELECT })) as { id: string }[];
  if ((existing.length || existingUsers.length) && !reset) {
    console.log(`Seed data already present (${existing.length} households). Re-run with --reset to recreate.`);
    await sequelize.close(); redis.disconnect(); return;
  }
  if (reset) {
    const hids = existing.map((r) => r.id);
    const uids = existingUsers.map((r) => r.id);
    await sequelize.transaction(async (t) => {
      const q = (sql: string, repl: Record<string, unknown> = {}) => sequelize.query(sql, { replacements: repl, transaction: t });
      await q('SET FOREIGN_KEY_CHECKS=0');
      // seed-tagged billing rows regardless of household
      await q("DELETE FROM billing_transactions WHERE provider_object_id LIKE '%seed%'");
      await q("DELETE FROM billing_reconciliation_items WHERE provider_object_id LIKE '%seed%'");
      await q("DELETE FROM billing_reconciliation_runs WHERE JSON_EXTRACT(counts, '$.seed') = true");
      await q("DELETE FROM billing_events WHERE provider_event_id LIKE 'evt\\_seed\\_%'");
      await q("DELETE FROM billing_price_notices WHERE subscription_id IN (SELECT id FROM billing_subscriptions WHERE provider_subscription_id LIKE '%seed%')");
      await q("DELETE FROM billing_subscriptions WHERE provider_subscription_id LIKE '%seed%'");
      await q("DELETE FROM billing_customers WHERE provider_customer_id LIKE '%seed%'");
      // every table referencing seed households / users (FK-discovered), then the parents
      const fks = (await sequelize.query(
        `SELECT TABLE_NAME t, COLUMN_NAME c, REFERENCED_TABLE_NAME r FROM information_schema.KEY_COLUMN_USAGE
         WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IN ('households','users')`, { type: QueryTypes.SELECT, transaction: t })) as { t: string; c: string; r: string }[];
      for (const fk of fks) {
        const ids = fk.r === 'households' ? hids : uids;
        if (ids.length) await q(`DELETE FROM \`${fk.t}\` WHERE \`${fk.c}\` IN (:ids)`, { ids });
      }
      if (hids.length) await q('DELETE FROM households WHERE id IN (:ids)', { ids: hids });
      if (uids.length) await q('DELETE FROM users WHERE id IN (:ids)', { ids: uids });
      await q('SET FOREIGN_KEY_CHECKS=1');
    });
    await Promise.all(hids.map((id) => clearEntitlementCache(id)));
    console.log(`Reset: removed ${hids.length} seed households and ${uids.length} seed users.`);
  }

  // ---------- create ----------
  const passwordHash = await bcrypt.hash(SEED_PASSWORD, 12);
  const created: { sc: Scenario; householdId: string; adminId: string; memberIds: string[]; subIds: string[]; inviteCode: string }[] = [];

  for (const sc of SCENARIOS) {
    const household = await m.Household.create({
      id: randomUUID(), name: `${HH_PREFIX}${sc.key.toUpperCase()} ${sc.title}`,
      inviteCode: `SD${sc.key.toUpperCase()}${randomUUID().slice(0, 4).toUpperCase()}`, billingCohort: sc.cohort ?? 'live',
    });
    const memberIds: string[] = [];
    let adminId = '';
    for (let i = 0; i < sc.members; i++) {
      const role = i === 0 ? 'admin' : 'member';
      const label = i === 0 ? 'admin' : `member${i}`;
      const user = await m.User.create({
        id: randomUUID(), email: email(sc.key, label), passwordHash, displayName: `Seed ${sc.key.toUpperCase()} ${label}`,
        role, isVerified: true, phone: null,
      });
      await m.HouseholdMember.create({ id: randomUUID(), householdId: household.id, userId: user.id, role, joinedAt: new Date() });
      if (i === 0) adminId = user.id; else memberIds.push(user.id);
    }

    const subIds: string[] = [];
    for (const s of sc.subs) {
      const provider = s.provider ?? 'stripe';
      const suffix = s.idSuffix ? `_${s.idSuffix}` : '';
      const providerSubId = provider === 'stripe' ? `sub_seed_${sc.key}${suffix}` : `sub_seed_${provider}_${sc.key}`;
      const createdAt = new Date(now - (s.createdAgo ?? 30 * DAY));
      const row = await m.BillingSubscription.create({
        id: randomUUID(), householdId: household.id, provider, livemode: false, providerSubscriptionId: providerSubId,
        status: s.status as never, interval: s.interval, seats: s.seats,
        priceId: provider === 'stripe' ? `price_seed_hh${s.seats}_${s.interval}` : productIdFor(s.seats, s.interval),
        priceSet: provider === 'stripe' ? '2026-10' : null,
        unitAmount: amountFor(s.interval, s.seats), currency: 'usd',
        currentPeriodStart: new Date(now + s.start), currentPeriodEnd: new Date(now + s.end),
        cancelAtPeriodEnd: s.cancelAtPeriodEnd ?? false,
        canceledAt: s.canceledAt != null ? new Date(now + s.canceledAt) : null,
        endedAt: s.endedAt != null ? new Date(now + s.endedAt) : null,
        pendingUpdate: s.pending ?? null,
        graceUntil: s.status === 'past_due' && s.graceUntil != null ? new Date(now + s.graceUntil) : null,
        purchasedByUserId: adminId, eventWatermark: null, lastSyncedAt: new Date(), createdAt, updatedAt: createdAt,
      } as never);
      subIds.push(row.id);
    }
    if (sc.subs.length) {
      const provider = sc.subs[0].provider ?? 'stripe';
      await m.BillingCustomer.create({
        id: randomUUID(), householdId: household.id, provider, livemode: false,
        providerCustomerId: provider === 'stripe' ? `cus_seed_${sc.key}` : `cus_seed_${provider}_${sc.key}`, billingEmail: email(sc.key, 'admin'),
      } as never);
    }
    created.push({ sc, householdId: household.id, adminId, memberIds, subIds, inviteCode: household.inviteCode });
  }

  // ---------- ledger ----------
  const by = (k: string) => created.find((c) => c.sc.key === k)!;
  let seq = 0;
  interface TxOpts {
    type: 'payment' | 'failed_payment' | 'refund' | 'dispute'; status: string; amount: number; daysAgo: number; objId: string; reason?: string | null;
    fee?: boolean; disputeFee?: number | null; funds?: 'none' | 'withdrawn' | 'reinstated' | null; invoice?: string | null; charge?: string | null;
    desc?: string; provider?: 'stripe' | 'apple' | 'google';
  }
  const tx = async (k: string | null, o: TxOpts) => {
    const c = k ? by(k) : null;
    const hhName = c ? (await m.Household.findByPk(c.householdId))!.name : null;
    const fee = o.fee ? feeFor(o.amount) : null;
    seq++;
    await m.BillingTransaction.create({
      id: randomUUID(), provider: o.provider ?? 'stripe', livemode: false, type: o.type, status: o.status, billingReason: o.reason ?? null,
      amount: o.amount, fee, net: fee !== null ? o.amount - fee : null, disputeFee: o.disputeFee ?? null, fundsState: o.funds ?? null, currency: 'usd',
      householdId: c?.householdId ?? null, userId: c?.adminId ?? null, subscriptionId: c?.subIds[0] ?? null,
      matchStatus: c ? 'matched' : 'unmatched', householdNameSnapshot: hhName, payerEmailSnapshot: k ? email(k, 'admin') : `unknown+${seq}@example.test`,
      providerObjectId: o.objId, providerInvoiceId: o.invoice ?? null, providerChargeId: o.charge ?? null,
      receiptUrl: o.type === 'payment' ? `https://pay.stripe.com/receipts/seed/${o.objId}` : null, description: o.desc ?? null,
      occurredAt: new Date(now - o.daysAgo * DAY), lastEventId: `evt_seed_tx_${seq}`,
    } as never);
  };
  const pay = (k: string, daysAgo: number, amount: number, reason: string, n: string) =>
    tx(k, { type: 'payment', status: 'paid', amount, daysAgo, objId: `in_seed_${n}`, invoice: `in_seed_${n}`, charge: `ch_seed_${n}`, reason, fee: true, desc: 'Rootaroo household subscription' });

  await pay('b', 10, 899, 'subscription_create', 'b1');
  await pay('b', 40, 899, 'subscription_cycle', 'b0');
  await pay('c', 100, 7999 + 2388 * 2, 'subscription_create', 'c1');
  await pay('d', 10, 899, 'subscription_create', 'd1');
  await pay('e', 10, 899 + 199 * 5, 'subscription_create', 'e1');
  await pay('f', 40, 899, 'subscription_create', 'f1');
  await tx('f', { type: 'failed_payment', status: 'failed', amount: 899, daysAgo: 3, objId: 'in_seed_f2', invoice: 'in_seed_f2', reason: 'subscription_cycle', desc: 'Payment failed (card_declined)' });
  await pay('g', 50, 899, 'subscription_create', 'g1');
  await tx('g', { type: 'failed_payment', status: 'failed', amount: 899, daysAgo: 9, objId: 'in_seed_g2', invoice: 'in_seed_g2', reason: 'subscription_cycle', desc: 'Payment failed (card_declined)' });
  await pay('h', 20, 899, 'subscription_create', 'h1');
  await pay('i', 33, 899, 'subscription_create', 'i1');
  await pay('k', 10, 899, 'subscription_create', 'k1');
  await tx('l', { type: 'payment', status: 'paid', amount: 899, daysAgo: 10, objId: 'in_seed_l1', provider: 'apple', reason: 'subscription_create', desc: 'App Store purchase' });
  await tx('m', { type: 'payment', status: 'paid', amount: 899, daysAgo: 10, objId: 'in_seed_m1', provider: 'google', reason: 'subscription_create', desc: 'Google Play purchase' });
  await pay('n', 20, 899, 'subscription_create', 'n1');
  await pay('n', 2, 899, 'subscription_create', 'n2');
  // partial refund on B's cycle payment, full refund on N's duplicate payment, one pending refund
  await tx('b', { type: 'refund', status: 'succeeded', amount: 300, daysAgo: 38, objId: 're_seed_b_partial', invoice: 'in_seed_b0', charge: 'ch_seed_b0', desc: 'Partial refund (goodwill)' });
  await tx('n', { type: 'refund', status: 'succeeded', amount: 899, daysAgo: 1, objId: 're_seed_n_full', invoice: 'in_seed_n2', charge: 'ch_seed_n2', desc: 'Full refund (duplicate subscription)' });
  await tx('d', { type: 'refund', status: 'pending', amount: 899, daysAgo: 0, objId: 're_seed_d_pending', invoice: 'in_seed_d1', charge: 'ch_seed_d1', desc: 'Refund pending' });
  // disputes: open, won, lost
  await tx('c', { type: 'dispute', status: 'needs_response', amount: 7999 + 2388 * 2, daysAgo: 2, objId: 'dp_seed_c_open', charge: 'ch_seed_c1', disputeFee: 1500, funds: 'withdrawn', desc: 'Dispute: fraudulent' });
  await tx('e', { type: 'dispute', status: 'won', amount: 899 + 199 * 5, daysAgo: 6, objId: 'dp_seed_e_won', charge: 'ch_seed_e1', disputeFee: 1500, funds: 'reinstated', desc: 'Dispute: product_not_received (won)' });
  await tx('g', { type: 'dispute', status: 'lost', amount: 899, daysAgo: 20, objId: 'dp_seed_g_lost', charge: 'ch_seed_g1', disputeFee: 1500, funds: 'withdrawn', desc: 'Dispute: general (lost)' });
  // unmatched payment (no household)
  await tx(null, { type: 'payment', status: 'paid', amount: 899, daysAgo: 4, objId: 'in_seed_unmatched1', invoice: 'in_seed_unmatched1', charge: 'ch_seed_unmatched1', reason: 'subscription_create', fee: true, desc: 'Unmatched invoice' });

  // ---------- review items, runs ----------
  const run = await m.BillingReconciliationRun.create({
    id: randomUUID(), livemode: false, kind: 'manual', startedAt: new Date(now - 3600_000), finishedAt: new Date(now - 3500_000),
    status: 'succeeded', counts: { seed: true, subscriptions: 14, driftFixed: 1, needsReview: 4 },
  } as never);
  const item = (o: { kind: string; entityType: string; entityId?: string | null; obj: string; resolution?: 'needs_review' | 'auto_fixed' | 'resolved' | 'ignored'; before?: unknown; after?: unknown; run?: boolean; note?: string }) => {
    const res = o.resolution ?? 'needs_review';
    return m.BillingReconciliationItem.create({
      id: randomUUID(), runId: o.run ? run.id : null, livemode: false, kind: o.kind, entityType: o.entityType, entityId: o.entityId ?? null, providerObjectId: o.obj,
      before: o.before ?? null, after: o.after ?? null, resolution: res,
      resolvedBy: res === 'needs_review' ? null : res === 'auto_fixed' ? 'system' : 'seed',
      resolutionNote: o.note ?? null, resolvedAt: res === 'needs_review' ? null : new Date(),
    } as never);
  };
  await item({ kind: 'duplicate_subscription', entityType: 'household', entityId: by('n').householdId, obj: 'sub_seed_n_a,sub_seed_n_b', after: { kept: 'sub_seed_n_a', canceled: ['sub_seed_n_b'], outcomes: ['refunded'] } });
  await item({ kind: 'dispute_opened', entityType: 'dispute', entityId: by('c').householdId, obj: 'dp_seed_c_open', after: { amount: 10775, reason: 'fraudulent' } });
  await item({ kind: 'dispute_lost', entityType: 'dispute', entityId: by('g').householdId, obj: 'dp_seed_g_lost', after: { subscription: 'sub_seed_g' } });
  await item({ kind: 'unmatched_invoice', entityType: 'invoice', obj: 'in_seed_unmatched1', after: { customer: 'cus_seed_unknown' } });
  await item({ kind: 'unknown_price', entityType: 'subscription', obj: 'sub_seed_unknown', after: { priceId: 'price_seed_unknown' }, run: true });
  await item({ kind: 'subscription_drift', entityType: 'subscription', entityId: by('b').subIds[0], obj: 'sub_seed_b', resolution: 'auto_fixed', before: { seats: 5 }, after: { seats: 5, status: 'active' }, run: true });
  await item({ kind: 'missing_in_stripe', entityType: 'subscription', entityId: by('f').subIds[0], obj: 'sub_seed_f', resolution: 'resolved', note: 'seed: verified manually', run: true });
  await item({ kind: 'early_fraud_warning', entityType: 'early_fraud_warning', obj: 'issfr_seed_1', resolution: 'ignored', note: 'seed: ignored' });

  // ---------- webhook events ----------
  const evt = (id: string, status: 'processed' | 'failed' | 'dead', attempts: number, err: string | null) =>
    m.BillingEvent.create({
      id: randomUUID(), provider: 'stripe', livemode: false, providerEventId: id, type: 'customer.updated',
      payload: { id, object: 'event', type: 'customer.updated', livemode: false, created: Math.floor(now / 1000) - 3600, data: { object: { id: 'cus_seed_b', object: 'customer', metadata: { env: 'dev' } } } },
      status, attempts, lockedAt: null, lastError: err, receivedAt: new Date(now - 3600_000), processedAt: status === 'processed' ? new Date(now - 3590_000) : null,
    } as never);
  await evt('evt_seed_processed_1', 'processed', 1, null);
  await evt('evt_seed_processed_2', 'processed', 1, null);
  await evt('evt_seed_failed_1', 'failed', 3, 'seed: simulated handler failure');
  await evt('evt_seed_dead_1', 'dead', 8, 'seed: simulated exhausted retries');

  // ---------- caches ----------
  await Promise.all(created.map((c) => clearEntitlementCache(c.householdId)));

  // ---------- verify ----------
  const rows: Record<string, string>[] = [];
  let mismatches = 0;
  for (const c of created) {
    const ent = await getEntitlement(c.householdId, { bypassCache: true });
    const expected = `${c.sc.expected.allowed}/${c.sc.expected.reason}`;
    const actual = `${ent.allowed}/${ent.reason}`;
    let seatNote = `members ${c.sc.members}/${ent.seatsAllowed}`;
    try { await sequelize.transaction((t) => assertSeatAvailable(c.householdId, t)); seatNote += ' join:ok'; } catch (e) { seatNote += ` join:${(e as { code?: string }).code ?? 'err'}`; }
    if (expected !== actual) mismatches++;
    rows.push({ scenario: `${c.sc.key.toUpperCase()} ${c.sc.title}`, householdId: c.householdId, adminEmail: email(c.sc.key, 'admin'), expected, actual, seats: seatNote, ok: expected === actual ? 'OK' : 'MISMATCH' });
  }
  console.table(rows);
  const like = (col: string, pat: string) => ({ where: { [col]: { [Op.like]: pat } } });
  console.log('Created:', JSON.stringify({
    households: created.length, users: created.reduce((s, c) => s + 1 + c.memberIds.length, 0),
    subscriptions: await m.BillingSubscription.count(like('providerSubscriptionId', '%seed%')),
    transactions: await m.BillingTransaction.count(like('providerObjectId', '%seed%')),
    reviewItems: await m.BillingReconciliationItem.count(like('providerObjectId', '%seed%')),
    events: await m.BillingEvent.count(like('providerEventId', 'evt\\_seed\\_%')),
  }));
  console.log(`Login: email/password via POST /api/v1/auth/login. Members: seed+<scenario>-member<N>@${EMAIL_DOMAIN}. Password: SEED_PASSWORD constant in scripts/dev/seed-billing.ts`);
  console.log('Invite codes (join-seat tests): ' + created.filter((c) => ['c', 'd', 'e'].includes(c.sc.key)).map((c) => `${c.sc.key.toUpperCase()}=${c.inviteCode}`).join(' '));

  await sequelize.close();
  redis.disconnect();
  if (mismatches) { console.error(`${mismatches} scenario(s) did not match expected entitlement`); process.exit(1); }
}

if (require.main === module) {
  main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
}
