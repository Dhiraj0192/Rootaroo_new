import cron from 'node-cron';
import { runCampaigns, defaultCampaignDeps } from '../modules/campaign/run';
import logger from '../shared/utils/logger';

/** Hourly, off the hour so it doesn't pile onto the other jobs. Quiet hours are enforced per household in the selector. */
export function startCampaignsJob(): void {
  cron.schedule('5 * * * *', async () => {
    try {
      const sent = await runCampaigns(new Date(), defaultCampaignDeps());
      if (sent > 0) logger.info(`[Campaigns] Sent ${sent} campaign push(es)`);
    } catch (err) {
      logger.error('[Campaigns] Failed:', err);
    }
  });
  logger.info('[Campaigns] Cron job registered — runs hourly at minute 5');
}
