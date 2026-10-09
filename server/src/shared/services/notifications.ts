import { sendToUser } from '../../modules/notification/service';
import logger from '../../shared/utils/logger';

/**
 * Notify a single user about an event.
 * Wraps the notification service's sendToUser with common defaults.
 */
export async function notifyUser(
  userId: string,
  type: string,
  title: string,
  body: string,
  data?: Record<string, unknown>,
  options?: { skipPush?: boolean; skipHistory?: boolean },
): Promise<void> {
  try {
    await sendToUser(userId, type, title, body, data, options);
  } catch (error) {
    logger.error(`[notifyUser] Failed to notify user ${userId}:`, error);
  }
}

/**
 * Notify all members of a household about an event.
 * Fetches all household member IDs and calls notifyUser for each.
 */
export async function notifyHousehold(
  householdId: string,
  type: string,
  title: string,
  body: string,
  data?: Record<string, unknown>,
  excludeUserId?: string,
  options?: { throwOnError?: boolean },
): Promise<void> {
  try {
    const { HouseholdMember } = await import('../../database/models');
    const memberships = await HouseholdMember.findAll({
      where: { householdId },
      attributes: ['userId'],
    });

    const userIds = memberships
      .map((m) => m.userId)
      .filter((id) => id !== excludeUserId);

    if (!options?.throwOnError) {
      await Promise.all(userIds.map((userId) => notifyUser(userId, type, title, body, data)));
      return;
    }
    // throwOnError: the caller retries the whole household on a throw, so it only throws when
    // nobody was reached. A partial failure is logged; retrying would re-push the members who got it.
    const results = await Promise.allSettled(
      userIds.map((userId) => sendToUser(userId, type, title, body, data, undefined)),
    );
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed.length > 0 && failed.length === results.length) throw failed[0].reason;
    if (failed.length > 0) {
      logger.warn(`[notifyHousehold] ${failed.length} of ${results.length} sends failed for household ${householdId}; not retried`);
    }
  } catch (error) {
    if (options?.throwOnError) throw error;
    logger.error(`[notifyHousehold] Failed to notify household ${householdId}:`, error);
  }
}