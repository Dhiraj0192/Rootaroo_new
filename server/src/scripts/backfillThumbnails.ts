import { Op, ModelStatic, Model } from 'sequelize';
import { FeedMedia } from '../database/models';
import { downloadObjectBuffer, uploadBuffer } from '../shared/utils/s3';
import { resizeImageBuffer } from '../shared/utils/image';
import { extractVideoPosterFrame } from '../shared/utils/videoThumbnail';
import logger from '../shared/utils/logger';

/**
 * One-off backfill: generate a compressed thumbnail for every existing feed
 * post photo or video that predates the thumbnailing
 * feature (added after these rows were created, so `thumbnailUrl` is still
 * null on them) — photos through the resize pipeline directly, videos via
 * an extracted poster frame first. Safe to re-run — only processes rows
 * where `thumbnailUrl IS NULL`, so an interrupted or repeated run just
 * picks up where it left off. This is a one-time pass; not meant to run on
 * every boot — remove from the start command once it has run successfully
 * in production.
 *
 * Journal photos are end-to-end encrypted (the phone makes the thumbnail), so
 * there is nothing for the server to backfill there.
 */
async function backfillTable(
  model: ModelStatic<Model>,
  folder: string,
  label: string,
): Promise<void> {
  const rows = await model.findAll({
    where: { mediaType: { [Op.in]: ['photo', 'video'] }, thumbnailUrl: { [Op.is]: null } },
  });
  logger.info(`[Backfill] ${label}: ${rows.length} item(s) missing a thumbnail`);

  let done = 0;
  let failed = 0;
  for (const row of rows) {
    const mediaUrl = row.get('mediaUrl') as string;
    const isVideo = row.get('mediaType') === 'video';
    try {
      // mediaUrl is always an S3 key for feed uploads (never an
      // external URL) — skip defensively if that's ever not true.
      if (/^https?:\/\//i.test(mediaUrl)) continue;
      const original = await downloadObjectBuffer(mediaUrl);
      const sourceBuffer = isVideo ? await extractVideoPosterFrame(original) : original;
      const thumbBuffer = await resizeImageBuffer(sourceBuffer, { width: 480 });
      const { key } = await uploadBuffer(thumbBuffer, folder, 'image/jpeg', 'jpg');
      await row.update({ thumbnailUrl: key });
      done++;
    } catch (error) {
      failed++;
      logger.error(`[Backfill] ${label} ${row.get('id')} failed:`, (error as Error).message);
    }
  }
  logger.info(`[Backfill] ${label}: done=${done} failed=${failed}`);
}

export async function backfillThumbnails(): Promise<void> {
  await backfillTable(FeedMedia, 'feed/thumbnails', 'FeedMedia');
}

if (require.main === module) {
  backfillThumbnails()
    .then(() => {
      logger.info('[Backfill] Complete.');
      process.exit(0);
    })
    .catch((error) => {
      logger.error('[Backfill] Fatal error:', (error as Error).message);
      process.exit(1);
    });
}
