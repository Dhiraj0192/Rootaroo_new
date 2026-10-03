import Stripe from 'stripe';
import { UniqueConstraintError, Op } from 'sequelize';
import { v4 as uuidv4 } from 'uuid';
import { BillingCheckoutSession, BillingCustomer, BillingSubscription, Household, User } from '../../database/models';
import { AppError, NotFoundError } from '../../shared/utils/errors';
import logger from '../../shared/utils/logger';
import { assertSeats, getCatalog, priceFor } from './catalog';
import { getBillingConfig, getStripe, isModeAvailable } from './config';
import { CallerContext, requireAdminContext } from './context';
import { autoRenewDisclosure } from './copy';
import { BillingConflictError, BillingUnavailableError } from './errors';
import { withLock } from './locks';
import { livemodeOf } from './mode';
import { createPortalUrl } from './portal';
import { isStripeCheckoutAllowed, resolvePurchaseMethod } from './routing';
import { idOf, upsertSubscription } from './sync';
import type { BillingInterval, BillingMode, ClientContext } from './types';

export interface CheckoutBody { interval: BillingInterval; seats: number }
export interface CheckoutResult { url: string; sessionId: string }

export const CHECKOUT_SESSION_TTL_SEC = 31 * 60; // Stripe minimum is 30 min; +1 min for clock drift (T7)

export function checkoutLockName(householdId: string, mode: BillingMode): string {
  return `billing:checkout:${householdId}:${mode}`;
}

const envOk = (s: Stripe.Subscription) => !s.metadata?.env || s.metadata.env === getBillingConfig().envTag;

export async function paymentIssueError(mode: BillingMode, customerId: string): Promise<BillingConflictError> {
  let portalUrl: string | null = null;
  try {
    portalUrl = await createPortalUrl(mode, customerId);
  } catch (err) {
    logger.warn(`[Billing] portal URL for PAYMENT_ISSUE failed: ${(err as Error).message}`);
  }
  return new BillingConflictError('PAYMENT_ISSUE', 'Your last payment failed. Update your payment method to continue.', { portalUrl });
}

export async function findOrCreateCustomer(household: Household, mode: BillingMode, admin: User): Promise<string> {
  const livemode = livemodeOf(mode);
  const where = { householdId: household.id, provider: 'stripe' as const, livemode };
  const existing = await BillingCustomer.findOne({ where });
  if (existing) return existing.providerCustomerId;

  const stripe = getStripe(mode);
  const { envTag } = getBillingConfig();
  // Search query syntax per https://docs.stripe.com/search.md#query-fields-for-customers: metadata['key']:'value'.
  const found = await stripe.customers.search({ query: `metadata['householdId']:'${household.id}' AND metadata['env']:'${envTag}'`, limit: 1 });
  const customer = found.data[0] ?? await stripe.customers.create(
    { email: admin.email, name: household.name, metadata: { householdId: household.id, env: envTag } },
    { idempotencyKey: `cust:${household.id}:${mode}:${admin.id}` },
  );
  try {
    await BillingCustomer.create({ ...where, providerCustomerId: customer.id, billingEmail: customer.email ?? admin.email });
  } catch (err) {
    if (!(err instanceof UniqueConstraintError)) throw err;
    const again = await BillingCustomer.findOne({ where });
    if (again) return again.providerCustomerId;
    throw err;
  }
  return customer.id;
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

  // 4(a) local state
  const local = await BillingSubscription.findAll({
    where: { householdId: household.id, livemode, status: { [Op.in]: ['active', 'trialing', 'past_due', 'unpaid'] } },
  });
  if (local.some((s) => s.status === 'active' || s.status === 'trialing')) {
    throw new BillingConflictError('ALREADY_SUBSCRIBED', 'This household already has a subscription');
  }
  const customerRow = await BillingCustomer.findOne({ where: { householdId: household.id, provider: 'stripe', livemode } });
  if (customerRow && local.some((s) => s.status === 'past_due' || s.status === 'unpaid')) {
    throw await paymentIssueError(mode, customerRow.providerCustomerId);
  }
  // 4(b) Stripe state
  if (customerRow) {
    const subs = (await stripe.subscriptions.list({ customer: customerRow.providerCustomerId, status: 'all', limit: 10 })).data.filter(envOk);
    const healthy = subs.find((s) => s.status === 'active' || s.status === 'trialing');
    if (healthy) {
      await upsertSubscription(healthy.id, mode);
      throw new BillingConflictError('ALREADY_SUBSCRIBED', 'This household already has a subscription');
    }
    if (subs.some((s) => s.status === 'past_due' || s.status === 'unpaid')) {
      throw await paymentIssueError(mode, customerRow.providerCustomerId);
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
  const customerId = await findOrCreateCustomer(household, mode, admin);
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
      customer: customerId,
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
