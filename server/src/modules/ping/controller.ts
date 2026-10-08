import { Request, Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../shared/middleware/auth';
import * as pingService from './service';

function getUserId(req: Request): string {
  return (req as AuthenticatedRequest).user!.userId;
}

export async function create(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await pingService.createPingRequest(getUserId(req), req.body);
    res.status(201).json({ success: true, data: result });
  } catch (e) { next(e); }
}

export async function respond(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await pingService.respondToPingRequest(getUserId(req), req.params.id, req.body);
    res.status(200).json({ success: true, data: result });
  } catch (e) { next(e); }
}

export async function list(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await pingService.listPingRequests(getUserId(req), req.query as any);
    res.status(200).json({ success: true, data: result });
  } catch (e) { next(e); }
}
