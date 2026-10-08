import { Request, Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../shared/middleware/auth';
import * as deviceService from './service';

export async function list(req: Request, res: Response, next: NextFunction) {
  try {
    const { user } = req as AuthenticatedRequest;
    const devices = await deviceService.listDevices(user!.userId, user!.deviceId ?? null);
    res.status(200).json({ success: true, data: devices });
  } catch (e) { next(e); }
}

export async function remove(req: Request, res: Response, next: NextFunction) {
  try {
    await deviceService.revokeDevice((req as AuthenticatedRequest).user!.userId, req.params.id);
    res.status(200).json({ success: true, data: { message: 'Device removed' } });
  } catch (e) { next(e); }
}
