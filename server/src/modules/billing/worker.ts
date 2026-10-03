import Stripe from 'stripe';
import { literal, Op } from 'sequelize';
import { BillingEvent } from '../../database/models';
import logger from '../../shared/utils/logger';
import { getBillingConfig } from './config';
import { dispatchEvent, envOfEventObject } from './handlers';
import { modeFromLivemode } from './mode';
import { alertStaff } from './notify';
import { raiseReviewItem } from './review';

export const MAX_ATTEMPTS = 8;
export const STALE_PROCESSING_MS = 10 * 60_000;

export function backoffMs(attempts: number): number {
  return Math.min(2 ** attempts * 60_000, 60 * 60_000);
}

type Dispatcher = (row: BillingEvent) => Promise<'processed' | 'ignored'>;
const providerDispatchers: Partial<Record<'apple' | 'google', Dispatcher>> = {};

export function registerProviderDispatcher(provider: 'apple' | 'google', fn: Dispatcher): void {
  providerDispatchers[provider] = fn;
}

const queue: string[] = [];
let draining: Promise<void> | null = null;

export function enqueueEvent(id: string): void {
  queue.push(id);
  if (!draining) {
    draining = (async () => {
      while (queue.length > 0) {
        const next = queue.shift()!;
        await processEvent(next).catch((err) => logger.error(`[Billing] worker crashed on ${next}:`, err));
      }
    })().finally(() => { draining = null; });
  }
}

export async function __drainForTests(): Promise<void> {
  while (draining) await draining;
}

export async function processEvent(id: string): Promise<'processed' | 'ignored' | 'failed' | 'skipped'> {
  const [claimed] = await BillingEvent.update(
    { status: 'processing', lockedAt: new Date() },
    { where: { id, status: { [Op.in]: ['received', 'failed'] } } },
  );
  if (claimed === 0) return 'skipped';
  const row = (await BillingEvent.findByPk(id))!;
  try {
    let outcome: 'processed' | 'ignored';
    if (row.provider === 'stripe') {
      const event = row.payload as unknown as Stripe.Event;
      const env = envOfEventObject(event.data?.object);
      outcome = env && env !== getBillingConfig().envTag ? 'ignored' : await dispatchEvent(event, modeFromLivemode(row.livemode));
    } else {
      const dispatcher = providerDispatchers[row.provider];
      outcome = dispatcher ? await dispatcher(row) : 'ignored';
    }
    await row.update({ status: outcome, processedAt: new Date(), lockedAt: null, lastError: null });
    return outcome;
  } catch (err) {
    await row.update({ status: 'failed', attempts: row.attempts + 1, lastError: String((err as Error).message ?? err).slice(0, 2000), lockedAt: null });
    logger.warn(`[Billing] event ${row.providerEventId} failed (attempt ${row.attempts}): ${(err as Error).message}`);
    return 'failed';
  }
}

export async function sweepEvents(now: Date = new Date()): Promise<{ requeued: number; dead: number; reset: number }> {
  // 1. stale `processing` rows (crash mid-dispatch) go back to failed with one more attempt
  const cutoff = new Date(now.getTime() - STALE_PROCESSING_MS);
  const stale = await BillingEvent.findAll({ where: { status: 'processing', lockedAt: { [Op.lt]: cutoff } } });
  const resetIds = new Set<string>(); // crash recovery retries immediately, without waiting for backoff
  for (const row of stale) {
    // Conditional: a worker that finished (or re-claimed) the row since the read must not be overwritten.
    const [n] = await BillingEvent.update(
      { status: 'failed', attempts: literal('attempts + 1'), lockedAt: null, lastError: 'stale processing lock' },
      { where: { id: row.id, status: 'processing', lockedAt: { [Op.lt]: cutoff } } },
    );
    if (n > 0) resetIds.add(row.id);
  }

  // 2. exhausted rows become dead
  const exhausted = await BillingEvent.findAll({ where: { status: 'failed', attempts: { [Op.gte]: MAX_ATTEMPTS } } });
  for (const row of exhausted) {
    await row.update({ status: 'dead' });
    await raiseReviewItem({ livemode: row.livemode, kind: 'dead_event', entityType: 'event', entityId: row.id, providerObjectId: row.providerEventId, after: { type: row.type, lastError: row.lastError } });
  }
  if (exhausted.length > 0) {
    await alertStaff('Dead billing events', exhausted.map((r) => `${r.providerEventId} ${r.type}: ${r.lastError ?? ''}`).join('\n'));
  }

  // 3. re-queue received rows and failed rows whose backoff elapsed
  const candidates = await BillingEvent.findAll({ where: { status: { [Op.in]: ['received', 'failed'] }, attempts: { [Op.lt]: MAX_ATTEMPTS } } });
  let requeued = 0;
  for (const row of candidates) {
    if (row.status === 'failed' && !resetIds.has(row.id) && row.updatedAt.getTime() + backoffMs(row.attempts) > now.getTime()) continue;
    enqueueEvent(row.id);
    requeued++;
  }
  return { requeued, dead: exhausted.length, reset: resetIds.size };
}
