import crypto from 'crypto';
import { BlockList, isIP } from 'net';
import { Request, Response, NextFunction, RequestHandler } from 'express';
import { AdminAuditLog } from '../../../database/models';
import { ForbiddenError, UnauthorizedError } from '../../../shared/utils/errors';
import logger from '../../../shared/utils/logger';
import { getBillingConfig } from '../config';

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest();

/** Constant-time comparison; hashing first makes the comparison length-independent. */
export function safeEqual(a: string, b: string): boolean {
  return crypto.timingSafeEqual(sha256(a), sha256(b));
}

export function buildIpAllowlist(cidrs: string[]): BlockList | null {
  if (cidrs.length === 0) return null;
  const list = new BlockList();
  for (const entry of cidrs) {
    const [addr, prefix] = entry.split('/');
    const type = isIP(addr) === 6 ? 'ipv6' : 'ipv4';
    if (prefix) list.addSubnet(addr, Number(prefix), type);
    else list.addAddress(addr, type);
  }
  return list;
}

export function ipAllowed(list: BlockList | null, ip: string): boolean {
  if (!list) return true;
  const clean = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  const family = isIP(clean);
  if (family === 0) return false;
  return list.check(clean, family === 6 ? 'ipv6' : 'ipv4');
}

let allowlist: { source: string; list: BlockList | null } | null = null;
export function __resetAllowlistForTests(): void { allowlist = null; }

function currentAllowlist(): BlockList | null {
  const cidrs = getBillingConfig().adminIpAllowlist;
  const source = cidrs.join(',');
  if (!allowlist || allowlist.source !== source) allowlist = { source, list: buildIpAllowlist(cidrs) };
  return allowlist.list;
}

/** Separate header and secret from /admin's x-admin-api-key (§11). */
export function requireBillingAdminKey(req: Request, res: Response, next: NextFunction): void {
  const { adminKey } = getBillingConfig();
  const provided = req.header('x-admin-billing-key');
  if (!adminKey || !provided || !safeEqual(provided, adminKey)) throw new UnauthorizedError('Invalid or missing billing admin key');
  if (!ipAllowed(currentAllowlist(), req.ip ?? '')) throw new ForbiddenError('This IP is not allowed to use the billing admin API');
  res.locals.auditKeyLabel = 'billing-key';
  next();
}

const PII_QUERY_KEYS = new Set(['email']);

/** Replaces PII query values (the `email` filter) with a short sha256 digest so audit rows can be correlated but never reveal the address. */
export function redactQuery(query: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query ?? {})) {
    if (PII_QUERY_KEYS.has(key.toLowerCase())) {
      const digest = (v: unknown) => `sha256:${crypto.createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex').slice(0, 16)}`;
      out[key] = Array.isArray(value) ? value.map(digest) : digest(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Logs every request on `finish` (rejected ones included): method, path, query, a body digest (never the body) and status. */
export function auditLog(surface: 'admin' | 'billing-admin'): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const body = req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0 ? JSON.stringify(req.body) : null;
    res.on('finish', () => {
      const note = res.locals.auditNote as Record<string, unknown> | undefined;
      AdminAuditLog.create({
        surface,
        keyLabel: (res.locals.auditKeyLabel as string | undefined) ?? 'none',
        method: req.method,
        path: req.originalUrl.split('?')[0].slice(0, 500),
        query: { ...redactQuery(req.query as Record<string, unknown>), ...(note ? { _note: note } : {}) },
        bodyDigest: body ? crypto.createHash('sha256').update(body).digest('hex') : null,
        statusCode: res.statusCode,
        ip: req.ip ?? null,
      }).catch((err: Error) => logger.error('[Audit] failed to write admin_audit_log:', err));
    });
    next();
  };
}
