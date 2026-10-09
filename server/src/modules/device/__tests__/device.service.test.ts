jest.mock('../../../database/models', () => ({
  Device: { findOne: jest.fn(), findAll: jest.fn(), create: jest.fn() },
  RefreshToken: { destroy: jest.fn() },
  DeviceToken: { destroy: jest.fn() },
}));

jest.mock('../../../config/redis', () => ({ __esModule: true, default: { set: jest.fn(), del: jest.fn() } }));

import redis from '../../../config/redis';
import { Device, RefreshToken, DeviceToken } from '../../../database/models';
import { upsertDevice, listDevices, revokeDevice, touchDevice } from '../service';
import { NotFoundError } from '../../../shared/utils/errors';

const userId = 'u1';
const info = { deviceKey: '3f2a7c1e-8b4d-4e2f-9a6b-1c2d3e4f5a6b', name: "Asha's iPhone", platform: 'ios' as const, appVersion: '1.4.0' };

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'd1', userId, deviceKey: info.deviceKey, name: 'Old name', platform: 'ios', appVersion: '1.3.0',
    lastSeenAt: new Date('2026-10-01T00:00:00Z'), createdAt: new Date('2026-09-01T00:00:00Z'), revokedAt: null, holdsAccountKey: false,
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

beforeEach(() => jest.clearAllMocks());

describe('upsertDevice', () => {
  it('creates a device the first time this phone signs in to this account', async () => {
    (Device.findOne as jest.Mock).mockResolvedValue(null);
    (Device.create as jest.Mock).mockImplementation(async (v) => ({ id: 'new', ...v }));
    const d = await upsertDevice(userId, info);
    expect(Device.findOne).toHaveBeenCalledWith({ where: { userId, deviceKey: info.deviceKey } });
    expect(Device.create).toHaveBeenCalledWith(expect.objectContaining({
      userId, deviceKey: info.deviceKey, name: "Asha's iPhone", platform: 'ios', appVersion: '1.4.0', lastSeenAt: expect.any(Date),
    }));
    expect(d.id).toBe('new');
  });

  it('updates name, version and last seen on a known device', async () => {
    const existing = row();
    (Device.findOne as jest.Mock).mockResolvedValue(existing);
    await upsertDevice(userId, info);
    expect(existing.name).toBe("Asha's iPhone");
    expect(existing.appVersion).toBe('1.4.0');
    expect(existing.save).toHaveBeenCalled();
    expect(Device.create).not.toHaveBeenCalled();
  });

  it('signing in again on a removed device brings it back', async () => {
    const existing = row({ revokedAt: new Date() });
    (Device.findOne as jest.Mock).mockResolvedValue(existing);
    await upsertDevice(userId, info);
    expect(existing.revokedAt).toBeNull();
  });

  it('signing in again never makes the phone the key holder', async () => {
    const existing = row({ revokedAt: new Date(), holdsAccountKey: false });
    (Device.findOne as jest.Mock).mockResolvedValue(existing);
    await upsertDevice(userId, info);
    expect(existing.revokedAt).toBeNull();
    expect(existing.holdsAccountKey).toBe(false);
    (Device.create as jest.Mock).mockImplementation(async (v) => ({ id: 'new', ...v }));
    (Device.findOne as jest.Mock).mockResolvedValue(null);
    await upsertDevice(userId, info);
    expect(JSON.stringify((Device.create as jest.Mock).mock.calls[0][0])).not.toContain('holdsAccountKey');
  });

  it('a request without a device id still gets its own device row', async () => {
    (Device.findOne as jest.Mock).mockResolvedValue(null);
    (Device.create as jest.Mock).mockImplementation(async (v) => ({ id: 'anon', ...v }));
    await upsertDevice(userId, { deviceKey: null, name: null, platform: null, appVersion: null });
    expect(Device.findOne).not.toHaveBeenCalled();
    expect(Device.create).toHaveBeenCalledWith(expect.objectContaining({
      userId, deviceKey: expect.stringMatching(/^[0-9a-f-]{36}$/), name: 'Unknown device',
    }));
  });
});

describe('listDevices', () => {
  it('lists active devices, most recently used first, and marks this one', async () => {
    (Device.findAll as jest.Mock).mockResolvedValue([
      row({ id: 'd1', name: 'Phone', lastSeenAt: new Date('2026-10-08T10:00:00Z') }),
      row({ id: 'd2', name: 'Tablet', platform: 'android', lastSeenAt: new Date('2026-10-01T10:00:00Z') }),
    ]);
    const list = await listDevices(userId, 'd2');
    expect(Device.findAll).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId, revokedAt: null }, order: [['lastSeenAt', 'DESC']],
    }));
    expect(list).toEqual([
      { id: 'd1', name: 'Phone', platform: 'ios', appVersion: '1.3.0', lastSeenAt: '2026-10-08T10:00:00.000Z', createdAt: '2026-09-01T00:00:00.000Z', current: false },
      { id: 'd2', name: 'Tablet', platform: 'android', appVersion: '1.3.0', lastSeenAt: '2026-10-01T10:00:00.000Z', createdAt: '2026-09-01T00:00:00.000Z', current: true },
    ]);
  });

  it('never exposes the device key', async () => {
    (Device.findAll as jest.Mock).mockResolvedValue([row()]);
    const [d] = await listDevices(userId, null);
    expect(JSON.stringify(d)).not.toContain(info.deviceKey);
  });
});

describe('revokeDevice', () => {
  it('marks the device removed and kills its sessions and push token at once', async () => {
    const d = row();
    (Device.findOne as jest.Mock).mockResolvedValue(d);
    await revokeDevice(userId, 'd1');
    expect(Device.findOne).toHaveBeenCalledWith({ where: { id: 'd1', userId, revokedAt: null } });
    expect(d.revokedAt).toBeInstanceOf(Date);
    expect(d.save).toHaveBeenCalled();
    expect(RefreshToken.destroy).toHaveBeenCalledWith({ where: { deviceId: 'd1' } });
    expect(DeviceToken.destroy).toHaveBeenCalledWith({ where: { deviceId: 'd1' }, force: true });
  });

  it('revoking the key holder clears the holder flag', async () => {
    const d = row({ holdsAccountKey: true });
    (Device.findOne as jest.Mock).mockResolvedValue(d);
    await revokeDevice(userId, 'd1');
    expect(d.holdsAccountKey).toBe(false);
    expect(d.save).toHaveBeenCalled();
  });

  it('writes revokedAt to the database before the Redis marker, and survives a Redis failure', async () => {
    const d = row();
    const order: string[] = [];
    d.save.mockImplementation(async () => { order.push('db'); });
    (redis.set as jest.Mock).mockImplementationOnce(async () => { order.push('redis'); throw new Error('redis down'); });
    (Device.findOne as jest.Mock).mockResolvedValue(d);
    await expect(revokeDevice(userId, 'd1')).resolves.toBeUndefined();
    expect(order).toEqual(['db', 'redis']);
    expect(d.revokedAt).toBeInstanceOf(Date);
    expect(RefreshToken.destroy).toHaveBeenCalledWith({ where: { deviceId: 'd1' } });
    expect(DeviceToken.destroy).toHaveBeenCalled();
  });

  it("refuses someone else's device without revealing it exists", async () => {
    (Device.findOne as jest.Mock).mockResolvedValue(null);
    await expect(revokeDevice(userId, 'other')).rejects.toBeInstanceOf(NotFoundError);
    expect(RefreshToken.destroy).not.toHaveBeenCalled();
  });
});

describe('touchDevice', () => {
  it('refreshes last seen for an active device and reports it active', async () => {
    const d = row();
    (Device.findOne as jest.Mock).mockResolvedValue(d);
    expect(await touchDevice('d1')).toBe(true);
    expect(d.lastSeenAt.getTime()).toBeGreaterThan(new Date('2026-10-02').getTime());
  });

  it('reports a removed or missing device as inactive', async () => {
    (Device.findOne as jest.Mock).mockResolvedValue(row({ revokedAt: new Date() }));
    expect(await touchDevice('d1')).toBe(false);
    (Device.findOne as jest.Mock).mockResolvedValue(null);
    expect(await touchDevice('gone')).toBe(false);
  });
});

describe('revocation marker for live access tokens', () => {
  it('revokeDevice flags the device in Redis for a day', async () => {
    (Device.findOne as jest.Mock).mockResolvedValue(row());
    await revokeDevice(userId, 'd1');
    expect(redis.set).toHaveBeenCalledWith('device:revoked:d1', '1', 'EX', 86400);
  });

  it('signing in again on a revoked device clears the flag', async () => {
    (Device.findOne as jest.Mock).mockResolvedValue(row({ revokedAt: new Date() }));
    await upsertDevice(userId, info);
    expect(redis.del).toHaveBeenCalledWith('device:revoked:d1');
  });
});
