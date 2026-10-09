import cron from 'node-cron';
import logger from '../shared/utils/logger';
import { notifyUpcomingEvents } from '../modules/calendar/service';

/**
 * FR-186: Push notification for events starting within 1 hour.
 * Runs every 15 minutes; the service scans events starting in [now, now+1h]
 * and notifies the whole household. Each event is claimed atomically via
 * `reminder_sent_at`, so it is notified once even across overlapping runs;
 * rescheduling an event clears the column to re-arm the reminder.
 */
export function startEventReminderJob(): void {
  cron.schedule('*/15 * * * *', async () => {
    try {
      const sent = await notifyUpcomingEvents();
      if (sent > 0) {
        logger.info(`[Event Reminder] Sent ${sent} upcoming-event notification(s)`);
      }
    } catch (err) {
      logger.error('[Event Reminder] Failed:', err);
    }
  });

  logger.info('[Event Reminder] Cron job registered — runs every 15 minutes');
}
