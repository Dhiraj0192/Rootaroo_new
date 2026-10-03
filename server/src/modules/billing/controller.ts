import { Request, Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../shared/middleware/auth';
import { loadCallerContext } from './context';
import { getPlansForMode } from './plans';
import { createCheckout } from './checkout';
import { parseClientContext } from './routing';

export function getUserId(req: Request): string {
  return (req as AuthenticatedRequest).user!.userId;
}

export async function plans(req: Request, res: Response, next: NextFunction) {
  try {
    const ctx = await loadCallerContext(getUserId(req));
    res.status(200).json({ success: true, data: await getPlansForMode(ctx.mode) });
  } catch (e) { next(e); }
}

export async function checkout(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json({ success: true, data: await createCheckout(getUserId(req), req.body, parseClientContext(req)) });
  } catch (e) { next(e); }
}
