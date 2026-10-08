import { Request, Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../shared/middleware/auth';
import * as journalService from './service';
import { uploadBuffer, getSignedUrl } from '../../shared/utils/s3';
import { userUploadFolder } from '../../shared/utils/uploadKeys';
import { resizeImageBuffer } from '../../shared/utils/image';

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
    // Rejected here as well as in the entry schema: without this a video would
    // be uploaded to S3 first and only refused at save time, leaving an orphan
    // object nothing ever references.
    if (files.some((f) => !f.mimetype.startsWith('image/'))) {
      res.status(400).json({ success: false, error: 'Journal entries accept photos only' });
      return;
    }
    const results = await Promise.all(
      files.map(async (f) => {
        const result = await uploadBuffer(
          f.buffer,
          userUploadFolder('journal/images', getUserId(req)),
          f.mimetype,
          f.originalname.split('.').pop(),
        );

        // Compressed thumbnail so the entry list/media grid doesn't download
        // the full-resolution original for a small tile.
        const thumbBuffer = await resizeImageBuffer(f.buffer, { width: 480 });
        const thumbResult = await uploadBuffer(thumbBuffer, userUploadFolder('journal/thumbnails', getUserId(req)), 'image/jpeg', 'jpg');

        // `fileName`/`thumbnailFileName` are S3 keys — persist as
        // `mediaUrl`/`thumbnailUrl` when creating the entry. `url`/
        // `thumbnailUrl` here are signed URLs for immediate preview only;
        // they expire and must never be stored.
        return {
          fileName: result.key,
          url: await getSignedUrl(result.key),
          thumbnailFileName: thumbResult.key,
          thumbnailUrl: await getSignedUrl(thumbResult.key),
          size: f.size,
          mimetype: f.mimetype,
        };
      }),
    );
    res.status(201).json({ success: true, data: results });
  } catch (e) { next(e); }
}
