import { Request, Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../shared/middleware/auth';
import * as notificationService from './service';

function getUserId(req: Request): string {
  return (req as AuthenticatedRequest).user!.userId;
}

export async function registerToken(req: Request, res: Response, next: NextFunction) {
  try {
    await notificationService.registerToken(getUserId(req), req.body, (req as AuthenticatedRequest).user!.deviceId);
    res.status(201).json({ success: true, data: { message: 'Token registered' } });
  } catch (e) { next(e); }
}

export async function unregisterToken(req: Request, res: Response, next: NextFunction) {
  try {
    await notificationService.unregisterToken(getUserId(req), req.params.token);
    res.status(200).json({ success: true, data: { message: 'Token removed' } });
  } catch (e) { next(e); }
}

export async function getHistory(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await notificationService.getHistory(
      getUserId(req),
      { limit: Number(req.query.limit) || 20, cursor: req.query.cursor as string },
    );
    res.status(200).json({ success: true, data: result });
  } catch (e) { next(e); }
}

export async function markAsRead(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await notificationService.markAsRead(req.params.id, getUserId(req));
    res.status(200).json({ success: true, data: result });
  } catch (e) { next(e); }
}

export async function markAllAsRead(_req: Request, res: Response, next: NextFunction) {
  try {
    await notificationService.markAllAsRead((_req as AuthenticatedRequest).user!.userId);
    res.status(200).json({ success: true, data: { message: 'All marked as read' } });
  } catch (e) { next(e); }
}

export async function getUnreadCount(req: Request, res: Response, next: NextFunction) {
  try {
    const count = await notificationService.getUnreadCount(getUserId(req));
    res.status(200).json({ success: true, data: { count } });
  } catch (e) { next(e); }
}

export async function getPreferences(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await notificationService.getPreferences(getUserId(req));
    res.status(200).json({ success: true, data: result });
  } catch (e) { next(e); }
}

export async function updatePreferences(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await notificationService.updatePreferences(getUserId(req), req.body);
    res.status(200).json({ success: true, data: result });
  } catch (e) { next(e); }
}
