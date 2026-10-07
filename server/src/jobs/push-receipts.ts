import cron from 'node-cron';
import logger from '../shared/utils/logger';
import { checkPushReceipts } from '../shared/utils/expoPush';

/**
 * Expo reports DeviceNotRegistered in receipts, available some minutes after
 * the send. Every 15 minutes we read them and delete dead device tokens.
 */
export function startPushReceiptsJob(): void {
  cron.schedule('*/15 * * * *', async () => {
    try {
      const { checked, removedTokens } = await checkPushReceipts();
      if (removedTokens > 0) {
        logger.info(`[Push Receipts] Checked ${checked}, removed ${removedTokens} dead token(s)`);
      }
    } catch (err) {
      logger.error('[Push Receipts] Failed:', err);
    }
  });

  logger.info('[Push Receipts] Cron job registered — runs every 15 minutes');
}
