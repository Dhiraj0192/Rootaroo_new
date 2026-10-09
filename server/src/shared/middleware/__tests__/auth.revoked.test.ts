jest.mock('../../../config/redis', () => ({ __esModule: true, default: { get: jest.fn(), exists: jest.fn() } }));
jest.mock('../../../database/models', () => ({ Device: { findOne: jest.fn() } }));
jest.mock('../../utils/logger', () => ({ __esModule: true, default: { warn: jest.fn(), error: jest.fn(), info: jest.fn() } }));

import jwt from 'jsonwebtoken';
import redis from '../../../config/redis';
import logger from '../../utils/logger';
import { Device } from '../../../database/models';
import { env } from '../../../config/env';
import { authenticate } from '../auth';
import { UnauthorizedError } from '../../utils/errors';

const exists = redis.exists as unknown as jest.Mock;
const deviceFind = Device.findOne as unknown as jest.Mock;

function run(claims: Record<string, unknown>) {
  const token = jwt.sign({ userId: 'u1', email: 'a@b.c', role: 'member', ...claims }, env.jwt.accessSecret);
  const req = { headers: { authorization: `Bearer ${token}` } } as any;
  return new Promise<{ req: any; err?: any }>((resolve) => {
    authenticate(req, {} as any, (err?: any) => resolve({ req, err }));
  });
}

beforeEach(() => jest.clearAllMocks());

describe('authenticate and revoked devices', () => {
  it('rejects a valid token whose device was removed', async () => {
    exists.mockResolvedValue(1);
    const { err } = await run({ deviceId: 'd1' });
    expect(exists).toHaveBeenCalledWith('device:revoked:d1');
    expect(err).toBeInstanceOf(UnauthorizedError);
    expect(err.code).toBe('DEVICE_REVOKED');
  });

  it('passes when the device is not revoked', async () => {
    exists.mockResolvedValue(0);
    const { req, err } = await run({ deviceId: 'd1' });
    expect(err).toBeUndefined();
    expect(req.user.deviceId).toBe('d1');
  });

  it('passes a token without a device id without asking Redis', async () => {
    const { err } = await run({});
    expect(err).toBeUndefined();
    expect(exists).not.toHaveBeenCalled();
  });

  it('when Redis errors, a device the database says is revoked is refused', async () => {
    exists.mockRejectedValue(new Error('down'));
    deviceFind.mockResolvedValue({ id: 'd1', revokedAt: new Date() });
    const { err } = await run({ deviceId: 'd1' });
    expect(deviceFind).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'd1' } }));
    expect(err).toBeInstanceOf(UnauthorizedError);
    expect(err.code).toBe('DEVICE_REVOKED');
    expect(logger.warn).toHaveBeenCalled();
  });

  it('when Redis errors, a device the database says is active passes', async () => {
    exists.mockRejectedValue(new Error('down'));
    deviceFind.mockResolvedValue({ id: 'd1', revokedAt: null });
    const { err } = await run({ deviceId: 'd1' });
    expect(err).toBeUndefined();
  });

  it('when Redis errors and the device row is gone, it is refused', async () => {
    exists.mockRejectedValue(new Error('down'));
    deviceFind.mockResolvedValue(null);
    const { err } = await run({ deviceId: 'd1' });
    expect(err.code).toBe('DEVICE_REVOKED');
  });

  it('when Redis and the database both fail, the request fails closed', async () => {
    exists.mockRejectedValue(new Error('down'));
    deviceFind.mockRejectedValue(new Error('db down'));
    const { err } = await run({ deviceId: 'd1' });
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('db down');
  });

  it('does not consult the database when Redis answers', async () => {
    exists.mockResolvedValue(0);
    await run({ deviceId: 'd1' });
    expect(deviceFind).not.toHaveBeenCalled();
  });
});
