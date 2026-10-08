import { v4 as uuidv4 } from 'uuid';
import { Op } from 'sequelize';
import { CheckIn, User, HouseholdMember } from '../../database/models';
import { NotFoundError } from '../../shared/utils/errors';
import { getUserHousehold as getUserHouseholdCore } from '../../shared/utils/household';
import logger from '../../shared/utils/logger';
import { emitToHousehold } from '../billing/socketGate';
import * as notificationService from '../../shared/services/notifications';
import type {
  CreateCheckInBody,
  CheckInResponse,
  PaginatedCheckInsResponse,
} from './types';

// ── Helpers ──

async function getUserHousehold(userId: string): Promise<string> {
  return getUserHouseholdCore(userId, 'You must belong to a household to check in');
}

function toCheckInResponse(checkIn: CheckIn): CheckInResponse {
  const user = (checkIn.get('user') as User) || null;
  return {
    id: checkIn.id,
    householdId: checkIn.householdId,
    userId: checkIn.userId,
    user: user
      ? {
          id: user.id,
          displayName: user.displayName,
          avatarUrl: user.avatarUrl,
        }
      : null,
    latitude: checkIn.latitude == null ? null : Number(checkIn.latitude),
    longitude: checkIn.longitude == null ? null : Number(checkIn.longitude),
    address: checkIn.address,
    note: checkIn.note,
    checkedInAt: checkIn.checkedInAt.toISOString(),
    createdAt: checkIn.createdAt.toISOString(),
  };
}

// ── Service ──

/**
 * Create a check-in for the current user.
 * Location is optional (timestamp-only check-in, FR-168).
 * Notifies all other household members: "[Name] checked in at [Place]" (FR-162).
 */
export async function createCheckIn(
  userId: string,
  body: CreateCheckInBody,
): Promise<CheckInResponse> {
  const householdId = await getUserHousehold(userId);

  const user = await User.findByPk(userId);
  const displayName = user?.displayName || 'Someone';

  const checkIn = await CheckIn.create({
    id: uuidv4(),
    householdId,
    userId,
    latitude: body.latitude ?? null,
    longitude: body.longitude ?? null,
    address: body.address ?? null,
    note: body.note ?? null,
    checkedInAt: new Date(),
  });

  const location = body.address || 'a new location';

  // Fire-and-forget push to the rest of the household (FR-162)
  notificationService
    .notifyHousehold(
      householdId,
      'check_in',
      'Check-In',
      `${displayName} checked in at ${location}`,
      { type: 'check_in', checkInId: checkIn.id },
      userId,
    )
    .catch(() => {});

  // The sender also gets a notification-history entry and a push, so their
  // own check-ins appear both in-app and as a device notification.
  notificationService
    .notifyUser(
      userId,
      'check_in',
      'Check-In',
      `You checked in at ${location}`,
      { type: 'check_in', checkInId: checkIn.id },
      { skipPush: false },
    )
    .catch(() => {});

  const full = await CheckIn.findByPk(checkIn.id, {
    include: [{ model: User, as: 'user' }],
  });
  const response = toCheckInResponse(full || checkIn);

  try {
    void emitToHousehold(householdId, 'checkin:created', response);
  } catch (e) {
    logger.warn('[WS] Check-in broadcast failed:', (e as Error).message);
  }

  return response;
}

/**
 * List household check-ins, newest first, cursor-paginated (FR-163).
 * Optional per-member filter via `userId`.
 */
export async function listCheckIns(
  userId: string,
  query: { cursor?: string; limit?: number; userId?: string },
): Promise<PaginatedCheckInsResponse> {
  const householdId = await getUserHousehold(userId);
  const limit = query.limit || 20;

  const where: Record<string, unknown> = { householdId };
  if (query.userId) {
    where.userId = query.userId;
  }
  if (query.cursor) {
    where.checkedInAt = { [Op.lt]: new Date(query.cursor) };
  }

  const rows = await CheckIn.findAll({
    where,
    include: [{ model: User, as: 'user' }],
    order: [['checkedInAt', 'DESC']],
    limit: limit + 1,
  });

  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit);

  return {
    items: items.map(toCheckInResponse),
    nextCursor: hasMore && items.length > 0
      ? items[items.length - 1].checkedInAt.toISOString()
      : null,
  };
}

/**
 * Per-member check-in history (default last 7 days, FR-165).
 */
export async function listMemberCheckIns(
  requesterId: string,
  memberUserId: string,
  days = 7,
): Promise<CheckInResponse[]> {
  const householdId = await getUserHousehold(requesterId);

  const member = await HouseholdMember.findOne({
    where: { householdId, userId: memberUserId },
  });
  if (!member) throw new NotFoundError('Household member');

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = await CheckIn.findAll({
    where: {
      householdId,
      userId: memberUserId,
      checkedInAt: { [Op.gte]: since },
    },
    include: [{ model: User, as: 'user' }],
    order: [['checkedInAt', 'DESC']],
    limit: 100,
  });
  return rows.map(toCheckInResponse);
}
