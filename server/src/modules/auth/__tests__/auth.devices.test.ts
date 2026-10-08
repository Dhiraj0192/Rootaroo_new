jest.mock('../../../shared/utils/mailer', () => ({ sendEmail: jest.fn(), sendAdminAlertEmail: jest.fn() }));
jest.mock('../../../shared/utils/sms', () => ({ sendSms: jest.fn() }));
jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(() => ({})), jwtVerify: jest.fn() }));
jest.mock('bcrypt', () => ({ compare: jest.fn(async () => true), hash: jest.fn(async () => 'hash') }));
jest.mock('../../device/service', () => ({
  upsertDevice: jest.fn(async () => ({ id: 'dev-1' })),
  touchDevice: jest.fn(async () => true),
}));
jest.mock('../../../database/models', () => ({
  User: { findOne: jest.fn(), findByPk: jest.fn(), create: jest.fn(), update: jest.fn() },
  RefreshToken: { count: jest.fn(async () => 0), findAll: jest.fn(async () => []), destroy: jest.fn(), create: jest.fn(), findOne: jest.fn() },
  EmailVerification: { findOne: jest.fn(), update: jest.fn(), create: jest.fn() },
  PasswordReset: { findOne: jest.fn(), update: jest.fn(), create: jest.fn() },
  PhoneVerification: { findOne: jest.fn(), update: jest.fn(), create: jest.fn() },
}));
jest.mock('../../billing/deletion', () => ({ onPurchaserDeleted: jest.fn(), reportPurchaserDeletionFailure: jest.fn() }));

import jwt from 'jsonwebtoken';
import * as models from '../../../database/models';
import { upsertDevice, touchDevice } from '../../device/service';
import { login, refresh } from '../service';
import { UnauthorizedError } from '../../../shared/utils/errors';

const device = { deviceKey: '3f2a7c1e-8b4d-4e2f-9a6b-1c2d3e4f5a6b', name: 'Phone', platform: 'ios' as const, appVersion: '1.4.0' };
const user = {
  id: 'u1', email: 'a@example.com', displayName: 'A', avatarUrl: null, avatarEmoji: null, role: 'member', isVerified: true,
  passwordHash: 'hash', lastLoginAt: null, createdAt: new Date('2026-01-01'), save: jest.fn(),
};

beforeEach(() => jest.clearAllMocks());

describe('sessions are tied to a device', () => {
  it('login registers the device and issues a refresh token for it, replacing that device\'s old one', async () => {
    (models.User.findOne as jest.Mock).mockResolvedValue(user);
    const res = await login({ email: 'a@example.com', password: 'pw' }, device);
    expect(upsertDevice).toHaveBeenCalledWith('u1', device);
    expect(models.RefreshToken.destroy).toHaveBeenCalledWith({ where: { userId: 'u1', deviceId: 'dev-1' } });
    expect(models.RefreshToken.create).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', deviceId: 'dev-1' }));
    const claims = jwt.decode(res.tokens.accessToken) as Record<string, unknown>;
    expect(claims.deviceId).toBe('dev-1');
  });

  it('refresh keeps the same device and updates its last-seen time', async () => {
    const record = { userId: 'u1', deviceId: 'dev-1', expiresAt: new Date(Date.now() + 60_000), user, destroy: jest.fn() };
    (models.RefreshToken.findOne as jest.Mock).mockResolvedValue(record);
    const tokens = await refresh('old');
    expect(touchDevice).toHaveBeenCalledWith('dev-1');
    expect(models.RefreshToken.create).toHaveBeenCalledWith(expect.objectContaining({ deviceId: 'dev-1' }));
    expect((jwt.decode(tokens.accessToken) as Record<string, unknown>).deviceId).toBe('dev-1');
  });

  it('refresh fails on a removed device, which signs it out', async () => {
    const record = { userId: 'u1', deviceId: 'dev-1', expiresAt: new Date(Date.now() + 60_000), user, destroy: jest.fn() };
    (models.RefreshToken.findOne as jest.Mock).mockResolvedValue(record);
    (touchDevice as jest.Mock).mockResolvedValueOnce(false);
    await expect(refresh('old')).rejects.toBeInstanceOf(UnauthorizedError);
    expect(record.destroy).toHaveBeenCalled();
    expect(models.RefreshToken.create).not.toHaveBeenCalled();
  });

  it('refresh tokens from before devices existed are rejected', async () => {
    const record = { userId: 'u1', deviceId: null, expiresAt: new Date(Date.now() + 60_000), user, destroy: jest.fn() };
    (models.RefreshToken.findOne as jest.Mock).mockResolvedValue(record);
    await expect(refresh('legacy')).rejects.toBeInstanceOf(UnauthorizedError);
  });
});
