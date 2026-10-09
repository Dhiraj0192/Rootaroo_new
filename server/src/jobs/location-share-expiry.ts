import cron from 'node-cron';
import { endExpiredShares } from '../modules/location-share/service';
import logger from '../shared/utils/logger';

/**
 * Closes shares past their time limit. The app also stops itself, but a phone
 * that is switched off or offline never will, so the server is the authority.
 */
export function startLocationShareExpiryJob(): void {
  cron.schedule('* * * * *', async () => {
    try {
      const count = await endExpiredShares(new Date());
      if (count > 0) {
        logger.info(`[Location-Share-Expiry] Ended ${count} expired share(s)`);
      }
    } catch (err) {
      logger.error('[Location-Share-Expiry] Failed:', err);
    }
  });

  logger.info('[Location-Share-Expiry] Cron job registered, runs every minute');
}
