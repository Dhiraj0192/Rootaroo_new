import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env';
import redis from '../../config/redis';
import logger from '../utils/logger';
import { UnauthorizedError } from '../utils/errors';

/** Same key the device module sets on removal. */
export async function isDeviceRevoked(deviceId: string): Promise<boolean> {
  try {
    return (await redis.exists(`device:revoked:${deviceId}`)) === 1;
  } catch (err) {
    // Redis being down must not let a signed-out phone back in: ask the database, which revoke writes first.
    // Nothing is cached, and if the database fails too the error propagates (the request fails closed).
    logger.warn(`Revoked-device check failed, falling back to the database: ${(err as Error).message}`);
    const { Device } = await import('../../database/models');
    const device = await Device.findOne({ where: { id: deviceId }, attributes: ['id', 'revokedAt'] });
    return !device || device.revokedAt != null;
  }
}

export interface JwtPayload {
  userId: string;
  email: string;
  role: string;
  /** Which registered device this session belongs to. */
  deviceId?: string;
  /** Standard JWT issued-at claim (seconds since epoch) — jwt.sign sets it
   *  automatically; surfaced here so step-up checks (e.g. destructive
   *  account actions for password-less accounts) can require a recently
   *  issued token instead of a possibly long-lived one. */
  iat?: number;
}

export interface AuthenticatedRequest extends Request {
  user?: JwtPayload;
}

export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new UnauthorizedError('Missing or invalid authorization header');
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, env.jwt.accessSecret) as JwtPayload;
    (req as AuthenticatedRequest).user = decoded;
    if (!decoded.deviceId) {
      next();
      return;
    }
    // Express 4 ignores returned promises, so route failures to next explicitly.
    void isDeviceRevoked(decoded.deviceId).then(
      (revoked) => next(revoked ? new UnauthorizedError('This device was signed out', 'DEVICE_REVOKED') : undefined),
      next,
    );
  } catch (error) {
    throw new UnauthorizedError('Invalid or expired token');
  }
}
