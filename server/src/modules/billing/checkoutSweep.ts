import { Op } from 'sequelize';
import { BillingCheckoutSession } from '../../database/models';
import logger from '../../shared/utils/logger';
import { getStripe } from './config';
import { livemodeOf } from './mode';
import { idOf, upsertSubscription } from './sync';
import type { BillingMode } from './types';

export const CHECKOUT_SWEEP_AGE_MS = 5 * 60_000;

export async function sweepCheckouts(mode: BillingMode, now: Date = new Date()): Promise<{ completed: number; expired: number; failed: number }> {
  const stripe = getStripe(mode);
  const rows = await BillingCheckoutSession.findAll({
    where: { livemode: livemodeOf(mode), status: { [Op.in]: ['open', 'creating'] }, createdAt: { [Op.lte]: new Date(now.getTime() - CHECKOUT_SWEEP_AGE_MS) } },
  });
  const out = { completed: 0, expired: 0, failed: 0 };
  for (const row of rows) {
    if (!row.providerSessionId) {
      await row.update({ status: 'failed' });
      out.failed++;
      continue;
    }
    try {
      const session = await stripe.checkout.sessions.retrieve(row.providerSessionId);
      if (session.status === 'complete') {
        await row.update({ status: 'complete' });
        const subId = idOf(session.subscription as string | { id: string } | null);
        if (subId) await upsertSubscription(subId, mode);
        out.completed++;
      } else if (session.status === 'expired') {
        await row.update({ status: 'expired' });
        out.expired++;
      }
    } catch (err) {
      if ((err as { code?: string }).code === 'resource_missing') {
        await row.update({ status: 'failed' });
        out.failed++;
      } else {
        logger.warn(`[Billing] checkout sweep could not fetch ${row.providerSessionId}: ${(err as Error).message}`);
      }
    }
  }
  return out;
}
