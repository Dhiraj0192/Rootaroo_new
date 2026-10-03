import { Request, Response, NextFunction } from 'express';
import * as service from './service';

export async function ping(_req: Request, res: Response, next: NextFunction) {
  try { res.status(200).json({ success: true, data: service.ping() }); } catch (e) { next(e); }
}
