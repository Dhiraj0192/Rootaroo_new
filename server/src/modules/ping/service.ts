import { v4 as uuidv4 } from 'uuid';
import { Op } from 'sequelize';
import { PingRequest, CheckIn, User, HouseholdMember } from '../../database/models';
import { AppError, ForbiddenError, NotFoundError } from '../../shared/utils/errors';
import { getUserHousehold as getUserHouseholdCore } from '../../shared/utils/household';
import { getIO } from '../../shared/utils/socket';
import * as notificationService from '../../shared/services/notifications';
import { startShare, shareIdsByPing } from '../location-share/service';
import type {
  CreatePingRequestBody,
  RespondPingRequestBody,
  PingRequestResponse,
  PaginatedPingRequestsResponse,
} from './types';

// ── Helpers ──

async function getUserHousehold(userId: string): Promise<string> {
  return getUserHouseholdCore(userId, 'You must belong to a household to use Ping');
}

function toPingRequestResponse(pingRequest: PingRequest, locationShareId: string | null = null): PingRequestResponse {
  const requester = (pingRequest.get('requester') as User) || null;
  const target = (pingRequest.get('target') as User) || null;
  return {
    id: pingRequest.id,
    householdId: pingRequest.householdId,
    requester: requester
      ? { id: requester.id, displayName: requester.displayName, avatarUrl: requester.avatarUrl }
      : null,
    target: target
      ? { id: target.id, displayName: target.displayName, avatarUrl: target.avatarUrl }
      : null,
    status: pingRequest.status,
    note: pingRequest.note,
    checkInId: pingRequest.checkInId,
    respondedAt: pingRequest.respondedAt ? pingRequest.respondedAt.toISOString() : null,
    locationShareId,
    createdAt: pingRequest.createdAt.toISOString(),
  };
}

/** Sockets only exist in the running server; a missing one must not fail the request. */
function emitToUser(userId: string, event: string, payload: PingRequestResponse): void {
  try {
    getIO().to(`user:${userId}`).emit(event, payload);
  } catch {
    // not connected (e.g. tests); the push notification still goes out
  }
}

const INCLUDE_USERS = [
  { model: User, as: 'requester' },
  { model: User, as: 'target' },
];

async function loadFull(id: string): Promise<PingRequest | null> {
  return PingRequest.findByPk(id, { include: INCLUDE_USERS });
}

// ── Service ──

/**
 * Request a household member's current location ("ping" them).
 * Notifies the target in real time (socket) and via push (FCM).
 */
export async function createPingRequest(
  requesterId: string,
  body: CreatePingRequestBody,
): Promise<PingRequestResponse> {
  const householdId = await getUserHousehold(requesterId);

  if (body.targetUserId === requesterId) {
    throw new AppError(400, 'You cannot ping yourself');
  }

  const targetMembership = await HouseholdMember.findOne({
    where: { householdId, userId: body.targetUserId },
  });
  if (!targetMembership) {
    throw new NotFoundError('Household member');
  }

  // Idempotent: re-requesting the same person while they still have an
  // unanswered request from us should not stack up duplicate pending rows
  // (each one re-notifies the target, so without this a few taps/retries
  // show up as several near-identical "wants your location" banners).
  const existingPending = await PingRequest.findOne({
    where: { householdId, requesterId, targetUserId: body.targetUserId, status: 'pending' },
  });
  if (existingPending) {
    const existingFull = await loadFull(existingPending.id);
    return toPingRequestResponse(existingFull || existingPending);
  }

  const requester = await User.findByPk(requesterId);
  const requesterName = requester?.displayName || 'Someone';

  const pingRequest = await PingRequest.create({
    id: uuidv4(),
    householdId,
    requesterId,
    targetUserId: body.targetUserId,
    status: 'pending',
    note: body.note ?? null,
  });

  const full = await loadFull(pingRequest.id);
  const response = toPingRequestResponse(full || pingRequest);

  // Real push (not skipPush) — this is the whole point of Ping while backgrounded.
  notificationService
    .notifyUser(
      body.targetUserId,
      'ping_request',
      'Location Request',
      `${requesterName} wants your location`,
      { type: 'ping_request', pingRequestId: pingRequest.id },
    )
    .catch(() => {});

  emitToUser(body.targetUserId, 'ping:request', response);

  return response;
}

/**
 * Respond to a pending ping request — accept (shares location, creates a
 * normal CheckIn row) or decline.
 */
export async function respondToPingRequest(
  userId: string,
  pingRequestId: string,
  body: RespondPingRequestBody,
): Promise<PingRequestResponse> {
  const pingRequest = await PingRequest.findByPk(pingRequestId);
  if (!pingRequest) {
    throw new NotFoundError('Ping request');
  }
  if (pingRequest.targetUserId !== userId) {
    throw new ForbiddenError('This ping request is not addressed to you');
  }
  if (pingRequest.status !== 'pending') {
    throw new AppError(409, 'This ping request has already been responded to');
  }

  let locationShareId: string | null = null;

  if (body.action === 'decline') {
    pingRequest.status = 'declined';
    pingRequest.respondedAt = new Date();
    await pingRequest.save();

    notificationService
      .notifyUser(
        pingRequest.requesterId,
        'ping_response',
        'Ping Declined',
        'Your location request was declined',
        { type: 'ping_response', pingRequestId: pingRequest.id },
      )
      .catch(() => {});
  } else {
    const target = await User.findByPk(userId);
    const targetName = target?.displayName || 'Someone';

    const checkIn = await CheckIn.create({
      id: uuidv4(),
      householdId: pingRequest.householdId,
      userId,
      latitude: body.latitude ?? null,
      longitude: body.longitude ?? null,
      address: body.address ?? null,
      note: null,
      checkedInAt: new Date(),
    });

    pingRequest.status = 'fulfilled';
    pingRequest.checkInId = checkIn.id;
    pingRequest.respondedAt = new Date();
    await pingRequest.save();

    // Live sharing is its own feature now; only the person who asked can see it.
    // Without a position there is nothing to share (the check-in is still recorded).
    if (body.durationMinutes && body.latitude != null && body.longitude != null) {
      const share = await startShare(
        userId,
        {
          durationMinutes: body.durationMinutes,
          viewerIds: [pingRequest.requesterId],
          latitude: body.latitude,
          longitude: body.longitude,
          pingRequestId: pingRequest.id,
        },
        { notify: false },
      );
      locationShareId = share.id;
    }

    const location = body.address || 'a new location';
    notificationService
      .notifyUser(
        pingRequest.requesterId,
        'ping_response',
        'Location Shared',
        `${targetName} shared their location at ${location}`,
        { type: 'ping_response', pingRequestId: pingRequest.id, checkInId: checkIn.id },
      )
      .catch(() => {});
  }

  // Resolve any other stale pending duplicates from the same requester —
  // these could only exist from before createPingRequest started deduping
  // pending requests, but if they're still there, answering one shouldn't
  // leave the others sitting in the list to reappear later.
  await PingRequest.update(
    { status: 'expired', respondedAt: new Date() },
    {
      where: {
        householdId: pingRequest.householdId,
        requesterId: pingRequest.requesterId,
        targetUserId: pingRequest.targetUserId,
        status: 'pending',
        id: { [Op.ne]: pingRequest.id },
      },
    },
  );

  const full = await loadFull(pingRequest.id);
  const response = toPingRequestResponse(full || pingRequest, locationShareId);

  emitToUser(pingRequest.requesterId, 'ping:response', response);

  return response;
}

/**
 * List ping requests involving the current user, cursor-paginated.
 */
export async function listPingRequests(
  userId: string,
  query: { direction: 'incoming' | 'outgoing'; status?: string; cursor?: string; limit?: number },
): Promise<PaginatedPingRequestsResponse> {
  const limit = query.limit || 20;

  const where: Record<string, unknown> = {
    [query.direction === 'incoming' ? 'targetUserId' : 'requesterId']: userId,
  };
  if (query.status) {
    where.status = query.status;
  }
  if (query.cursor) {
    where.createdAt = { [Op.lt]: new Date(query.cursor) };
  }

  const rows = await PingRequest.findAll({
    where,
    include: INCLUDE_USERS,
    order: [['createdAt', 'DESC']],
    limit: limit + 1,
  });

  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit);

  const shareIds = await shareIdsByPing(items.map((r) => r.id));

  return {
    items: items.map((r) => toPingRequestResponse(r, shareIds.get(r.id) ?? null)),
    nextCursor: hasMore && items.length > 0
      ? items[items.length - 1].createdAt.toISOString()
      : null,
  };
}
