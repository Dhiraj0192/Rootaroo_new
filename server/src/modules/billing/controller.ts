import { Request, Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../shared/middleware/auth';
import { loadCallerContext } from './context';
import { getPlansForMode } from './plans';
import { createCheckout, getBillingStatus, syncCheckout } from './checkout';
import { openPortal } from './portal';
import { changePlan } from './plan';
import { parseClientContext } from './routing';
import { verifyAppleTransaction } from './iap/appleVerify';
import { verifyGooglePurchase } from './iap/googleVerify';

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

export async function sync(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json({ success: true, data: await syncCheckout(getUserId(req), req.params.sessionId) });
  } catch (e) { next(e); }
}

export async function status(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json({ success: true, data: await getBillingStatus(getUserId(req), parseClientContext(req)) });
  } catch (e) { next(e); }
}

export async function portal(req: Request, res: Response, next: NextFunction) {
  try { res.status(200).json({ success: true, data: await openPortal(getUserId(req)) }); } catch (e) { next(e); }
}

export async function plan(req: Request, res: Response, next: NextFunction) {
  try { res.status(200).json({ success: true, data: await changePlan(getUserId(req), req.body) }); } catch (e) { next(e); }
}

export async function appleVerify(req: Request, res: Response, next: NextFunction) {
  try { res.status(200).json({ success: true, data: await verifyAppleTransaction(getUserId(req), req.body.signedTransaction) }); } catch (e) { next(e); }
}

export async function googleVerify(req: Request, res: Response, next: NextFunction) {
  try { res.status(200).json({ success: true, data: await verifyGooglePurchase(getUserId(req), req.body) }); } catch (e) { next(e); }
}
