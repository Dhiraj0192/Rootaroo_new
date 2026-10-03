import crypto from 'crypto';
import Stripe from 'stripe';
import { UniqueConstraintError, Op } from 'sequelize';
import { v4 as uuidv4 } from 'uuid';
import { BillingCheckoutSession, BillingCustomer, BillingSubscription, Household, HouseholdMember, User } from '../../database/models';
import { AppError, ForbiddenError, NotFoundError } from '../../shared/utils/errors';
import logger from '../../shared/utils/logger';
import { assertSeats, getCatalog, priceFor } from './catalog';
import { getBillingConfig, getStripe, isModeAvailable } from './config';
import { CallerContext, loadCallerContext, requireAdminContext } from './context';
import { autoRenewDisclosure } from './copy';
import { getEntitlement } from './entitlement';
import { BillingConflictError, BillingUnavailableError } from './errors';
import { withLock } from './locks';
import { livemodeOf } from './mode';
import { getPlansForMode, PlansResponse } from './plans';
import { createPortalUrl } from './portal';
import { isStripeCheckoutAllowed, resolvePurchaseMethod } from './routing';
import { idOf, upsertSubscription } from './sync';
import type { BillingInterval, BillingMode, CheckoutState, ClientContext, Entitlement, PendingCheckout, PurchaseMethod } from './types';

export interface CheckoutBody { interval: BillingInterval; seats: number }
export interface CheckoutResult { url: string; sessionId: string }

export const CHECKOUT_SESSION_TTL_SEC = 31 * 60; // Stripe minimum is 30 min; +1 min for clock drift (T7)

export function checkoutLockName(householdId: string, mode: BillingMode): string {
  return `billing:checkout:${householdId}:${mode}`;
}

const envOk = (s: Stripe.Subscription) => !s.metadata?.env || s.metadata.env === getBillingConfig().envTag;

export async function paymentIssueError(mode: BillingMode, customerId: string | null): Promise<BillingConflictError> {
  let portalUrl: string | null = null;
  if (customerId) {
    try {
      portalUrl = await createPortalUrl(mode, customerId);
    } catch (err) {
      logger.warn(`[Billing] portal URL for PAYMENT_ISSUE failed: ${(err as Error).message}`);
    }
  }
  return new BillingConflictError('PAYMENT_ISSUE', 'Your last payment failed. Update your payment method to continue.', { portalUrl });
}

async function saveCustomerRow(where: { householdId: string; provider: 'stripe'; livemode: boolean }, customer: { id: string; email?: string | null }, fallbackEmail: string | null): Promise<string> {
  try {
    await BillingCustomer.create({ ...where, providerCustomerId: customer.id, billingEmail: customer.email ?? fallbackEmail });
  } catch (err) {
    if (!(err instanceof UniqueConstraintError)) throw err;
    const again = await BillingCustomer.findOne({ where });
    if (again) return again.providerCustomerId;
    throw err;
  }
  return customer.id;
}

/** Local row first, then a Stripe metadata search (recovers a lost row). Null when the household has no customer. */
export async function findExistingCustomer(household: Household, mode: BillingMode): Promise<string | null> {
  const livemode = livemodeOf(mode);
  const where = { householdId: household.id, provider: 'stripe' as const, livemode };
  const existing = await BillingCustomer.findOne({ where });
  if (existing) return existing.providerCustomerId;
  const { envTag } = getBillingConfig();
  // Search query syntax per https://docs.stripe.com/search.md#query-fields-for-customers: metadata['key']:'value'.
  const found = await getStripe(mode).customers.search({ query: `metadata['householdId']:'${household.id}' AND metadata['env']:'${envTag}'`, limit: 1 });
  const customer = found.data[0];
  return customer ? saveCustomerRow(where, customer, null) : null;
}

export async function findOrCreateCustomer(household: Household, mode: BillingMode, admin: User, known?: string | null): Promise<string> {
  const existing = known === undefined ? await findExistingCustomer(household, mode) : known;
  if (existing) return existing;
  const livemode = livemodeOf(mode);
  const where = { householdId: household.id, provider: 'stripe' as const, livemode };
  const { envTag } = getBillingConfig();
  const params = { email: admin.email, name: household.name, metadata: { householdId: household.id, env: envTag } };
  // The key is derived from the exact params it protects: Stripe rejects/replays a reused key with different params.
  const paramsHash = crypto.createHash('sha256').update(JSON.stringify(params)).digest('hex').slice(0, 16);
  const customer = await getStripe(mode).customers.create(params, { idempotencyKey: `cust:${household.id}:${mode}:${paramsHash}` });
  return saveCustomerRow(where, customer, admin.email);
}

async function expireOrSync(row: BillingCheckoutSession, mode: BillingMode): Promise<void> {
  if (!row.providerSessionId) { await row.update({ status: 'failed' }); return; }
  const stripe = getStripe(mode);
  try {
    await stripe.checkout.sessions.expire(row.providerSessionId);
    await row.update({ status: 'expired' });
  } catch (err) {
    const session = await stripe.checkout.sessions.retrieve(row.providerSessionId);
    if (session.status === 'complete') {
      await row.update({ status: 'complete' });
      const subId = idOf(session.subscription as string | { id: string } | null);
      if (subId) await upsertSubscription(subId, mode);
      throw new BillingConflictError('ALREADY_SUBSCRIBED', 'This household has just subscribed');
    }
    if (session.status === 'expired') { await row.update({ status: 'expired' }); return; }
    throw err;
  }
}

async function createCheckoutLocked(ctx: CallerContext, body: CheckoutBody, now: Date): Promise<CheckoutResult> {
  const { household, mode } = ctx;
  const livemode = livemodeOf(mode);
  const stripe = getStripe(mode);
  const cfg = getBillingConfig();

  // 4(a) local state: any allowed subscription, from any provider, blocks a new checkout
  const local = await BillingSubscription.findAll({
    where: { householdId: household.id, livemode, status: { [Op.in]: ['active', 'trialing', 'past_due', 'unpaid'] } },
  });
  if (local.some((s) => s.status === 'active' || s.status === 'trialing')) {
    throw new BillingConflictError('ALREADY_SUBSCRIBED', 'This household already has a subscription');
  }
  // Recover the customer (local row, else Stripe search) before any Stripe-side check, so a lost row cannot hide a subscription.
  const customerId = await findExistingCustomer(household, mode);
  if (local.length > 0) {
    throw await paymentIssueError(mode, customerId); // portal URL only when a Stripe customer exists
  }
  // 4(b) Stripe state
  if (customerId) {
    const subs = (await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 10 })).data.filter(envOk);
    const healthy = subs.find((s) => s.status === 'active' || s.status === 'trialing');
    if (healthy) {
      await upsertSubscription(healthy.id, mode);
      throw new BillingConflictError('ALREADY_SUBSCRIBED', 'This household already has a subscription');
    }
    if (subs.some((s) => s.status === 'past_due' || s.status === 'unpaid')) {
      throw await paymentIssueError(mode, customerId);
    }
  }
  // 5. seats
  if (body.seats < ctx.memberCount) {
    throw new BillingConflictError('SEATS_BELOW_MEMBERS', `Your household has ${ctx.memberCount} members. Choose a plan with at least that many.`, { memberCount: ctx.memberCount });
  }
  // 6. reuse or retire the open session
  const open = await BillingCheckoutSession.findOne({ where: { householdId: household.id, livemode, status: 'open' }, order: [['createdAt', 'DESC']] });
  if (open) {
    const reusable = open.url && open.providerSessionId && open.expiresAt && open.expiresAt.getTime() > now.getTime() + 60_000;
    if (reusable && open.interval === body.interval && open.seats === body.seats) return { url: open.url!, sessionId: open.providerSessionId! };
    await expireOrSync(open, mode);
  }
  // 7. customer
  const admin = await User.findByPk(ctx.userId, { paranoid: false });
  if (!admin) throw new NotFoundError('User');
  const stripeCustomerId = await findOrCreateCustomer(household, mode, admin, customerId);
  // 8. session
  const price = priceFor(await getCatalog(mode), body.interval, body.seats);
  const expiresAt = Math.floor(now.getTime() / 1000) + CHECKOUT_SESSION_TTL_SEC;
  const row = await BillingCheckoutSession.create({
    id: uuidv4(), householdId: household.id, livemode, createdByUserId: ctx.userId,
    interval: body.interval, seats: body.seats, status: 'creating', expiresAt: new Date(expiresAt * 1000),
  });
  let session: Stripe.Checkout.Session;
  try {
    // Parameters verified against https://docs.stripe.com/api/checkout/sessions/create.md:
    // origin_context (mobile_app|web), integration_identifier, expires_at (30 min to 24 h), custom_text.submit.
    session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: stripeCustomerId,
      client_reference_id: household.id,
      line_items: [{ price: price.priceId, quantity: 1 }],
      subscription_data: { metadata: { householdId: household.id, purchasedByUserId: ctx.userId, env: cfg.envTag } },
      metadata: { householdId: household.id, env: cfg.envTag },
      origin_context: 'mobile_app',
      expires_at: expiresAt,
      allow_promotion_codes: false,
      ...(cfg.requireTosConsent ? { consent_collection: { terms_of_service: 'required' as const } } : {}),
      custom_text: { submit: { message: autoRenewDisclosure(price.amount, body.interval) } },
      success_url: `${cfg.publicBaseUrl}/api/v1/billing/return/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${cfg.publicBaseUrl}/api/v1/billing/return/cancel`,
      integration_identifier: cfg.integrationId,
    }, { idempotencyKey: `cs:${row.id}` });
  } catch (err) {
    await row.update({ status: 'failed' });
    logger.error(`[Billing] checkout.sessions.create failed for household ${household.id}:`, err);
    throw new AppError(502, 'Could not start checkout. Please try again.', 'CHECKOUT_FAILED');
  }
  // 9.
  await row.update({ status: 'open', providerSessionId: session.id, url: session.url });
  return { url: session.url!, sessionId: session.id };
}

export async function createCheckout(userId: string, body: CheckoutBody, client: ClientContext, now: Date = new Date()): Promise<CheckoutResult> {
  const ctx = await requireAdminContext(userId);
  if (!isModeAvailable(ctx.mode)) throw new BillingUnavailableError();
  const method = await resolvePurchaseMethod(client, ctx.household.billingCohort);
  if (!isStripeCheckoutAllowed(method, ctx.household.billingCohort)) {
    throw new BillingConflictError('PURCHASE_METHOD_MISMATCH', 'Purchases on this device go through a different store', { purchaseMethod: method });
  }
  assertSeats(body.seats);
  return withLock(checkoutLockName(ctx.household.id, ctx.mode), 60_000, () => createCheckoutLocked(ctx, body, now), { waitMs: 10_000 });
}

export function deriveCheckoutState(sessionStatus: string | null, allowed: boolean): CheckoutState {
  if (sessionStatus === 'complete') return allowed ? 'complete' : 'processing';
  if (sessionStatus === 'expired') return 'expired';
  return 'open';
}

export interface SyncResult { entitlement: Entitlement; pendingCheckout: PendingCheckout }

export async function syncCheckout(userId: string, sessionId: string): Promise<SyncResult> {
  const ctx = await loadCallerContext(userId);
  const { household, mode } = ctx;
  const denied = () => new ForbiddenError('This checkout session does not belong to your household');
  if (sessionId.startsWith('cs_live_') !== (mode === 'live')) throw denied();
  const stripe = getStripe(mode);
  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['subscription'] });
  } catch (err) {
    if ((err as { code?: string }).code === 'resource_missing') throw denied();
    throw err;
  }
  const customer = await BillingCustomer.findOne({ where: { householdId: household.id, provider: 'stripe', livemode: livemodeOf(mode) } });
  if (session.client_reference_id !== household.id || !customer || idOf(session.customer as string | { id: string } | null) !== customer.providerCustomerId) {
    throw denied();
  }
  const row = await BillingCheckoutSession.findOne({ where: { providerSessionId: sessionId } });
  if (session.status === 'complete') {
    if (row && row.status !== 'complete') await row.update({ status: 'complete' });
    const subId = idOf(session.subscription as string | { id: string } | null);
    if (subId) await upsertSubscription(subId, mode);
  } else if (session.status === 'expired' && row) {
    await row.update({ status: 'expired' });
  }
  const entitlement = await getEntitlement(household.id, { bypassCache: true });
  return { entitlement, pendingCheckout: { sessionId, state: deriveCheckoutState(session.status, entitlement.allowed) } };
}

export interface SubscriptionView {
  provider: string; status: string; interval: string; seats: number; unitAmount: number | null; currency: string | null;
  priceSet: string | null; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean; graceUntil: string | null; pendingUpdate: boolean;
}

export interface BillingStatus {
  /** The id the stores echo back (appAccountToken / obfuscatedAccountId) so purchases link to this household. */
  householdId: string;
  entitlement: Entitlement;
  subscription: SubscriptionView | null;
  isAdmin: boolean;
  adminNames: string[];
  purchaseMethod: PurchaseMethod;
  plans: PlansResponse | null;
  pendingCheckout: PendingCheckout | null;
  memberCount: number;
}

export async function getBillingStatus(userId: string, client: ClientContext): Promise<BillingStatus> {
  const ctx = await loadCallerContext(userId);
  const { household, mode } = ctx;
  const livemode = livemodeOf(mode);
  const entitlement = await getEntitlement(household.id);
  const sub = await BillingSubscription.findOne({ where: { householdId: household.id, livemode }, order: [['updatedAt', 'DESC']] });
  const admins = await HouseholdMember.findAll({ where: { householdId: household.id, role: 'admin' }, include: [{ model: User, as: 'user', required: true }] });
  let plans: PlansResponse | null = null;
  try { plans = await getPlansForMode(mode); } catch (err) { logger.warn(`[Billing] plans unavailable: ${(err as Error).message}`); }

  const recent = await BillingCheckoutSession.findOne({
    where: { householdId: household.id, livemode, status: { [Op.in]: ['open', 'complete'] }, createdAt: { [Op.gte]: new Date(Date.now() - 2 * 3600_000) } },
    order: [['createdAt', 'DESC']],
  });
  let pendingCheckout: PendingCheckout | null = null;
  if (recent?.providerSessionId) {
    if (recent.status === 'open' && recent.expiresAt && recent.expiresAt.getTime() > Date.now()) pendingCheckout = { sessionId: recent.providerSessionId, state: 'open' };
    else if (recent.status === 'complete' && !entitlement.allowed) pendingCheckout = { sessionId: recent.providerSessionId, state: 'processing' };
  }

  return {
    householdId: household.id,
    entitlement,
    subscription: sub ? {
      provider: sub.provider, status: sub.status, interval: sub.interval, seats: sub.seats, unitAmount: sub.unitAmount, currency: sub.currency,
      priceSet: sub.priceSet, currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null, cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      graceUntil: sub.graceUntil?.toISOString() ?? null, pendingUpdate: sub.pendingUpdate !== null,
    } : null,
    isAdmin: ctx.isAdmin,
    adminNames: admins.map((a) => a.user!.displayName),
    purchaseMethod: await resolvePurchaseMethod(client, household.billingCohort),
    plans,
    pendingCheckout,
    memberCount: ctx.memberCount,
  };
}
