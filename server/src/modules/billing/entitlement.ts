import { Request, Response, NextFunction, RequestHandler } from 'express';
import { Op, Transaction } from 'sequelize';
import { Household, BillingSubscription, HouseholdMember } from '../../database/models';
import { AuthenticatedRequest } from '../../shared/middleware/auth';
import { NotFoundError } from '../../shared/utils/errors';
import { NoHouseholdError, PaymentRequiredError } from './errors';
import { cacheDel, cacheGetJson, cacheSetJson, entitlementKey } from './cache';
import { SEATS_INCLUDED, SEATS_MAX } from './catalog';
import { livemodeOf, resolveMode } from './mode';
import {
  ALLOWED_STATUSES, BillingCohort, BillingInterval, BillingMode, BillingProvider, Entitlement, EntitlementSubscription, SubscriptionStatus,
} from './types';

export const ENTITLEMENT_TTL_SEC = 60;

export interface SubscriptionSnapshot {
  id: string;
  provider: BillingProvider;
  status: SubscriptionStatus;
  seats: number;
  interval: BillingInterval;
  graceUntil: Date | null;
  createdAt: Date;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}

export function toSnapshot(row: BillingSubscription): SubscriptionSnapshot {
  return {
    id: row.id, provider: row.provider, status: row.status, seats: row.seats, interval: row.interval,
    graceUntil: row.graceUntil, createdAt: row.createdAt, currentPeriodEnd: row.currentPeriodEnd, cancelAtPeriodEnd: row.cancelAtPeriodEnd,
  };
}

function view(s: SubscriptionSnapshot): EntitlementSubscription {
  return {
    id: s.id, provider: s.provider, status: s.status, seats: s.seats, interval: s.interval,
    currentPeriodEnd: s.currentPeriodEnd ? s.currentPeriodEnd.toISOString() : null, cancelAtPeriodEnd: s.cancelAtPeriodEnd,
  };
}

export function computeEntitlement(input: {
  cohort: BillingCohort; mode: BillingMode; subscriptions: SubscriptionSnapshot[]; now: Date;
}): Entitlement {
  const { cohort, mode, now } = input;
  const candidates = input.subscriptions
    .filter((s) => ALLOWED_STATUSES.includes(s.status))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const healthy = candidates.find((s) => s.status === 'active' || s.status === 'trialing');
  const pastDue = candidates.find((s) => s.status === 'past_due');

  if (cohort === 'test') {
    const best = healthy ?? pastDue;
    return { allowed: true, reason: 'test_cohort', mode, subscription: best ? view(best) : null, graceUntil: null, seatsAllowed: SEATS_MAX };
  }
  if (healthy) {
    return { allowed: true, reason: 'active', mode, subscription: view(healthy), graceUntil: null, seatsAllowed: healthy.seats };
  }
  if (pastDue && pastDue.graceUntil && now.getTime() < pastDue.graceUntil.getTime()) {
    return { allowed: true, reason: 'grace', mode, subscription: view(pastDue), graceUntil: pastDue.graceUntil.toISOString(), seatsAllowed: pastDue.seats };
  }
  return {
    allowed: false, reason: 'subscription_required', mode, subscription: pastDue ? view(pastDue) : null,
    graceUntil: pastDue?.graceUntil ? pastDue.graceUntil.toISOString() : null, seatsAllowed: SEATS_INCLUDED,
  };
}

export async function getEntitlement(householdId: string, opts: { bypassCache?: boolean } = {}): Promise<Entitlement> {
  const household = await Household.findByPk(householdId, { paranoid: false, attributes: ['id', 'billingCohort'] });
  if (!household) throw new NotFoundError('Household');
  const mode = resolveMode(household);
  const key = entitlementKey(mode, householdId);
  if (!opts.bypassCache) {
    const cached = await cacheGetJson<Entitlement>(key);
    if (cached) return cached;
  }
  const rows = await BillingSubscription.findAll({
    where: { householdId, livemode: livemodeOf(mode), status: { [Op.in]: [...ALLOWED_STATUSES] } },
  });
  const ent = computeEntitlement({ cohort: household.billingCohort, mode, subscriptions: rows.map(toSnapshot), now: new Date() });
  await cacheSetJson(key, ent, ENTITLEMENT_TTL_SEC);
  return ent;
}

export async function clearEntitlementCache(householdId: string): Promise<void> {
  await cacheDel(entitlementKey('test', householdId), entitlementKey('live', householdId));
}

/** For background jobs (ยง7.2): one query per table, no cache. */
export async function isEntitledBatch(householdIds: string[], now: Date = new Date()): Promise<Set<string>> {
  const ids = [...new Set(householdIds)];
  if (ids.length === 0) return new Set();
  const households = await Household.findAll({ where: { id: ids }, paranoid: false, attributes: ['id', 'billingCohort'] });
  const subs = await BillingSubscription.findAll({ where: { householdId: ids, status: { [Op.in]: [...ALLOWED_STATUSES] } } });
  const allowed = new Set<string>();
  for (const h of households) {
    const mode = resolveMode(h);
    const mine = subs.filter((s) => s.householdId === h.id && s.livemode === livemodeOf(mode)).map(toSnapshot);
    if (computeEntitlement({ cohort: h.billingCohort, mode, subscriptions: mine, now }).allowed) allowed.add(h.id);
  }
  return allowed;
}

export interface BillingRequest extends AuthenticatedRequest {
  billing?: { householdId: string; entitlement: Entitlement; role: 'admin' | 'member' | 'child' };
}

async function requireEntitlementAsync(req: Request, next: NextFunction): Promise<void> {
  const userId = (req as AuthenticatedRequest).user!.userId;
  const membership = await HouseholdMember.findOne({ where: { userId }, attributes: ['householdId', 'role'] });
  if (!membership) throw new NoHouseholdError();
  const entitlement = await getEntitlement(membership.householdId);
  if (!entitlement.allowed) {
    throw new PaymentRequiredError('SUBSCRIPTION_REQUIRED', 'A Rootaroo subscription is required', {
      reason: entitlement.reason, isAdmin: membership.role === 'admin',
    });
  }
  (req as BillingRequest).billing = { householdId: membership.householdId, entitlement, role: membership.role };
  next();
}

/** Mounted inside each guarded router, after `authenticate` (ง7.2). */
export const requireEntitlement: RequestHandler = (req: Request, _res: Response, next: NextFunction) => {
  requireEntitlementAsync(req, next).catch(next);
};

export async function seatsAllowedInTransaction(householdId: string, transaction: Transaction): Promise<number> {
  const household = await Household.findByPk(householdId, { transaction, lock: Transaction.LOCK.UPDATE, paranoid: false });
  if (!household) throw new NotFoundError('Household');
  const mode = resolveMode(household);
  const rows = await BillingSubscription.findAll({
    where: { householdId, livemode: livemodeOf(mode), status: { [Op.in]: [...ALLOWED_STATUSES] } },
    transaction,
  });
  const ent = computeEntitlement({ cohort: household.billingCohort, mode, subscriptions: rows.map(toSnapshot), now: new Date() });
  return Math.min(ent.seatsAllowed, SEATS_MAX);
}

export async function assertSeatAvailable(householdId: string, transaction: Transaction): Promise<void> {
  const seatsAllowed = await seatsAllowedInTransaction(householdId, transaction);
  const memberCount = await HouseholdMember.count({ where: { householdId }, transaction });
  if (memberCount >= seatsAllowed) {
    throw new PaymentRequiredError('SEAT_LIMIT', `This household's plan allows ${seatsAllowed} members`, { seatsAllowed, memberCount });
  }
}
