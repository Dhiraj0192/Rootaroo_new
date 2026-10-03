import { Op } from 'sequelize';
import { AdminAuditLog, BillingCustomer, BillingSubscription } from '../../database/models';
import logger from '../../shared/utils/logger';
import { getStripe, isModeAvailable } from './config';
import { clearEntitlementCache } from './entitlement';
import { anonymizeUserLedger } from './ledger';
import { modeFromLivemode } from './mode';
import { getAdminRecipients, notifyHouseholdAdmins } from './notify';
import { raiseReviewItem } from './review';
import { upsertSubscription } from './sync';
import { ALLOWED_STATUSES } from './types';

const allowedWhere = { status: { [Op.in]: [...ALLOWED_STATUSES] } };

export async function syncBillingEmail(householdId: string, excludeUserId?: string): Promise<void> {
  const customers = await BillingCustomer.findAll({ where: { householdId, provider: 'stripe' } });
  if (customers.length === 0) return;
  const [admin] = await getAdminRecipients(householdId, excludeUserId);
  const email = admin?.email ?? null;
  for (const c of customers) {
    await c.update({ billingEmail: email });
    const mode = modeFromLivemode(c.livemode);
    if (!isModeAvailable(mode)) continue;
    try {
      // Clearing a customer email is done with an empty string (https://docs.stripe.com/api/customers/update.md).
      await getStripe(mode).customers.update(c.providerCustomerId, { email: email ?? '' });
    } catch (err) {
      logger.warn(`[Billing] customers.update failed for ${c.providerCustomerId}; reconciliation will retry: ${(err as Error).message}`);
    }
  }
}

export async function setCancelAtPeriodEndForHousehold(householdId: string, value: boolean, reason: string): Promise<string[]> {
  const subs = await BillingSubscription.findAll({ where: { householdId, provider: 'stripe', ...allowedWhere } });
  const changed: string[] = [];
  for (const sub of subs) {
    if (sub.cancelAtPeriodEnd === value) continue;
    const mode = modeFromLivemode(sub.livemode);
    await getStripe(mode).subscriptions.update(sub.providerSubscriptionId, { cancel_at_period_end: value }, { idempotencyKey: `${reason}:${sub.providerSubscriptionId}:${value}` });
    await upsertSubscription(sub.providerSubscriptionId, mode);
    changed.push(sub.providerSubscriptionId);
  }
  return changed;
}

/** §5.11: runs from finalizeUserDeletion after the 30-day window. */
export async function onPurchaserDeleted(userId: string): Promise<void> {
  await anonymizeUserLedger(userId);
  const subs = await BillingSubscription.findAll({ where: { purchasedByUserId: userId } });
  for (const sub of subs) {
    const mode = modeFromLivemode(sub.livemode);
    const allowed = (ALLOWED_STATUSES as readonly string[]).includes(sub.status);
    if (allowed && sub.provider === 'stripe' && !sub.cancelAtPeriodEnd) {
      await getStripe(mode).subscriptions.update(sub.providerSubscriptionId, { cancel_at_period_end: true }, { idempotencyKey: `purchaser-deleted:${sub.providerSubscriptionId}` });
    }
    await sub.update({ purchasedByUserId: null });
    if (sub.provider === 'stripe') await upsertSubscription(sub.providerSubscriptionId, mode);
    else await raiseReviewItem({ livemode: sub.livemode, kind: 'store_purchaser_deleted', entityType: 'subscription', providerObjectId: sub.providerSubscriptionId });
    if (allowed) {
      const until = sub.currentPeriodEnd ? sub.currentPeriodEnd.toISOString().slice(0, 10) : 'the end of the current period';
      await notifyHouseholdAdmins(sub.householdId, 'billing_purchaser_deleted', 'Your Rootaroo subscription will end',
        `The member who paid for Rootaroo deleted their account, so the subscription will not renew. Resubscribe before ${until} to keep access.`,
        { type: 'billing_purchaser_deleted', until }, { email: true, excludeUserId: userId });
    }
    await syncBillingEmail(sub.householdId, userId);
    await clearEntitlementCache(sub.householdId);
  }
}

export async function onHouseholdDeletionScheduled(householdId: string): Promise<void> {
  await setCancelAtPeriodEndForHousehold(householdId, true, 'hh-delete');
}

export async function onHouseholdDeletionCancelled(householdId: string): Promise<void> {
  await setCancelAtPeriodEndForHousehold(householdId, false, 'hh-undelete');
}

export async function onHouseholdPurged(householdId: string): Promise<void> {
  const subs = await BillingSubscription.findAll({ where: { householdId, provider: 'stripe', ...allowedWhere } });
  for (const sub of subs) {
    const mode = modeFromLivemode(sub.livemode);
    await getStripe(mode).subscriptions.cancel(sub.providerSubscriptionId, { prorate: false }, { idempotencyKey: `purge:${householdId}:${sub.providerSubscriptionId}` });
    await upsertSubscription(sub.providerSubscriptionId, mode);
  }
  await AdminAuditLog.create({
    surface: 'billing-admin', keyLabel: 'system', method: 'JOB', path: `purge:household:${householdId}`,
    query: { canceled: subs.map((s) => s.providerSubscriptionId) }, bodyDigest: null, statusCode: 200, ip: null,
  });
}
