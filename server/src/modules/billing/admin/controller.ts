import { Request, Response, NextFunction } from 'express';
import * as service from './service';
import { runReconciliationLocked } from '../alerts';

export async function ping(_req: Request, res: Response, next: NextFunction) {
  try { res.status(200).json({ success: true, data: service.ping() }); } catch (e) { next(e); }
}

export async function transactions(req: Request, res: Response, next: NextFunction) {
  try {
    const out = await service.listTransactions(req.query as unknown as service.TxFilters);
    res.status(200).json({ success: true, data: out.data, nextCursor: out.nextCursor });
  } catch (e) { next(e); }
}

export async function transaction(req: Request, res: Response, next: NextFunction) {
  try { res.status(200).json({ success: true, data: await service.getTransaction(req.params.id) }); } catch (e) { next(e); }
}

export async function transactionsCsv(req: Request, res: Response, next: NextFunction) {
  try {
    service.decodeCursor((req.query as { cursor?: string }).cursor); // reject a bad cursor with 400 before any byte is streamed
    res.status(200).setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="rootaroo-transactions-${new Date().toISOString().slice(0, 10)}.csv"`);
    await service.writeTransactionsCsv(req.query as unknown as service.TxFilters, (chunk) => res.write(chunk));
    res.end();
  } catch (e) {
    // Once streaming has started the headers are gone; abort the stream (so the client sees a truncated download, not a valid CSV) rather than corrupting it with an error body.
    if (res.headersSent) { res.destroy(); return; }
    next(e);
  }
}

export async function summary(req: Request, res: Response, next: NextFunction) {
  try {
    const q = req.query as unknown as { mode: 'test' | 'live'; from: Date; to: Date };
    res.status(200).json({ success: true, data: await service.getSummary(q.mode, q.from, q.to) });
  } catch (e) { next(e); }
}

export async function subscriptions(req: Request, res: Response, next: NextFunction) {
  try {
    const q = req.query as unknown as { mode: 'test' | 'live'; status?: string; cursor?: string; limit: number };
    const out = await service.listSubscriptions(q.mode, q.status, q.cursor, q.limit);
    res.status(200).json({ success: true, data: out.data, nextCursor: out.nextCursor });
  } catch (e) { next(e); }
}

export async function household(req: Request, res: Response, next: NextFunction) {
  try { res.status(200).json({ success: true, data: await service.getHouseholdBilling(req.params.id) }); } catch (e) { next(e); }
}

export async function runs(req: Request, res: Response, next: NextFunction) {
  try {
    const q = req.query as unknown as { mode: 'test' | 'live'; cursor?: string; limit: number };
    const out = await service.listRuns(q.mode, q.cursor, q.limit);
    res.status(200).json({ success: true, data: out.data, nextCursor: out.nextCursor });
  } catch (e) { next(e); }
}

export async function items(req: Request, res: Response, next: NextFunction) {
  try {
    const q = req.query as unknown as { mode: 'test' | 'live'; status?: string; cursor?: string; limit: number };
    const out = await service.listItems(q.mode, q.status, q.cursor, q.limit);
    res.status(200).json({ success: true, data: out.data, nextCursor: out.nextCursor });
  } catch (e) { next(e); }
}

export async function runNow(req: Request, res: Response, next: NextFunction) {
  try {
    res.locals.auditNote = { mode: req.body.mode };
    res.status(200).json({ success: true, data: await runReconciliationLocked(req.body.mode, 'manual') });
  } catch (e) { next(e); }
}

export async function resolve(req: Request, res: Response, next: NextFunction) {
  try {
    res.locals.auditNote = { resolution: req.body.resolution, note: req.body.note };
    res.status(200).json({ success: true, data: await service.resolveItem(req.params.id, req.body.resolution, req.body.note) });
  } catch (e) { next(e); }
}

export async function replay(req: Request, res: Response, next: NextFunction) {
  try {
    res.locals.auditNote = { event: req.params.id };
    res.status(200).json({ success: true, data: await service.replayEvent(req.params.id) });
  } catch (e) { next(e); }
}

export async function cohort(req: Request, res: Response, next: NextFunction) {
  try {
    const out = await service.changeCohort(req.params.id, req.body);
    res.locals.auditNote = { from: out.from, to: out.to, reason: req.body.reason, force: req.body.force };
    res.status(200).json({ success: true, data: out });
  } catch (e) {
    res.locals.auditNote = { to: req.body?.cohort, reason: req.body?.reason, force: req.body?.force, refused: true };
    next(e);
  }
}

export async function routing(_req: Request, res: Response, next: NextFunction) {
  try { res.status(200).json({ success: true, data: await service.getRouting() }); } catch (e) { next(e); }
}

export async function putRouting(req: Request, res: Response, next: NextFunction) {
  try {
    res.locals.auditNote = { rules: req.body.rules.length };
    res.status(200).json({ success: true, data: await service.putRouting(req.body.rules) });
  } catch (e) { next(e); }
}
