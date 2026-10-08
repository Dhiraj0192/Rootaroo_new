import { Request } from 'express';
import { sequelize, BillingRoutingRule } from '../../database/models';
import { env } from '../../config/env';
import { ValidationError } from '../../shared/utils/errors';
import type { BillingCohort, ClientContext, ClientPlatform, PurchaseMethod } from './types';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { defaultRoutingRules } = require('../../database/billingSeeds');

export interface RuleRow { platform: ClientPlatform; country: string; method: PurchaseMethod }

const PLATFORMS: ClientPlatform[] = ['ios', 'android', 'web'];
const METHODS: PurchaseMethod[] = ['stripe_checkout', 'apple_iap', 'google_play', 'none'];
const RULE_TTL_MS = 60_000;
let cache: { rules: RuleRow[]; expires: number } | null = null;

export function normalizePlatform(v: unknown): ClientPlatform {
  const p = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return (PLATFORMS as string[]).includes(p) ? (p as ClientPlatform) : 'web';
}

export function normalizeCountry(v: unknown): string {
  return typeof v === 'string' && /^[A-Za-z]{2}$/.test(v.trim()) ? v.trim().toUpperCase() : 'ZZ';
}

export function parseClientContext(req: Request): ClientContext {
  return { platform: normalizePlatform(req.header('x-platform')), country: normalizeCountry(req.header('x-store-country')) };
}

export function matchRule(rules: RuleRow[], platform: ClientPlatform, country: string): PurchaseMethod {
  return rules.find((r) => r.platform === platform && r.country === country)?.method
    ?? rules.find((r) => r.platform === platform && r.country === '*')?.method
    ?? 'none';
}

export function clearRoutingCache(): void { cache = null; }

export async function loadRules(): Promise<RuleRow[]> {
  if (cache && cache.expires > Date.now()) return cache.rules;
  const rows = await BillingRoutingRule.findAll();
  const rules = rows.map((r) => ({ platform: r.platform, country: r.country, method: r.method }));
  cache = { rules, expires: Date.now() + RULE_TTL_MS };
  return rules;
}

export async function resolvePurchaseMethod(ctx: ClientContext, cohort: BillingCohort): Promise<PurchaseMethod> {
  const method = matchRule(await loadRules(), ctx.platform, ctx.country);
  // §12: the test cohort can always test Stripe checkout, on any platform.
  return cohort === 'test' ? 'stripe_checkout' : method;
}

export function isStripeCheckoutAllowed(method: PurchaseMethod, cohort: BillingCohort, nodeEnv: string = env.nodeEnv): boolean {
  return method === 'stripe_checkout' || cohort === 'test' || nodeEnv !== 'production';
}

export function validateRules(rules: RuleRow[]): void {
  const seen = new Set<string>();
  for (const r of rules) {
    if (!PLATFORMS.includes(r.platform)) throw new ValidationError(`invalid platform ${String(r.platform)}`);
    if (!(r.country === '*' || /^[A-Z]{2}$/.test(r.country))) throw new ValidationError(`invalid country ${r.country}`);
    if (!METHODS.includes(r.method)) throw new ValidationError(`invalid method ${String(r.method)}`);
    const key = `${r.platform}:${r.country}`;
    if (seen.has(key)) throw new ValidationError(`duplicate rule ${key}`);
    seen.add(key);
  }
}

export async function replaceRoutingRules(rules: RuleRow[], updatedBy: string): Promise<RuleRow[]> {
  validateRules(rules);
  await sequelize.transaction(async (transaction) => {
    await BillingRoutingRule.destroy({ where: {}, transaction });
    await BillingRoutingRule.bulkCreate(rules.map((r) => ({ ...r, updatedBy })), { transaction });
  });
  clearRoutingCache();
  return rules;
}

export async function seedDefaultRoutingRules(nodeEnv = 'development'): Promise<void> {
  await BillingRoutingRule.bulkCreate((defaultRoutingRules(nodeEnv) as RuleRow[]).map((r) => ({ ...r, updatedBy: 'seed' })));
  clearRoutingCache();
}
