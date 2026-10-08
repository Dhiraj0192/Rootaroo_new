import { Op, Transaction } from 'sequelize';
import { LocationShare, HouseholdMember, User } from '../../database/models';
import { AppError, ForbiddenError, NotFoundError } from '../../shared/utils/errors';
import { getUserHousehold as getUserHouseholdCore } from '../../shared/utils/household';
import { getIO } from '../../shared/utils/socket';
import * as notificationService from '../../shared/services/notifications';
import type {
  StartShareBody,
  UpdateShareLocationBody,
  LocationShareResponse,
  LocationSharesResponse,
} from './types';

export const MAX_SHARE_MINUTES = 480;

// ── Helpers ──

async function getUserHousehold(userId: string): Promise<string> {
  return getUserHouseholdCore(userId, 'You must belong to a household to share your location');
}

async function memberIdsOf(householdId: string): Promise<string[]> {
  const members = await HouseholdMember.findAll({ where: { householdId }, attributes: ['userId'] });
  return members.map((m) => m.userId);
}

/** Who may see a share: everyone else in the household, or the chosen people who are still members. */
export function audienceOf(
  share: Pick<LocationShare, 'sharerId' | 'viewerIds'>,
  memberIds: string[],
): string[] {
  const others = memberIds.filter((id) => id !== share.sharerId);
  return share.viewerIds ? others.filter((id) => share.viewerIds!.includes(id)) : others;
}

function toResponse(share: LocationShare): LocationShareResponse {
  const sharer = share.get('sharer') as User | undefined;
  return {
    id: share.id,
    householdId: share.householdId,
    sharer: sharer
      ? { id: sharer.id, displayName: sharer.displayName, avatarUrl: sharer.avatarUrl }
      : { id: share.sharerId, displayName: 'Someone', avatarUrl: null },
    viewerIds: share.viewerIds ?? null,
    pingRequestId: share.pingRequestId ?? null,
    startedAt: share.startedAt.toISOString(),
    expiresAt: share.expiresAt.toISOString(),
    endedAt: share.endedAt ? share.endedAt.toISOString() : null,
    // MySQL hands DECIMAL back as a string.
    latitude: share.latitude != null ? Number(share.latitude) : null,
    longitude: share.longitude != null ? Number(share.longitude) : null,
    accuracy: share.accuracy ?? null,
    locationUpdatedAt: share.locationUpdatedAt.toISOString(),
  };
}

function loadFull(id: string): Promise<LocationShare | null> {
  return LocationShare.findByPk(id, { include: [{ model: User, as: 'sharer' }] });
}

function emitTo(userIds: string[], event: string, payload: LocationShareResponse): void {
  let io;
  try {
    io = getIO();
  } catch {
    // Sockets are only live in the running server; the database is already updated.
    return;
  }
  for (const id of userIds) io.to(`user:${id}`).emit(event, payload);
}

function durationText(minutes: number): string {
  if (minutes < 60) return `For ${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (rest === 0) return hours === 1 ? 'For 1 hour' : `For ${hours} hours`;
  return `For ${hours} h ${rest} min`;
}

/** Only the sharer may change a share, and only while it is still running. */
async function loadOwnActive(userId: string, id: string, forbidden: string): Promise<LocationShare> {
  const share = await LocationShare.findByPk(id);
  if (!share) throw new NotFoundError('Location share');
  if (share.sharerId !== userId) throw new ForbiddenError(forbidden);
  if (share.endedAt || share.expiresAt.getTime() <= Date.now()) {
    throw new AppError(410, 'This location share has ended');
  }
  return share;
}

/** Ends a share and drops its position, so nothing is kept once nobody can see it. */
async function endShare(
  share: LocationShare,
  endedAt: Date,
  transaction?: Transaction,
): Promise<LocationShareResponse> {
  share.endedAt = endedAt;
  share.latitude = null;
  share.longitude = null;
  share.accuracy = null;
  await share.save(transaction ? { transaction } : undefined);
  // Inside a transaction the caller announces the end once it has committed.
  if (transaction) return toResponse(share);
  return announceEnded(share);
}

async function announceEnded(share: LocationShare): Promise<LocationShareResponse> {
  const response = toResponse((await loadFull(share.id)) || share);
  emitTo([share.sharerId, ...audienceOf(share, await memberIdsOf(share.householdId))], 'location:share-ended', response);
  return response;
}

/** Runs now, or once the surrounding transaction has committed. */
function afterCommit(transaction: Transaction | undefined, fn: () => Promise<void>): Promise<void> {
  if (!transaction) return fn();
  transaction.afterCommit(() => {
    fn().catch(() => {});
  });
  return Promise.resolve();
}

// ── Service ──

export async function startShare(
  userId: string,
  body: StartShareBody,
  options: { notify?: boolean; transaction?: Transaction } = {},
): Promise<LocationShareResponse> {
  const householdId = await getUserHousehold(userId);

  if (body.durationMinutes > MAX_SHARE_MINUTES) {
    throw new AppError(400, 'You can share your location for up to 8 hours');
  }
  const memberIds = await memberIdsOf(householdId);
  if (body.viewerIds) {
    if (body.viewerIds.length === 0) throw new AppError(400, 'Choose at least one person to share with');
    if (body.viewerIds.some((id) => id === userId || !memberIds.includes(id))) {
      throw new AppError(400, 'You can only share with other members of your household');
    }
  }

  // One live share per person: starting a new one replaces the old, and its viewers are told.
  const now = new Date();
  const { transaction } = options;
  const earlier = await LocationShare.findAll({
    where: { sharerId: userId, endedAt: null, expiresAt: { [Op.gt]: now } },
    ...(transaction ? { transaction } : {}),
  });
  for (const old of earlier) await endShare(old, now, transaction);
  if (transaction) {
    await afterCommit(transaction, async () => {
      for (const old of earlier) await announceEnded(old);
    });
  }

  const created = await LocationShare.create(
    {
      householdId,
      sharerId: userId,
      viewerIds: body.viewerIds,
      pingRequestId: body.pingRequestId ?? null,
      startedAt: now,
      expiresAt: new Date(now.getTime() + body.durationMinutes * 60_000),
      latitude: body.latitude,
      longitude: body.longitude,
      accuracy: body.accuracy ?? null,
      locationUpdatedAt: now,
    },
    transaction ? { transaction } : undefined,
  );

  const audience = audienceOf(created, memberIds);

  await afterCommit(transaction, async () => {
    const full = await loadFull(created.id);
    emitTo([userId, ...audience], 'location:share-started', toResponse(full || created));

    if (options.notify !== false) {
      const sharer = await User.findByPk(userId);
      const firstName = (sharer?.displayName || 'Someone').split(' ')[0];
      for (const id of audience) {
        notificationService
          .notifyUser(id, 'location_share_started', `${firstName} is sharing their location`, durationText(body.durationMinutes), {
            type: 'location_share_started',
            shareId: created.id,
          })
          .catch(() => {});
      }
    }
  });

  // The created row carries no sharer include yet inside a transaction; the response is rebuilt from it.
  return toResponse(transaction ? created : (await loadFull(created.id)) || created);
}

export async function updateShareLocation(
  userId: string,
  shareId: string,
  body: UpdateShareLocationBody,
): Promise<LocationShareResponse> {
  const share = await loadOwnActive(userId, shareId, 'This location share is not yours to update');

  // Conditional write: the expiry job or a stop may have ended the share since it was loaded.
  const now = new Date();
  const [changed] = await LocationShare.update(
    { latitude: body.latitude, longitude: body.longitude, accuracy: body.accuracy ?? null, locationUpdatedAt: now },
    { where: { id: shareId, sharerId: userId, endedAt: null, expiresAt: { [Op.gt]: now } } },
  );
  if (!changed) throw new AppError(410, 'This location share has ended');

  const full = await loadFull(share.id);
  const response = toResponse(full || share);
  emitTo([userId, ...audienceOf(share, await memberIdsOf(share.householdId))], 'location:update', response);
  return response;
}

export async function stopShare(userId: string, shareId: string): Promise<LocationShareResponse> {
  const share = await loadOwnActive(userId, shareId, 'This location share is not yours to stop');
  return endShare(share, new Date());
}

export async function listShares(userId: string): Promise<LocationSharesResponse> {
  const householdId = await getUserHousehold(userId);
  const memberIds = await memberIdsOf(householdId);

  const shares = await LocationShare.findAll({
    where: { householdId, endedAt: null, expiresAt: { [Op.gt]: new Date() } },
    include: [{ model: User, as: 'sharer' }],
    order: [['startedAt', 'DESC']],
  });

  const mine = shares.find((s) => s.sharerId === userId) ?? null;
  const visible = shares.filter((s) => s.sharerId !== userId && audienceOf(s, memberIds).includes(userId));
  return { mine: mine ? toResponse(mine) : null, visible: visible.map(toResponse) };
}

/** Closes shares past their time; the end is stamped at the expiry, not when the job noticed. */
export async function endExpiredShares(now: Date): Promise<number> {
  const expired = await LocationShare.findAll({
    where: { endedAt: null, expiresAt: { [Op.lte]: now } },
    include: [{ model: User, as: 'sharer' }],
  });
  for (const share of expired) {
    await endShare(share, share.expiresAt);
  }
  return expired.length;
}

/** Ping responses link to the share they started; one lookup for a whole page of pings. */
export async function shareIdsByPing(pingRequestIds: string[]): Promise<Map<string, string>> {
  if (pingRequestIds.length === 0) return new Map();
  const shares = await LocationShare.findAll({
    where: { pingRequestId: { [Op.in]: pingRequestIds } },
    attributes: ['id', 'pingRequestId'],
  });
  return new Map(shares.map((s) => [s.pingRequestId as string, s.id]));
}
