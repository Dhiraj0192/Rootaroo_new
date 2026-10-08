import { Household, HouseholdMember } from '../../database/models';
import { ForbiddenError } from '../../shared/utils/errors';
import { NoHouseholdError } from './errors';
import { resolveMode } from './mode';
import type { BillingMode } from './types';

export interface CallerContext {
  userId: string;
  household: Household;
  membership: HouseholdMember;
  isAdmin: boolean;
  mode: BillingMode;
  memberCount: number;
}

export async function loadCallerContext(userId: string): Promise<CallerContext> {
  const membership = await HouseholdMember.findOne({ where: { userId } });
  if (!membership) throw new NoHouseholdError();
  const household = await Household.findByPk(membership.householdId, { paranoid: false });
  if (!household) throw new NoHouseholdError();
  const memberCount = await HouseholdMember.count({ where: { householdId: household.id } });
  return {
    userId, household, membership, isAdmin: membership.role === 'admin', mode: resolveMode(household), memberCount,
  };
}

export async function requireAdminContext(userId: string): Promise<CallerContext> {
  const ctx = await loadCallerContext(userId);
  if (!ctx.isAdmin) throw new ForbiddenError('Only a household admin can manage billing');
  return ctx;
}

