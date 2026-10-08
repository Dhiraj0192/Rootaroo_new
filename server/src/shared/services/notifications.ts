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

    // notifyUser swallows its own errors, so callers that must know about a
    // failed send go straight to sendToUser.
    await Promise.all(
      userIds.map((userId) => (options?.throwOnError
        ? sendToUser(userId, type, title, body, data, undefined)
        : notifyUser(userId, type, title, body, data))),
    );
  } catch (error) {
    if (options?.throwOnError) throw error;
    logger.error(`[notifyHousehold] Failed to notify household ${householdId}:`, error);
  }
}