import cron from 'node-cron';
import { isModeAvailable } from '../modules/billing/config';
import { applyDueNotices } from '../modules/billing/priceNotices';
import { withLock } from '../modules/billing/locks';
import { LockBusyError } from '../modules/billing/errors';
import type { BillingMode } from '../modules/billing/types';
import logger from '../shared/utils/logger';

export function startBillingPriceNoticesJob(): void {
  cron.schedule('0 5 * * *', async () => {
    for (const mode of ['test', 'live'] as BillingMode[]) {
      if (!isModeAvailable(mode)) continue;
      try {
        const r = await withLock(`billing:job:price-notices:${mode}`, 30 * 60_000, () => applyDueNotices(mode));
        if (r.applied || r.failed || r.skipped) logger.info(`[Price Notices] ${mode} ${JSON.stringify(r)}`);
      } catch (err) {
        if (!(err instanceof LockBusyError)) logger.error(`[Price Notices] ${mode} failed:`, err);
      }
    }
  }, { timezone: 'UTC' });
  logger.info('[Price Notices] Cron job registered — daily 05:00 UTC');
}
