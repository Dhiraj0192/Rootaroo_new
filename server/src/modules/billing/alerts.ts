import { Op } from 'sequelize';
import { BillingEvent, BillingReconciliationItem, BillingReconciliationRun } from '../../database/models';
import { livemodeOf } from './mode';
import { withLock } from './locks';
import { alertStaff } from './notify';
import { ReconKind, runReconciliation } from './reconcile';
import type { BillingMode } from './types';

export const RUN_SLOW_MS = 30 * 60_000;
export const FAILED_BURST_THRESHOLD = 5;
export const FAILED_BURST_WINDOW_MS = 15 * 60_000;

let lastBurstAlertAt = 0;
export function __resetAlertThrottleForTests(): void { lastBurstAlertAt = 0; }

export async function alertOnRun(run: BillingReconciliationRun): Promise<void> {
  const label = `${run.kind} reconciliation (${run.livemode ? 'live' : 'test'})`;
  const duration = (run.finishedAt ?? new Date()).getTime() - run.startedAt.getTime();
  if (run.status === 'failed') await alertStaff(`${label} failed`, `Run ${run.id} failed after ${Math.round(duration / 1000)} s. Counts: ${JSON.stringify(run.counts)}`);
  else if (duration > RUN_SLOW_MS) await alertStaff(`${label} took ${Math.round(duration / 60_000)} minutes`, `Run ${run.id} exceeded 30 minutes.`);

  const items = await BillingReconciliationItem.findAll({
    where: { livemode: run.livemode, resolution: 'needs_review', createdAt: { [Op.gte]: run.startedAt } },
    order: [['createdAt', 'ASC']],
  });
  if (items.length > 0) {
    await alertStaff(`${items.length} new review items after ${label}`,
      items.map((i) => `- ${i.kind} ${i.entityType} ${i.providerObjectId ?? i.entityId ?? ''}`).join('\n'));
  }
}

export async function maybeAlertFailedBurst(now: Date = new Date()): Promise<boolean> {
  if (now.getTime() - lastBurstAlertAt < FAILED_BURST_WINDOW_MS) return false;
  const failed = await BillingEvent.count({ where: { status: 'failed', updatedAt: { [Op.gte]: new Date(now.getTime() - FAILED_BURST_WINDOW_MS) } } });
  if (failed < FAILED_BURST_THRESHOLD) return false;
  lastBurstAlertAt = now.getTime();
  await alertStaff(`${failed} webhook events failed in 15 minutes`, 'Check billing_events where status = failed, and the server logs.');
  return true;
}

export async function alertStuckRuns(now: Date = new Date()): Promise<number> {
  const stuck = await BillingReconciliationRun.findAll({ where: { status: 'running', startedAt: { [Op.lt]: new Date(now.getTime() - RUN_SLOW_MS) } } });
  for (const run of stuck) await alertStaff(`Reconciliation ${run.kind} still running after 30 minutes`, `Run ${run.id} started ${run.startedAt.toISOString()}.`);
  return stuck.length;
}

export async function runReconciliationLocked(mode: BillingMode, kind: ReconKind): Promise<BillingReconciliationRun> {
  return withLock(`billing:job:reconcile-${kind}:${mode}`, 40 * 60_000, async () => {
    try {
      const run = await runReconciliation(mode, kind);
      await alertOnRun(run);
      return run;
    } catch (err) {
      const failed = await BillingReconciliationRun.findOne({ where: { kind, livemode: livemodeOf(mode), status: 'failed' }, order: [['createdAt', 'DESC']] });
      if (failed) await alertOnRun(failed);
      throw err;
    }
  });
}
