import { Request, Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../shared/middleware/auth';
import * as journalService from './service';
import { uploadBuffer } from '../../shared/utils/s3';
import { userUploadFolder } from '../../shared/utils/uploadKeys';

function getUserId(req: Request): string {
  return (req as AuthenticatedRequest).user!.userId;
}

/** The caller's IANA zone, so day boundaries match the phone's calendar. */
function getClientTimeZone(req: Request): string | undefined {
  const header = req.headers['x-timezone'];
  return typeof header === 'string' ? header : undefined;
}

export async function create(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await journalService.createEntry(getUserId(req), req.body);
    res.status(201).json({ success: true, data: result });
  } catch (e) { next(e); }
}

export async function list(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await journalService.listEntries(getUserId(req), req.query as any);
    res.status(200).json({ success: true, data: result });
  } catch (e) { next(e); }
}

export async function getById(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await journalService.getEntryById(getUserId(req), req.params.id);
    res.status(200).json({ success: true, data: result });
  } catch (e) { next(e); }
}

export async function update(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await journalService.updateEntry(getUserId(req), req.params.id, req.body);
    res.status(200).json({ success: true, data: result });
  } catch (e) { next(e); }
}

export async function remove(req: Request, res: Response, next: NextFunction) {
  try {
    await journalService.deleteEntry(getUserId(req), req.params.id);
    res.status(200).json({ success: true, data: { message: 'Journal entry deleted successfully' } });
  } catch (e) { next(e); }
}

export async function stats(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await journalService.getStats(getUserId(req), getClientTimeZone(req));
    res.status(200).json({ success: true, data: result });
  } catch (e) { next(e); }
}

export async function history(req: Request, res: Response, next: NextFunction) {
  try {
    const month = req.query.month as string | undefined;
    const result = await journalService.getHistory(getUserId(req), month, getClientTimeZone(req));
    res.status(200).json({ success: true, data: result });
  } catch (e) { next(e); }
}

export async function onThisDay(req: Request, res: Response, next: NextFunction) {
  try {
    const date = req.query.date as string | undefined;
    const result = await journalService.getOnThisDay(getUserId(req), date, getClientTimeZone(req));
    res.status(200).json({ success: true, data: result });
  } catch (e) { next(e); }
}

export async function uploadMedia(req: Request, res: Response, next: NextFunction) {
  try {
    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) {
      res.status(400).json({ success: false, error: 'No files provided' });
      return;
    }
    // The phone has already encrypted the photo and its thumbnail, so these are
    // opaque bytes: stored as they came, never decoded, resized or inspected.
    // `fileName` is the S3 key; send it back as `blobKey` / `thumbnailKey` when saving the entry.
    const results = await Promise.all(
      files.map(async (f) => {
        const { key } = await uploadBuffer(
          f.buffer,
          userUploadFolder('journal/blobs', getUserId(req)),
          'application/octet-stream',
        );
        return { fileName: key, size: f.size };
      }),
    );
    res.status(201).json({ success: true, data: results });
  } catch (e) { next(e); }
}
