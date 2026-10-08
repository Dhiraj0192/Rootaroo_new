import { Request, Response, NextFunction } from 'express';
import { env } from '../../config/env';
import { UnauthorizedError } from '../utils/errors';

/**
 * Guards the admin-only household action request review API. Deliberately
 * a separate header/secret from the per-user JWT (`Authorization`) — these
 * endpoints are reviewed by Rootaroo staff, not authenticated as any
 * household member, so a stolen user token must never satisfy this check.
 */
export function requireAdminApiKey(req: Request, res: Response, next: NextFunction): void {
  const provided = req.headers['x-admin-api-key'];

  if (!env.adminApiKey || !provided || provided !== env.adminApiKey) {
    throw new UnauthorizedError('Invalid or missing admin API key');
  }

  res.locals.auditKeyLabel = 'admin-key';
  next();
}
