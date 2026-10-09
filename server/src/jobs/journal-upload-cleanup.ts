import cron from 'node-cron';
import { Op } from 'sequelize';
import { JournalUpload } from '../database/models';
import { deleteObject } from '../shared/utils/s3';
import logger from '../shared/utils/logger';

const UNATTACHED_GRACE_MS = 24 * 60 * 60 * 1000;
const BATCH = 500;

/**
 * Deletes encrypted journal blobs that were uploaded but never attached to an entry
 * (the phone gave up, or the save failed after the upload). A row is only removed once
 * its object is gone, so a storage outage is retried the next day. Returns how many were cleaned.
 */
export async function cleanupUnattachedJournalUploads(now: Date = new Date()): Promise<number> {
  const stale = await JournalUpload.findAll({
    where: { attachedAt: null, createdAt: { [Op.lt]: new Date(now.getTime() - UNATTACHED_GRACE_MS) } },
    attributes: ['key'],
    limit: BATCH,
  });
  const deleted: string[] = [];
  for (const upload of stale) {
    try {
      await deleteObject(upload.key);
      deleted.push(upload.key);
    } catch (error) {
      logger.warn(`[JournalUploadCleanup] Could not delete ${upload.key}:`, (error as Error).message);
    }
  }
  if (deleted.length > 0) await JournalUpload.destroy({ where: { key: deleted } });
  return deleted.length;
}

/** Daily: remove journal uploads nobody attached to an entry within 24 hours. */
export function startJournalUploadCleanupJob(): void {
  cron.schedule('45 3 * * *', async () => {
    try {
      const n = await cleanupUnattachedJournalUploads();
      if (n > 0) logger.info(`[JournalUploadCleanup] Deleted ${n} unattached upload(s)`);
    } catch (err) {
      logger.error('[JournalUploadCleanup] Failed:', err);
    }
  });

  logger.info('[JournalUploadCleanup] Cron job registered — runs daily');
}
