import cron from 'node-cron';
import { withLock } from '../modules/billing/locks';
import { sweepEvents } from '../modules/billing/worker';
import { LockBusyError } from '../modules/billing/errors';
import { maybeAlertFailedBurst } from '../modules/billing/alerts';
import logger from '../shared/utils/logger';

export function startBillingEventSweepJob(): void {
  cron.schedule('* * * * *', async () => {
    try {
      const res = await withLock('billing:job:event-sweep:all', 55_000, () => sweepEvents());
      if (res.requeued || res.dead || res.reset) logger.info(`[Billing Sweep] requeued=${res.requeued} dead=${res.dead} reset=${res.reset}`);
      await maybeAlertFailedBurst();
    } catch (err) {
      if (!(err instanceof LockBusyError)) logger.error('[Billing Sweep] Failed:', err);
    }
  });
  logger.info('[Billing Sweep] Cron job registered — runs every minute');
}
