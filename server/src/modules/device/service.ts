import { v4 as uuidv4 } from 'uuid';
import logger from '../../shared/utils/logger';
import redis from '../../config/redis';
import { Device, RefreshToken, DeviceToken } from '../../database/models';
import { NotFoundError } from '../../shared/utils/errors';
import type { DeviceInfo, DeviceResponse } from './types';

/** Register or refresh the device behind a sign-in. */
/** Access tokens outlive a removal by up to 15 minutes; this flag lets them be refused at once. */
export const revokedKey = (deviceId: string): string => `device:revoked:${deviceId}`;
const REVOKED_TTL_SECONDS = 86400; // well past the access token lifetime

export async function upsertDevice(userId: string, info: DeviceInfo): Promise<Device> {
  const now = new Date();

  // No device id (older build or odd client): never match a previous row, or
  // two unrelated clients would share, and be able to revoke, one session.
  const existing = info.deviceKey
    ? await Device.findOne({ where: { userId, deviceKey: info.deviceKey } })
    : null;

  if (existing) {
    if (info.name) existing.name = info.name;
    if (info.platform) existing.platform = info.platform;
    if (info.appVersion) existing.appVersion = info.appVersion;
    existing.lastSeenAt = now;
    const wasRevoked = existing.revokedAt != null;
    existing.revokedAt = null; // signing in again undoes a removal
    await existing.save();
    if (wasRevoked) {
      try {
        await redis.del(revokedKey(existing.id));
      } catch (err) {
        logger.warn(`Could not clear revoked flag for device ${existing.id}: ${(err as Error).message}`);
      }
    }
    return existing;
  }

  return Device.create({
    userId,
    deviceKey: info.deviceKey ?? uuidv4(),
    name: info.name ?? 'Unknown device',
    platform: info.platform,
    appVersion: info.appVersion,
    lastSeenAt: now,
  });
}

export async function listDevices(userId: string, currentDeviceId: string | null): Promise<DeviceResponse[]> {
  const devices = await Device.findAll({
    where: { userId, revokedAt: null },
    order: [['lastSeenAt', 'DESC']],
  });
  return devices.map((d) => ({
    id: d.id,
    name: d.name,
    platform: d.platform,
    appVersion: d.appVersion,
    lastSeenAt: d.lastSeenAt.toISOString(),
    createdAt: d.createdAt.toISOString(),
    current: d.id === currentDeviceId,
  }));
}

/** Sign a device out everywhere: its sessions and its push token go with it. */
export async function revokeDevice(
  userId: string,
  deviceId: string,
  opts: { keepRefreshTokens?: boolean } = {},
): Promise<void> {
  // Scoped to userId so another account's device id looks the same as a missing one.
  const device = await Device.findOne({ where: { id: deviceId, userId, revokedAt: null } });
  if (!device) throw new NotFoundError('Device');

  // The database goes first: it is the source of truth that authenticate falls back to when Redis is down.
  device.revokedAt = new Date();
  // A removed phone is no longer the key holder, so the account is never left pointing at a dead holder.
  device.holdsAccountKey = false;
  await device.save();
  try {
    await redis.set(revokedKey(deviceId), '1', 'EX', REVOKED_TTL_SECONDS);
  } catch (err) {
    // Not fatal: requests check the database whenever Redis errors. Sessions and push token still go below.
    logger.error(`Could not set revoked flag for device ${deviceId}: ${(err as Error).message}`);
  }
  // Kept for a key move so the old phone's next refresh answers DEVICE_REVOKED (which then removes it), not a bare 401.
  if (!opts.keepRefreshTokens) await RefreshToken.destroy({ where: { deviceId } });
  await DeviceToken.destroy({ where: { deviceId }, force: true });
}

/** Bump last-seen; false means the device was removed (or never existed). */
export async function touchDevice(deviceId: string): Promise<boolean> {
  const device = await Device.findOne({ where: { id: deviceId } });
  if (!device || device.revokedAt) return false;
  device.lastSeenAt = new Date();
  await device.save();
  return true;
}
