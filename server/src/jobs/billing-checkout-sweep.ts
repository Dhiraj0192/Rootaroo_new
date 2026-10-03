import cron from 'node-cron';
import { isModeAvailable } from '../modules/billing/config';
import { sweepCheckouts } from '../modules/billing/checkoutSweep';
import { withLock } from '../modules/billing/locks';
import { LockBusyError } from '../modules/billing/errors';
import type { BillingMode } from '../modules/billing/types';
import logger from '../shared/utils/logger';

export function startBillingCheckoutSweepJob(): void {
  cron.schedule('*/15 * * * *', async () => {
    for (const mode of ['test', 'live'] as BillingMode[]) {
      if (!isModeAvailable(mode)) continue;
      try {
        const r = await withLock(`billing:job:checkout-sweep:${mode}`, 10 * 60_000, () => sweepCheckouts(mode));
        if (r.completed || r.expired || r.failed) logger.info(`[Checkout Sweep] ${mode} ${JSON.stringify(r)}`);
      } catch (err) {
        if (!(err instanceof LockBusyError)) logger.error(`[Checkout Sweep] ${mode} failed:`, err);
      }
    }
  });
  logger.info('[Checkout Sweep] Cron job registered — runs every 15 minutes');
}
