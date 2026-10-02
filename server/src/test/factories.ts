import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { env } from '../config/env';
import { User, Household, HouseholdMember } from '../database/models';

let seq = 0;
const next = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

export async function createUser(
  overrides: Partial<{ email: string; displayName: string; role: 'admin' | 'member' | 'child' }> = {},
): Promise<User> {
  const n = next();
  return User.create({
    id: uuidv4(),
    email: overrides.email ?? `user-${n}@example.test`,
    passwordHash: 'not-a-real-hash',
    displayName: overrides.displayName ?? `User ${n}`,
    role: overrides.role ?? 'member',
    isVerified: true,
  });
}

export async function createHouseholdWithAdmin(
  opts: { name?: string; cohort?: 'live' | 'test'; admin?: User } = {},
): Promise<{ household: Household; admin: User }> {
  const admin = opts.admin ?? (await createUser({ role: 'admin' }));
  const household = await Household.create({
    id: uuidv4(),
    name: opts.name ?? 'Test Family',
    inviteCode: crypto.randomBytes(4).toString('hex').toUpperCase(),
    ...(opts.cohort ? { billingCohort: opts.cohort } : {}),
  });
  await HouseholdMember.create({ id: uuidv4(), householdId: household.id, userId: admin.id, role: 'admin', joinedAt: new Date() });
  return { household, admin };
}

export async function addMember(
  householdId: string,
  overrides: { role?: 'member' | 'child'; user?: User } = {},
): Promise<User> {
  const user = overrides.user ?? (await createUser({ role: overrides.role ?? 'member' }));
  await HouseholdMember.create({ id: uuidv4(), householdId, userId: user.id, role: overrides.role ?? 'member', joinedAt: new Date() });
  return user;
}

export function authHeaderFor(user: User): { Authorization: string } {
  const token = jwt.sign({ userId: user.id, email: user.email, role: user.role }, env.jwt.accessSecret, { expiresIn: '15m' });
  return { Authorization: `Bearer ${token}` };
}
