import cron from 'node-cron';
import { isModeAvailable } from '../modules/billing/config';
import { alertStuckRuns, runReconciliationLocked } from '../modules/billing/alerts';
import { LockBusyError } from '../modules/billing/errors';
import type { ReconKind } from '../modules/billing/reconcile';
import type { BillingMode } from '../modules/billing/types';
import logger from '../shared/utils/logger';

async function runAll(kind: ReconKind): Promise<void> {
  await alertStuckRuns().catch(() => 0);
  for (const mode of ['test', 'live'] as BillingMode[]) {
    if (!isModeAvailable(mode)) continue;
    try {
      const run = await runReconciliationLocked(mode, kind);
      logger.info(`[Reconcile] ${kind} ${mode}: ${run.status} ${JSON.stringify(run.counts)}`);
    } catch (err) {
      if (!(err instanceof LockBusyError)) logger.error(`[Reconcile] ${kind} ${mode} failed:`, err);
    }
  }
}

export function startBillingReconcileJobs(): void {
  cron.schedule('30 3 * * *', () => { void runAll('daily'); }, { timezone: 'UTC' });
  cron.schedule('0 4 * * 0', () => { void runAll('weekly'); }, { timezone: 'UTC' });
  logger.info('[Reconcile] Cron jobs registered — daily 03:30 UTC, weekly Sunday 04:00 UTC');
}
