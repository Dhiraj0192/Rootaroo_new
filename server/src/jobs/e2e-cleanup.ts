import cron from 'node-cron';
import { Op } from 'sequelize';
import { KeyRestoreCode, KeyTransferSession } from '../database/models';
import logger from '../shared/utils/logger';

const SESSION_GRACE_MS = 24 * 60 * 60 * 1000; // sessions are kept a day past expiry, then deleted

/** Daily: transfer sessions a day past expiry and restore codes (and tokens) that can no longer be used. */
export function startE2eCleanupJob(): void {
  cron.schedule('30 3 * * *', async () => {
    try {
      const now = new Date();
      const sessions = await KeyTransferSession.destroy({
        where: { expiresAt: { [Op.lt]: new Date(now.getTime() - SESSION_GRACE_MS) } },
      });
      const codes = await KeyRestoreCode.destroy({
        where: {
          expiresAt: { [Op.lt]: now },
          [Op.or]: [{ restoreTokenExpiresAt: null }, { restoreTokenExpiresAt: { [Op.lt]: now } }],
        },
      });
      if (sessions + codes > 0) logger.info(`[E2E-Cleanup] Deleted ${sessions} transfer session(s), ${codes} restore code(s)`);
    } catch (err) {
      logger.error('[E2E-Cleanup] Failed:', err);
    }
  });

  logger.info('[E2E-Cleanup] Cron job registered — runs daily');
}
