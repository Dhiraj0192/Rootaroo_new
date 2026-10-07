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

    await Promise.all(
      userIds.map((userId) => notifyUser(userId, type, title, body, data)),
    );
  } catch (error) {
    logger.error(`[notifyHousehold] Failed to notify household ${householdId}:`, error);
  }
}