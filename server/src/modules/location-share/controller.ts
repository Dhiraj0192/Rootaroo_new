import { Request, Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../shared/middleware/auth';
import * as shareService from './service';

function getUserId(req: Request): string {
  return (req as AuthenticatedRequest).user!.userId;
}

export async function start(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await shareService.startShare(getUserId(req), req.body);
    res.status(201).json({ success: true, data: result });
  } catch (e) { next(e); }
}

export async function list(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await shareService.listShares(getUserId(req));
    res.status(200).json({ success: true, data: result });
  } catch (e) { next(e); }
}

export async function updateLocation(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await shareService.updateShareLocation(getUserId(req), req.params.id, req.body);
    res.status(200).json({ success: true, data: result });
  } catch (e) { next(e); }
}

export async function stop(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await shareService.stopShare(getUserId(req), req.params.id);
    res.status(200).json({ success: true, data: result });
  } catch (e) { next(e); }
}
