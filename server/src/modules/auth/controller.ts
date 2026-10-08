import { Request, Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../shared/middleware/auth';
import * as authService from './service';
import { readDeviceInfo } from '../../shared/middleware/deviceContext';
import { uploadBuffer } from '../../shared/utils/s3';
import { userUploadFolder } from '../../shared/utils/uploadKeys';
import { resizeImageBuffer } from '../../shared/utils/image';
import type { AuthResponse, AuthTokens } from './types';

export async function register(req: Request, res: Response, next: NextFunction) {
  try {
    const result: AuthResponse = await authService.register(req.body, readDeviceInfo(req));
    res.status(201).json({ success: true, data: result });
  } catch (e) { next(e); }
}

export async function login(req: Request, res: Response, next: NextFunction) {
  try {
    const result: AuthResponse = await authService.login(req.body, readDeviceInfo(req));
    res.status(200).json({ success: true, data: result });
  } catch (e) { next(e); }
}

export async function refresh(req: Request, res: Response, next: NextFunction) {
  try {
    const result: AuthTokens = await authService.refresh(req.body.refreshToken);
    res.status(200).json({ success: true, data: result });
  } catch (e) { next(e); }
}

export async function logout(req: Request, res: Response, next: NextFunction) {
  try {
    await authService.logout(req.body.refreshToken);
    res.status(200).json({ success: true, data: { message: 'Logged out successfully' } });
  } catch (e) { next(e); }
}

export async function me(req: Request, res: Response, next: NextFunction) {
  try {
    const auth = req as AuthenticatedRequest;
    const user = await authService.getProfile(auth.user!.userId);
    res.status(200).json({ success: true, data: user });
  } catch (e) { next(e); }
}

export async function updateProfile(req: Request, res: Response, next: NextFunction) {
  try {
    const auth = req as AuthenticatedRequest;
    const user = await authService.updateProfile(auth.user!.userId, req.body);
    res.status(200).json({ success: true, data: user });
  } catch (e) { next(e); }
}

export async function googleAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await authService.googleAuth(req.body, readDeviceInfo(req));
    res.status(200).json({ success: true, data: result });
  } catch (e) { next(e); }
}

export async function appleAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await authService.appleAuth(req.body, readDeviceInfo(req));
    res.status(200).json({ success: true, data: result });
  } catch (e) { next(e); }
}

export async function sendVerification(req: Request, res: Response, next: NextFunction) {
  try {
    const auth = req as AuthenticatedRequest;
    await authService.sendVerification(auth.user!.userId);
    res.status(200).json({ success: true, data: { message: 'Verification code sent' } });
  } catch (e) { next(e); }
}

export async function verifyEmail(req: Request, res: Response, next: NextFunction) {
  try {
    const auth = req as AuthenticatedRequest;
    await authService.verifyEmail(auth.user!.userId, req.body);
    res.status(200).json({ success: true, data: { message: 'Email verified successfully' } });
  } catch (e) { next(e); }
}

export async function forgotPassword(req: Request, res: Response, next: NextFunction) {
  try {
    await authService.forgotPassword(req.body);
    res.status(200).json({ success: true, data: { message: 'If an account exists, a reset code has been sent' } });
  } catch (e) { next(e); }
}

export async function resetPassword(req: Request, res: Response, next: NextFunction) {
  try {
    await authService.resetPassword(req.body);
    res.status(200).json({ success: true, data: { message: 'Password reset successfully' } });
  } catch (e) { next(e); }
}

export async function checkResetCode(req: Request, res: Response, next: NextFunction) {
  try {
    await authService.checkResetCode(req.body);
    res.status(200).json({ success: true, data: { valid: true } });
  } catch (e) { next(e); }
}

export async function scheduleDeletion(req: Request, res: Response, next: NextFunction) {
  try {
    const auth = req as AuthenticatedRequest;
    await authService.scheduleDeletion(auth.user!.userId, req.body, auth.user!.iat);
    res.status(200).json({ success: true, data: { message: 'Account scheduled for deletion in 30 days' } });
  } catch (e) { next(e); }
}

export async function cancelDeletion(req: Request, res: Response, next: NextFunction) {
  try {
    const auth = req as AuthenticatedRequest;
    await authService.cancelDeletion(auth.user!.userId);
    res.status(200).json({ success: true, data: { message: 'Deletion cancelled' } });
  } catch (e) { next(e); }
}

export async function confirmDeletion(req: Request, res: Response, next: NextFunction) {
  try {
    const auth = req as AuthenticatedRequest;
    await authService.confirmDeletion(auth.user!.userId, req.body, auth.user!.iat);
    res.status(200).json({ success: true, data: { message: 'Account deleted' } });
  } catch (e) { next(e); }
}

export async function uploadAvatarCtrl(req: Request, res: Response, next: NextFunction) {
  try {
    const auth = req as AuthenticatedRequest;
    const file = req.file;
    if (!file) {
      res.status(400).json({ success: false, error: 'No file uploaded.' });
      return;
    }
    // Avatars are only ever shown small (32-46px circles) — resize down so
    // mobile clients don't download a full-resolution original for a tiny
    // thumbnail.
    const resized = await resizeImageBuffer(file.buffer, { width: 256 });
    const result = await uploadBuffer(resized, userUploadFolder('avatars', auth.user!.userId), 'image/jpeg', 'jpg');
    const user = await authService.updateProfile(auth.user!.userId, { avatarUrl: result.key });
    res.status(200).json({ success: true, data: { avatarUrl: user.avatarUrl, user } });
  } catch (e) { next(e); }
}

export async function cancelPendingRegistration(req: Request, res: Response, next: NextFunction) {
  try {
    const auth = req as AuthenticatedRequest;
    await authService.cancelPendingRegistration(auth.user!.userId);
    res.status(200).json({ success: true, data: { message: 'Pending registration cancelled' } });
  } catch (e) { next(e); }
}

export async function registerPhone(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await authService.registerPhone(req.body, readDeviceInfo(req));
    res.status(201).json({ success: true, data: result });
  } catch (e) { next(e); }
}

export async function sendPhoneOtp(req: Request, res: Response, next: NextFunction) {
  try {
    const auth = req as AuthenticatedRequest;
    const code = await authService.sendPhoneOtp(req.body, auth.user?.userId);
    res.status(200).json({ success: true, data: { message: 'OTP sent', code } });
  } catch (e) { next(e); }
}

export async function verifyPhoneOtp(req: Request, res: Response, next: NextFunction) {
  try {
    const auth = req as AuthenticatedRequest;
    const result = await authService.verifyPhoneOtp(req.body, auth.user?.userId, readDeviceInfo(req));
    res.status(200).json({ success: true, data: result });
  } catch (e) { next(e); }
}
