import cron from 'node-cron';
import { Op } from 'sequelize';
import { sequelize, GroceryItem } from '../database/models';
import { isEntitledBatch } from '../modules/billing/entitlement';
import logger from '../shared/utils/logger';

/** Archive items bought more than 24 h ago, for entitled households only (§7.2). */
export async function runGroceryArchive(now: Date = new Date()): Promise<number> {
  const where = { isBought: true, boughtAt: { [Op.lte]: new Date(now.getTime() - 24 * 60 * 60 * 1000) }, archivedAt: null };
  const rows = (await GroceryItem.findAll({
    where, attributes: [[sequelize.fn('DISTINCT', sequelize.col('household_id')), 'householdId']], raw: true,
  })) as unknown as Array<{ householdId: string }>;
  const allowed = await isEntitledBatch(rows.map((r) => r.householdId));
  if (allowed.size === 0) return 0;
  const [count] = await GroceryItem.update({ archivedAt: now }, { where: { ...where, householdId: [...allowed] } });
  return count;
}

export function startGroceryArchiveJob(): void {
  cron.schedule('0 * * * *', async () => {
    try {
      const count = await runGroceryArchive();
      if (count > 0) logger.info(`[Auto-Archive] Archived ${count} grocery items older than 24h`);
    } catch (err) {
      logger.error('[Auto-Archive] Failed:', err);
    }
  });
  logger.info('[Auto-Archive] Cron job registered — runs every hour');
}
