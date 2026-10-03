import { Request, Response } from 'express';

const RESULTS = new Set(['success', 'cancel', 'portal']);
const SESSION_RE = /^cs_(test|live)_[A-Za-z0-9]+$/;

export function buildReturnTarget(result: string, sessionId: unknown): string | null {
  if (!RESULTS.has(result)) return null;
  if (sessionId === undefined) return `rootaroo://billing/${result}`;
  if (typeof sessionId !== 'string' || !SESSION_RE.test(sessionId)) return null;
  return `rootaroo://billing/${result}?session_id=${sessionId}`;
}

/** Static fallback: plain link, no script, so helmet's default CSP is satisfied. */
export function returnPageHtml(target: string | null): string {
  const link = target ? `<p><a href="${target}" style="font-size:20px">Return to Rootaroo</a></p>` : '<p>Return to Rootaroo to continue.</p>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rootaroo</title></head><body style="font-family:sans-serif;text-align:center;padding:48px 16px">${link}<p>You can close this page.</p></body></html>`;
}

/** Public, side-effect free, grants nothing (§8.2, B1). */
export function billingReturn(req: Request, res: Response): void {
  const target = buildReturnTarget(req.params.result, req.query.session_id);
  if (!target) {
    res.status(200).type('html').send(returnPageHtml(null));
    return;
  }
  res.status(302).location(target).type('html').send(returnPageHtml(target));
}
