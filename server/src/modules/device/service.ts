import { v4 as uuidv4 } from 'uuid';
import { Device, RefreshToken, DeviceToken } from '../../database/models';
import { NotFoundError } from '../../shared/utils/errors';
import type { DeviceInfo, DeviceResponse } from './types';

/** Register or refresh the device behind a sign-in. */
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
    existing.revokedAt = null; // signing in again undoes a removal
    await existing.save();
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
export async function revokeDevice(userId: string, deviceId: string): Promise<void> {
  // Scoped to userId so another account's device id looks the same as a missing one.
  const device = await Device.findOne({ where: { id: deviceId, userId, revokedAt: null } });
  if (!device) throw new NotFoundError('Device');

  device.revokedAt = new Date();
  await device.save();
  await RefreshToken.destroy({ where: { deviceId } });
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
