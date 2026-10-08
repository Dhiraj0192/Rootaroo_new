import cron from 'node-cron';
import { Op } from 'sequelize';
import { Task } from '../database/models';
import { isEntitledBatch } from '../modules/billing/entitlement';
import logger from '../shared/utils/logger';

/** One-time halving of overdue task points, entitled households only (§7.2). */
export async function runOverduePointsReduction(now: Date = new Date()): Promise<number> {
  const candidates = await Task.findAll({
    where: { status: { [Op.in]: ['pending', 'reopened'] }, pointsReduced: false, dueDate: { [Op.not]: null, [Op.lt]: now } },
  });
  const allowed = await isEntitledBatch(candidates.map((t) => t.householdId));
  let count = 0;
  for (const task of candidates) {
    if (!allowed.has(task.householdId)) continue;
    await task.update({ points: Math.max(0, Math.floor(task.points / 2)), pointsReduced: true });
    count++;
  }
  return count;
}

export function startOverduePointsReductionJob(): void {
  cron.schedule('0 * * * *', async () => {
    try {
      const count = await runOverduePointsReduction();
      if (count > 0) logger.info(`[Overdue Points] Reduced points for ${count} overdue task(s)`);
    } catch (err) {
      logger.error('[Overdue Points] Failed:', err);
    }
  });
  logger.info('[Overdue Points] Cron job registered — runs every hour');
}
