import { Request, Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../shared/middleware/auth';
import * as calendarService from './service';

function getUserId(req: Request): string {
  return (req as AuthenticatedRequest).user!.userId;
}

export async function create(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await calendarService.createEvent(getUserId(req), req.body);
    res.status(201).json({ success: true, data: result });
  } catch (e) {
    next(e);
  }
}

export async function list(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await calendarService.listEvents(getUserId(req), req.query as any);
    res.status(200).json({ success: true, data: result });
  } catch (e) {
    next(e);
  }
}

export async function getById(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await calendarService.getEventById(req.params.id, getUserId(req));
    res.status(200).json({ success: true, data: result });
  } catch (e) {
    next(e);
  }
}

export async function update(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await calendarService.updateEvent(
      req.params.id,
      getUserId(req),
      req.body,
    );
    res.status(200).json({ success: true, data: result });
  } catch (e) {
    next(e);
  }
}

export async function remove(req: Request, res: Response, next: NextFunction) {
  try {
    await calendarService.deleteEvent(req.params.id, getUserId(req));
    res.status(200).json({ success: true, data: null });
  } catch (e) {
    next(e);
  }
}

export async function exportIcs(req: Request, res: Response, next: NextFunction) {
  try {
    const ics = await calendarService.exportHouseholdIcs(getUserId(req));
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="rootaroo-calendar.ics"');
    res.status(200).send(ics);
  } catch (e) {
    next(e);
  }
}

export async function googleStatus(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await calendarService.getGoogleSyncStatus(getUserId(req));
    res.status(200).json({ success: true, data: result });
  } catch (e) { next(e); }
}

export async function googleConnect(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await calendarService.connectGoogleCalendar(getUserId(req), req.body);
    res.status(200).json({ success: true, data: result });
  } catch (e) { next(e); }
}

export async function googleDisconnect(req: Request, res: Response, next: NextFunction) {
  try {
    await calendarService.disconnectGoogleCalendar(getUserId(req));
    res.status(200).json({ success: true, data: { message: 'Google Calendar disconnected' } });
  } catch (e) { next(e); }
}

export async function outlookStatus(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await calendarService.getOutlookSyncStatus(getUserId(req));
    res.status(200).json({ success: true, data: result });
  } catch (e) { next(e); }
}

export async function outlookConnect(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await calendarService.connectOutlookCalendar(getUserId(req));
    res.status(200).json({ success: true, data: result });
  } catch (e) { next(e); }
}

export async function outlookDisconnect(req: Request, res: Response, next: NextFunction) {
  try {
    await calendarService.disconnectOutlookCalendar(getUserId(req));
    res.status(200).json({ success: true, data: { message: 'Outlook Calendar disconnected' } });
  } catch (e) { next(e); }
}

/** Public, unauthenticated `.ics` feed Outlook subscribes to (webcal). */
export async function outlookFeed(req: Request, res: Response, next: NextFunction) {
  try {
    const ics = await calendarService.getOutlookFeedIcs(req.params.token);
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.send(ics);
  } catch (e) { next(e); }
}

export async function appleStatus(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await calendarService.getAppleSyncStatus(getUserId(req));
    res.status(200).json({ success: true, data: result });
  } catch (e) { next(e); }
}

export async function appleConnect(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await calendarService.connectAppleCalendar(getUserId(req), req.body);
    res.status(200).json({ success: true, data: result });
  } catch (e) { next(e); }
}

export async function appleDisconnect(req: Request, res: Response, next: NextFunction) {
  try {
    await calendarService.disconnectAppleCalendar(getUserId(req));
    res.status(200).json({ success: true, data: { message: 'Apple Calendar disconnected' } });
  } catch (e) { next(e); }
}
