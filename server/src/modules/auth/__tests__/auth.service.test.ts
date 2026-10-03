import { register, updateProfile, googleAuth, appleAuth, sendVerification, verifyEmail, forgotPassword, resetPassword, checkResetCode, scheduleDeletion, cancelDeletion, confirmDeletion, registerPhone, sendPhoneOtp, verifyPhoneOtp } from '../service';
import { env } from '../../../config/env';

jest.mock('../../../shared/utils/mailer', () => ({ sendEmail: jest.fn(), sendAdminAlertEmail: jest.fn() }));
jest.mock('../../../shared/utils/sms', () => ({ sendSms: jest.fn() }));
jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(() => ({})),
  jwtVerify: jest.fn(),
}));

jest.mock('../../../database/models', () => ({
  User: { findOne: jest.fn(), findByPk: jest.fn(), create: jest.fn(), update: jest.fn() },
  RefreshToken: { count: jest.fn(), findAll: jest.fn(), destroy: jest.fn(), create: jest.fn(), findOne: jest.fn() },
  EmailVerification: { findOne: jest.fn(), update: jest.fn(), create: jest.fn() },
  PasswordReset: { findOne: jest.fn(), update: jest.fn(), create: jest.fn() },
  PhoneVerification: { findOne: jest.fn(), update: jest.fn(), create: jest.fn() },
}));

import * as models from '../../../database/models';
jest.mock('../../billing/deletion', () => ({
  onPurchaserDeleted: jest.fn().mockResolvedValue(undefined),
  reportPurchaserDeletionFailure: jest.fn().mockResolvedValue(undefined),
}));
import { onPurchaserDeleted, reportPurchaserDeletionFailure } from '../../billing/deletion';
import { sendEmail } from '../../../shared/utils/mailer';
import { sendSms } from '../../../shared/utils/sms';
import { jwtVerify } from 'jose';
import { hashOtpCode } from '../../../shared/utils/otp';

const mockIdToken = ['e30', 'e30', 'e30'].join('.');
const googleBody = { idToken: mockIdToken };

function fakeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: '550e8400-e29b-41d4-a716-446655440001',
    email: 'test@user.com',
    displayName: 'Test User',
    avatarUrl: null,
    avatarEmoji: null,
    role: 'member',
    isVerified: true,
    googleId: 'google123',
    passwordHash: '',
    lastLoginAt: null,
    createdAt: new Date('2026-07-04'),
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function setupGoogleJwt(payloadOverrides: Record<string, unknown> = {}) {
  (jwtVerify as jest.Mock).mockResolvedValue({
    payload: {
      sub: 'google123',
      email: 'test@user.com',
      email_verified: 'true',
      name: 'Test User',
      ...payloadOverrides,
    },
  });
}

describe('Auth Service — Register', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('should store a normalized phone when provided and not already taken', async () => {
    (models.User.findOne as jest.Mock)
      .mockResolvedValueOnce(null) // no existing user with this email
      .mockResolvedValueOnce(null); // no existing user with this phone
    (models.User.create as jest.Mock).mockResolvedValue(fakeUser({ isVerified: false }));
    (models.User.findByPk as jest.Mock).mockResolvedValue(fakeUser({ isVerified: false }));

    await register({ email: 'new@user.com', password: 'password123', phone: '(555) 010-0192' });

    expect(models.User.create).toHaveBeenCalledWith(
      expect.objectContaining({ phone: '5550100192' }),
    );
  });

  it('should register successfully with no phone provided', async () => {
    (models.User.findOne as jest.Mock).mockResolvedValueOnce(null);
    (models.User.create as jest.Mock).mockResolvedValue(fakeUser({ isVerified: false }));
    (models.User.findByPk as jest.Mock).mockResolvedValue(fakeUser({ isVerified: false }));

    await register({ email: 'new2@user.com', password: 'password123' });

    expect(models.User.create).toHaveBeenCalledWith(expect.objectContaining({ phone: null }));
  });

  it('should throw if the phone number already belongs to another account', async () => {
    (models.User.findOne as jest.Mock)
      .mockResolvedValueOnce(null) // email is free
      .mockResolvedValueOnce(fakeUser()); // phone is taken

    await expect(
      register({ email: 'new3@user.com', password: 'password123', phone: '5550100192' }),
    ).rejects.toThrow('An account with this phone number already exists');
    expect(models.User.create).not.toHaveBeenCalled();
  });
});

describe('Auth Service — Update Profile', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('should update dateOfBirth, homeAddress and phone together', async () => {
    const user = fakeUser({ phone: null }) as any;
    (models.User.findByPk as jest.Mock).mockResolvedValue(user);
    (models.User.findOne as jest.Mock).mockResolvedValue(null); // phone free

    await updateProfile(user.id, {
      dateOfBirth: '1990-05-11',
      homeAddress: '482 Maple Street, Austin, TX 78701',
      phone: '(555) 010-0192',
    });

    expect(user.dateOfBirth).toBe('1990-05-11');
    expect(user.homeAddress).toBe('482 Maple Street, Austin, TX 78701');
    expect(user.phone).toBe('5550100192');
    expect(user.save).toHaveBeenCalled();
  });

  it('should throw if the new phone number already belongs to another account', async () => {
    const user = fakeUser({ id: 'user-a', phone: null });
    const otherUser = fakeUser({ id: 'user-b', phone: '5550100192' });
    (models.User.findByPk as jest.Mock).mockResolvedValue(user);
    (models.User.findOne as jest.Mock).mockResolvedValue(otherUser);

    await expect(updateProfile(user.id, { phone: '5550100192' })).rejects.toThrow(
      'An account with this phone number already exists',
    );
    expect(user.save).not.toHaveBeenCalled();
  });

  it('should allow re-saving the same phone number already on the account', async () => {
    const user = fakeUser({ phone: '5550100192' });
    (models.User.findByPk as jest.Mock).mockResolvedValue(user);

    await updateProfile(user.id, { phone: '(555) 010-0192' });

    expect(models.User.findOne).not.toHaveBeenCalled();
    expect(user.save).toHaveBeenCalled();
  });
});

describe('Auth Service — Google OAuth', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('should create a new user from Google profile and return tokens', async () => {
    setupGoogleJwt();
    (models.User.findOne as jest.Mock).mockResolvedValue(null);
    (models.User.create as jest.Mock).mockResolvedValue(fakeUser());
    const result = await googleAuth(googleBody);
    expect(result.user.email).toBe('test@user.com');
    expect(result.tokens.accessToken).toBeTruthy();
    expect(result.tokens.refreshToken).toBeTruthy();
  });

  it('should link googleId to existing user found by email', async () => {
    setupGoogleJwt();
    const user = fakeUser({ googleId: null, save: jest.fn().mockResolvedValue(undefined) });
    (models.User.findOne as jest.Mock).mockResolvedValue(user);
    const result = await googleAuth(googleBody);
    expect(result.tokens.accessToken).toBeTruthy();
    expect(user.googleId).toBe('google123');
    expect(user.save).toHaveBeenCalled();
  });

  it('should authenticate existing googleId user', async () => {
    setupGoogleJwt();
    const user = fakeUser({ save: jest.fn().mockResolvedValue(undefined) });
    (models.User.findOne as jest.Mock).mockResolvedValue(user);
    await googleAuth(googleBody);
    expect(user.save).toHaveBeenCalled();
  });

  it('should throw if ID token verification fails (bad signature, expired, or audience/issuer mismatch — all handled by jwtVerify itself)', async () => {
    (jwtVerify as jest.Mock).mockRejectedValue(new Error('signature verification failed'));
    await expect(googleAuth(googleBody)).rejects.toThrow('Google ID token verification failed');
  });

  it('should reject linking into an existing email-matched account when Google reports the email unverified', async () => {
    setupGoogleJwt({ email_verified: 'false' });
    const user = fakeUser({ googleId: null, save: jest.fn().mockResolvedValue(undefined) });
    (models.User.findOne as jest.Mock).mockResolvedValue(user);

    await expect(googleAuth(googleBody)).rejects.toThrow('not verified');
    expect(user.googleId).toBeNull();
    expect(user.save).not.toHaveBeenCalled();
  });

  it('should reject creating a new account when Google reports the email unverified', async () => {
    setupGoogleJwt({ email_verified: 'false' });
    (models.User.findOne as jest.Mock).mockResolvedValue(null);

    await expect(googleAuth(googleBody)).rejects.toThrow('not verified');
    expect(models.User.create).not.toHaveBeenCalled();
  });
});

describe('Auth Service — Apple OAuth', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  const appleBody = { idToken: 'fake-apple-jwt', displayName: 'Apple User' };

  function setupAppleJwt(payloadOverrides: Record<string, unknown> = {}) {
    (jwtVerify as jest.Mock).mockResolvedValue({
      payload: { sub: 'apple123', email: 'test@user.com', email_verified: true, ...payloadOverrides },
    });
  }

  it('should create a new user from Apple profile and return tokens', async () => {
    setupAppleJwt();
    (models.User.findOne as jest.Mock).mockResolvedValue(null);
    (models.User.create as jest.Mock).mockResolvedValue(fakeUser({ appleId: 'apple123' }));

    const result = await appleAuth(appleBody);

    expect(result.user.email).toBe('test@user.com');
    expect(result.tokens.accessToken).toBeTruthy();
    expect(result.tokens.refreshToken).toBeTruthy();
    expect(models.User.create).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'test@user.com', displayName: 'Apple User', appleId: 'apple123' }),
    );
  });

  it('should fall back to deriving a name from the email when no displayName is provided (repeat sign-in)', async () => {
    setupAppleJwt();
    (models.User.findOne as jest.Mock).mockResolvedValue(null);
    (models.User.create as jest.Mock).mockResolvedValue(fakeUser({ appleId: 'apple123' }));

    await appleAuth({ idToken: 'fake-apple-jwt' });

    expect(models.User.create).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: 'test' }),
    );
  });

  it('should link appleId to existing user found by email', async () => {
    setupAppleJwt();
    const user = fakeUser({ appleId: null, save: jest.fn().mockResolvedValue(undefined) }) as any;
    (models.User.findOne as jest.Mock).mockResolvedValue(user);

    const result = await appleAuth(appleBody);

    expect(result.tokens.accessToken).toBeTruthy();
    expect(user.appleId).toBe('apple123');
    expect(user.save).toHaveBeenCalled();
  });

  it('should authenticate an existing appleId user', async () => {
    setupAppleJwt();
    const user = fakeUser({ appleId: 'apple123', save: jest.fn().mockResolvedValue(undefined) });
    (models.User.findOne as jest.Mock).mockResolvedValue(user);

    await appleAuth(appleBody);

    expect(user.save).toHaveBeenCalled();
  });

  it('should throw if ID token verification fails', async () => {
    (jwtVerify as jest.Mock).mockRejectedValue(new Error('bad signature'));

    await expect(appleAuth(appleBody)).rejects.toThrow('Apple ID token verification failed');
  });

  it('should throw if Apple did not provide an email', async () => {
    setupAppleJwt({ email: undefined });

    await expect(appleAuth(appleBody)).rejects.toThrow('did not provide an email');
  });

  it('should reject linking into an existing email-matched account when Apple reports the email unverified', async () => {
    setupAppleJwt({ email_verified: false });
    const user = fakeUser({ appleId: null, save: jest.fn().mockResolvedValue(undefined) }) as any;
    (models.User.findOne as jest.Mock).mockResolvedValue(user);

    await expect(appleAuth(appleBody)).rejects.toThrow('not verified');
    expect(user.appleId).toBeNull();
    expect(user.save).not.toHaveBeenCalled();
  });

  it('should reject creating a new account when Apple reports the email unverified', async () => {
    setupAppleJwt({ email_verified: false });
    (models.User.findOne as jest.Mock).mockResolvedValue(null);

    await expect(appleAuth(appleBody)).rejects.toThrow('not verified');
    expect(models.User.create).not.toHaveBeenCalled();
  });
});

describe('Auth Service — Email Verification', () => {
  beforeEach(() => { jest.clearAllMocks(); env.resend.apiKey = ''; });

  describe('sendVerification', () => {
    it('should generate a code, store it, and log it in dev mode (Resend unconfigured)', async () => {
      env.resend.apiKey = '';
      const user = fakeUser({ isVerified: false });
      (models.User.findByPk as jest.Mock).mockResolvedValue(user);

      await sendVerification(user.id);

      expect(models.EmailVerification.update).toHaveBeenCalled();
      expect(models.EmailVerification.create).toHaveBeenCalledWith(
        expect.objectContaining({ userId: user.id, token: expect.any(String) }),
      );
      expect(sendEmail).not.toHaveBeenCalled();
    });

    it('should send via Resend when configured', async () => {
      env.resend.apiKey = 'test-key';
      const user = fakeUser({ isVerified: false });
      (models.User.findByPk as jest.Mock).mockResolvedValue(user);

      await sendVerification(user.id);

      expect(sendEmail).toHaveBeenCalledWith(
        user.email,
        'Verify your Rootaroo email',
        expect.stringContaining('Your verification code is:'),
      );
    });

    it('should throw NotFoundError if user does not exist', async () => {
      (models.User.findByPk as jest.Mock).mockResolvedValue(null);
      await expect(sendVerification('nonexistent')).rejects.toThrow('User');
    });

    it('should throw ConflictError if already verified', async () => {
      const user = fakeUser({ isVerified: true });
      (models.User.findByPk as jest.Mock).mockResolvedValue(user);
      await expect(sendVerification(user.id)).rejects.toThrow('Email already verified');
    });
  });

  describe('verifyEmail', () => {
    it('should mark verification as used and set user as verified', async () => {
      const verification = { verifiedAt: null, save: jest.fn().mockResolvedValue(undefined) };
      (models.EmailVerification.findOne as jest.Mock).mockResolvedValue(verification);

      await verifyEmail('user-id', { code: '123456' });

      expect(verification.verifiedAt).toBeInstanceOf(Date);
      expect(verification.save).toHaveBeenCalled();
      expect(models.User.update).toHaveBeenCalledWith(
        { isVerified: true },
        { where: { id: 'user-id' } },
      );
    });

    it('should throw if code is invalid or expired', async () => {
      (models.EmailVerification.findOne as jest.Mock).mockResolvedValue(null);
      await expect(verifyEmail('user-id', { code: 'wrong' }))
        .rejects.toThrow('Invalid or expired verification code');
    });
  });
});

describe('Auth Service — Password Reset', () => {
  beforeEach(() => { jest.clearAllMocks(); env.resend.apiKey = ''; });

  describe('forgotPassword', () => {
    it('should generate a code, store it, and log it in dev mode (Resend unconfigured)', async () => {
      env.resend.apiKey = '';
      (models.User.findOne as jest.Mock).mockResolvedValue({ id: 'u1', email: 'test@user.com' });
      await forgotPassword({ email: 'test@user.com' });
      expect(models.PasswordReset.update).toHaveBeenCalled();
      expect(models.PasswordReset.create).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'u1', token: expect.any(String) }),
      );
      expect(sendEmail).not.toHaveBeenCalled();
    });

    it('should send via Resend when configured', async () => {
      env.resend.apiKey = 'test-key';
      (models.User.findOne as jest.Mock).mockResolvedValue({ id: 'u1', email: 'test@user.com' });

      await forgotPassword({ email: 'test@user.com' });

      expect(sendEmail).toHaveBeenCalledWith(
        'test@user.com',
        'Reset your Rootaroo password',
        expect.stringContaining('Your password reset code is:'),
      );
    });

    it('should return silently if user not found (prevent email enumeration)', async () => {
      (models.User.findOne as jest.Mock).mockResolvedValue(null);
      await forgotPassword({ email: 'missing@user.com' });
      expect(models.PasswordReset.create).not.toHaveBeenCalled();
    });
  });

  describe('resetPassword', () => {
    it('should hash new password, update user, mark code used, and revoke existing sessions', async () => {
      (models.User.findOne as jest.Mock).mockResolvedValue({ id: 'u1', email: 'test@user.com' });
      const record = {
        userId: 'u1', token: hashOtpCode('123456'), attempts: 0,
        update: jest.fn().mockResolvedValue(undefined), save: jest.fn().mockResolvedValue(undefined),
      };
      (models.PasswordReset.findOne as jest.Mock).mockResolvedValue(record);
      await resetPassword({ email: 'test@user.com', code: '123456', password: 'newpass123' });
      expect(models.User.update).toHaveBeenCalledWith(
        { passwordHash: expect.any(String) },
        { where: { id: 'u1' } },
      );
      expect(record.update).toHaveBeenCalledWith({ usedAt: expect.any(Date) });
      expect(models.RefreshToken.destroy).toHaveBeenCalledWith({ where: { userId: 'u1' } });
    });

    it('should throw for invalid or expired code', async () => {
      (models.User.findOne as jest.Mock).mockResolvedValue({ id: 'u1', email: 'test@user.com' });
      (models.PasswordReset.findOne as jest.Mock).mockResolvedValue(null);
      await expect(resetPassword({ email: 'test@user.com', code: 'wrong', password: 'newpass123' }))
        .rejects.toThrow('Invalid or expired reset code');
      expect(models.RefreshToken.destroy).not.toHaveBeenCalled();
    });

    it('should throw when the email does not match any account (code-only guessing no longer works)', async () => {
      (models.User.findOne as jest.Mock).mockResolvedValue(null);
      await expect(resetPassword({ email: 'nobody@user.com', code: '123456', password: 'newpass123' }))
        .rejects.toThrow('Invalid or expired reset code');
      expect(models.PasswordReset.findOne).not.toHaveBeenCalled();
    });

    it('should increment attempts and reject when the code does not match the stored hash', async () => {
      (models.User.findOne as jest.Mock).mockResolvedValue({ id: 'u1', email: 'test@user.com' });
      const record = { userId: 'u1', token: hashOtpCode('123456'), attempts: 0, save: jest.fn().mockResolvedValue(undefined) };
      (models.PasswordReset.findOne as jest.Mock).mockResolvedValue(record);
      await expect(resetPassword({ email: 'test@user.com', code: '000000', password: 'newpass123' }))
        .rejects.toThrow('Invalid or expired reset code');
      expect(record.attempts).toBe(1);
      expect(record.save).toHaveBeenCalled();
    });

    it('should lock out once attempts reach the max, without re-checking the hash', async () => {
      (models.User.findOne as jest.Mock).mockResolvedValue({ id: 'u1', email: 'test@user.com' });
      const record = { userId: 'u1', token: hashOtpCode('123456'), attempts: 5, save: jest.fn() };
      (models.PasswordReset.findOne as jest.Mock).mockResolvedValue(record);
      await expect(resetPassword({ email: 'test@user.com', code: '123456', password: 'newpass123' }))
        .rejects.toThrow('Invalid or expired reset code');
      expect(record.save).not.toHaveBeenCalled();
    });
  });

  describe('checkResetCode', () => {
    it('should resolve without throwing for a valid, unexpired, unused code', async () => {
      (models.User.findOne as jest.Mock).mockResolvedValue({ id: 'u1', email: 'test@user.com' });
      (models.PasswordReset.findOne as jest.Mock).mockResolvedValue({ userId: 'u1', token: hashOtpCode('123456'), attempts: 0 });
      await expect(checkResetCode({ email: 'test@user.com', code: '123456' })).resolves.toBeUndefined();
    });

    it('should throw for invalid or expired code without consuming anything', async () => {
      (models.User.findOne as jest.Mock).mockResolvedValue({ id: 'u1', email: 'test@user.com' });
      (models.PasswordReset.findOne as jest.Mock).mockResolvedValue(null);
      await expect(checkResetCode({ email: 'test@user.com', code: '000000' })).rejects.toThrow('Invalid or expired reset code');
      expect(models.User.update).not.toHaveBeenCalled();
    });
  });
});

describe('Auth Service — Account Deletion', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  describe('scheduleDeletion', () => {
    const hash = '$2b$04$bUCIhz76H.vDDixGSaXRt.vmZy8izCpNSiK4ZVGtmhtY1twdLD31W';

    it('should set scheduledDeletionAt to 30 days from now', async () => {
      const user = { id: 'u1', passwordHash: hash, scheduledDeletionAt: null, save: jest.fn() };
      (models.User.findByPk as jest.Mock).mockResolvedValue(user);
      await scheduleDeletion('u1', { password: 'password123' });
      expect(user.scheduledDeletionAt).toBeInstanceOf(Date);
      expect(user.save).toHaveBeenCalled();
    });

    it('should throw for wrong password', async () => {
      (models.User.findByPk as jest.Mock).mockResolvedValue({
        id: 'u1', passwordHash: hash, save: jest.fn(),
      });
      await expect(scheduleDeletion('u1', { password: 'wrong' }))
        .rejects.toThrow('Invalid password');
    });

    it('should throw if user not found', async () => {
      (models.User.findByPk as jest.Mock).mockResolvedValue(null);
      await expect(scheduleDeletion('missing', { password: 'x' }))
        .rejects.toThrow('User');
    });

    it('should allow a password-less (OAuth) account with a freshly issued token', async () => {
      const user = { id: 'u1', passwordHash: '', scheduledDeletionAt: null, save: jest.fn() };
      (models.User.findByPk as jest.Mock).mockResolvedValue(user);
      const nowSeconds = Math.floor(Date.now() / 1000);

      await scheduleDeletion('u1', { password: '' }, nowSeconds);

      expect(user.save).toHaveBeenCalled();
    });

    it('should reject a password-less (OAuth) account with a stale token', async () => {
      const user = { id: 'u1', passwordHash: '', scheduledDeletionAt: null, save: jest.fn() };
      (models.User.findByPk as jest.Mock).mockResolvedValue(user);
      const staleIssuedAt = Math.floor(Date.now() / 1000) - 10 * 60;

      await expect(scheduleDeletion('u1', { password: '' }, staleIssuedAt))
        .rejects.toThrow('Please log in again');
      expect(user.save).not.toHaveBeenCalled();
    });
  });

  describe('cancelDeletion', () => {
    it('should clear scheduledDeletionAt', async () => {
      const user = { id: 'u1', scheduledDeletionAt: new Date(), save: jest.fn() };
      (models.User.findByPk as jest.Mock).mockResolvedValue(user);
      await cancelDeletion('u1');
      expect(user.scheduledDeletionAt).toBeNull();
      expect(user.save).toHaveBeenCalled();
    });
  });

  describe('confirmDeletion', () => {
    const hash = '$2b$04$bUCIhz76H.vDDixGSaXRt.vmZy8izCpNSiK4ZVGtmhtY1twdLD31W';

    const elapsedGracePeriod = new Date(Date.now() - 24 * 60 * 60 * 1000); // 1 day in the past

    it('should revoke tokens and soft-delete user', async () => {
      const user = {
        id: 'u1',
        passwordHash: hash,
        scheduledDeletionAt: elapsedGracePeriod,
        update: jest.fn().mockResolvedValue(undefined),
        destroy: jest.fn().mockResolvedValue(undefined),
      };
      (models.User.findByPk as jest.Mock).mockResolvedValue(user);
      await confirmDeletion('u1', { password: 'password123' });
      expect(models.RefreshToken.destroy).toHaveBeenCalledWith({ where: { userId: 'u1' } });
      expect(user.destroy).toHaveBeenCalled();
      expect(onPurchaserDeleted).toHaveBeenCalledWith('u1', undefined);
    });

    it('passes the original email to the billing hook and reports a failure per affected mode without blocking deletion', async () => {
      const user = {
        id: 'u1', email: 'orig@user.com', passwordHash: hash, scheduledDeletionAt: elapsedGracePeriod,
        update: jest.fn().mockResolvedValue(undefined), destroy: jest.fn().mockResolvedValue(undefined),
      };
      (models.User.findByPk as jest.Mock).mockResolvedValue(user);
      const boom = new Error('stripe down');
      (onPurchaserDeleted as jest.Mock).mockRejectedValueOnce(boom);
      await confirmDeletion('u1', { password: 'password123' });
      expect(onPurchaserDeleted).toHaveBeenCalledWith('u1', 'orig@user.com');
      expect(reportPurchaserDeletionFailure).toHaveBeenCalledWith('u1', boom);
      expect(user.destroy).toHaveBeenCalled();
    });

    it('should throw if the 30-day grace period has not been scheduled or has not elapsed yet', async () => {
      const user = { id: 'u1', passwordHash: hash, scheduledDeletionAt: null, destroy: jest.fn() };
      (models.User.findByPk as jest.Mock).mockResolvedValue(user);
      await expect(confirmDeletion('u1', { password: 'password123' }))
        .rejects.toThrow('Deletion must be scheduled first');
      expect(user.destroy).not.toHaveBeenCalled();
    });

    it('should free up email/phone/googleId before soft-deleting, so they can be reused', async () => {
      const user = {
        id: 'u1',
        passwordHash: hash,
        scheduledDeletionAt: elapsedGracePeriod,
        update: jest.fn().mockResolvedValue(undefined),
        destroy: jest.fn().mockResolvedValue(undefined),
      };
      (models.User.findByPk as jest.Mock).mockResolvedValue(user);
      await confirmDeletion('u1', { password: 'password123' });
      expect(user.update).toHaveBeenCalledWith({
        email: 'deleted-u1@deleted.rootaroo.local',
        phone: null,
        googleId: null,
      });
      // Freeing the identifiers must happen before the soft-delete, not after.
      const updateOrder = (user.update as jest.Mock).mock.invocationCallOrder[0];
      const destroyOrder = (user.destroy as jest.Mock).mock.invocationCallOrder[0];
      expect(updateOrder).toBeLessThan(destroyOrder);
    });
  });
});

describe('Auth Service — Phone OTP (app-owned code, delivered via Twilio)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    env.twilio.accountSid = 'ACtest';
    env.twilio.authToken = 'test-auth-token';
    env.twilio.fromNumber = '+15005550006';
    (models.PhoneVerification.update as jest.Mock).mockResolvedValue([0]);
    (models.PhoneVerification.create as jest.Mock).mockResolvedValue({ id: 'pv1' });
  });

  function fakePhoneUser(overrides: Record<string, unknown> = {}) {
    return {
      id: 'u1',
      phone: '+15551234567',
      isPhoneVerified: false,
      displayName: 'Phone User',
      createdAt: new Date('2026-07-04'),
      save: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  describe('registerPhone', () => {
    it('should create the user and issue tokens without sending an OTP', async () => {
      (models.User.findOne as jest.Mock).mockResolvedValue(null);
      (models.User.create as jest.Mock).mockResolvedValue(fakePhoneUser());

      const result = await registerPhone({ phone: '+15551234567', displayName: 'Phone User' });

      expect(result.tokens.accessToken).toBeTruthy();
      expect(result.tokens.refreshToken).toBeTruthy();
      expect(sendSms).not.toHaveBeenCalled();
      expect(models.PhoneVerification.create).not.toHaveBeenCalled();
    });

    it('should reject when a verified account already owns this phone number', async () => {
      (models.User.findOne as jest.Mock).mockResolvedValue(fakePhoneUser({ isPhoneVerified: true }));

      await expect(registerPhone({ phone: '+15551234567', displayName: 'Attacker' }))
        .rejects.toThrow('already exists. Please sign in');
      expect(models.User.create).not.toHaveBeenCalled();
    });

    it('should reject (not overwrite) when an unverified pending account already owns this phone number', async () => {
      const victim = fakePhoneUser({ id: 'victim-1', displayName: 'Victim', isPhoneVerified: false });
      (models.User.findOne as jest.Mock).mockResolvedValue(victim);

      await expect(registerPhone({ phone: '+15551234567', displayName: 'Attacker' }))
        .rejects.toThrow('pending registration already exists');
      expect(models.User.create).not.toHaveBeenCalled();
      expect(victim.displayName).toBe('Victim');
      expect(victim.save).not.toHaveBeenCalled();
    });
  });

  describe('sendPhoneOtp', () => {
    it('should send an OTP for an existing user', async () => {
      (models.User.findByPk as jest.Mock).mockResolvedValue(fakePhoneUser());

      await sendPhoneOtp({ phone: '+15551234567' }, 'u1');

      expect(sendSms).toHaveBeenCalledWith(
        '+15551234567',
        expect.stringContaining('Rootaroo verification code'),
      );
      expect(models.PhoneVerification.create).toHaveBeenCalledWith(
        expect.objectContaining({ phone: '+15551234567', userId: 'u1', token: expect.any(String) }),
      );
    });

    it('should create a placeholder user for an unauthenticated, unregistered number instead of sending an unresolvable OTP', async () => {
      (models.User.findOne as jest.Mock)
        .mockResolvedValueOnce(null) // no existing user for this phone
        .mockResolvedValueOnce(null); // no existing placeholder by synthetic email either
      (models.User.create as jest.Mock).mockResolvedValue(fakePhoneUser({ id: 'new-u1' }));

      await sendPhoneOtp({ phone: '+15559998888' });

      expect(models.User.create).toHaveBeenCalledWith(
        expect.objectContaining({ phone: '+15559998888', displayName: 'Member', isPhoneVerified: false }),
      );
      expect(models.PhoneVerification.create).toHaveBeenCalledWith(
        expect.objectContaining({ phone: '+15559998888', userId: 'new-u1' }),
      );
    });

    it('should throw if the phone does not match the authenticated user\'s account', async () => {
      (models.User.findByPk as jest.Mock).mockResolvedValue(fakePhoneUser({ phone: '+15551111111' }));

      await expect(sendPhoneOtp({ phone: '+15552222222' }, 'u1'))
        .rejects.toThrow('Phone does not match your account');
    });

    it('should fall back to a dev-mode logged code instead of calling Twilio when unconfigured', async () => {
      env.twilio.accountSid = '';
      (models.User.findByPk as jest.Mock).mockResolvedValue(fakePhoneUser());

      const code = await sendPhoneOtp({ phone: '+15551234567' }, 'u1');

      expect(code).toMatch(/^\d{6}$/);
      expect(sendSms).not.toHaveBeenCalled();
    });
  });

  describe('verifyPhoneOtp', () => {
    it('should mark the user verified and issue tokens for a valid code', async () => {
      const record = {
        userId: 'u1', token: hashOtpCode('123456'), attempts: 0, verifiedAt: null,
        save: jest.fn().mockResolvedValue(undefined),
      };
      (models.PhoneVerification.findOne as jest.Mock).mockResolvedValue(record);
      const user = fakePhoneUser();
      (models.User.findByPk as jest.Mock).mockResolvedValue(user);

      const result = await verifyPhoneOtp({ phone: '+15551234567', code: '123456' }, 'u1');

      expect(models.PhoneVerification.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ phone: '+15551234567', verifiedAt: null }),
        }),
      );
      expect(record.verifiedAt).toBeInstanceOf(Date);
      expect(user.isPhoneVerified).toBe(true);
      expect(result.tokens.accessToken).toBeTruthy();
    });

    it('should throw for an invalid or expired code without consuming anything', async () => {
      (models.PhoneVerification.findOne as jest.Mock).mockResolvedValue(null);

      await expect(verifyPhoneOtp({ phone: '+15551234567', code: '000000' }, 'u1'))
        .rejects.toThrow('Invalid or expired verification code');
      expect(models.User.findByPk).not.toHaveBeenCalled();
    });

    it('should increment attempts and reject when the code does not match the stored hash', async () => {
      const record = {
        userId: 'u1', token: hashOtpCode('123456'), attempts: 0, verifiedAt: null,
        save: jest.fn().mockResolvedValue(undefined),
      };
      (models.PhoneVerification.findOne as jest.Mock).mockResolvedValue(record);

      await expect(verifyPhoneOtp({ phone: '+15551234567', code: '000000' }, 'u1'))
        .rejects.toThrow('Invalid or expired verification code');
      expect(record.attempts).toBe(1);
      expect(record.save).toHaveBeenCalled();
      expect(models.User.findByPk).not.toHaveBeenCalled();
    });

    it('should lock out once attempts reach the max, without re-checking the hash', async () => {
      const record = { userId: 'u1', token: hashOtpCode('123456'), attempts: 5, verifiedAt: null, save: jest.fn() };
      (models.PhoneVerification.findOne as jest.Mock).mockResolvedValue(record);

      await expect(verifyPhoneOtp({ phone: '+15551234567', code: '123456' }, 'u1'))
        .rejects.toThrow('Invalid or expired verification code');
      expect(record.save).not.toHaveBeenCalled();
    });
  });
});
