jest.mock('../config', () => ({ getBillingConfig: jest.fn() }));
jest.mock('../../../database/models', () => ({ AdminAuditLog: { create: jest.fn() } }));

import crypto from 'crypto';
import { EventEmitter } from 'events';
import { getBillingConfig } from '../config';
import { AdminAuditLog } from '../../../database/models';
import { safeEqual, buildIpAllowlist, ipAllowed, requireBillingAdminKey, auditLog, __resetAllowlistForTests } from '../admin/auth';

const cfg = (adminKey: string, adminIpAllowlist: string[] = []) => (getBillingConfig as jest.Mock).mockReturnValue({ adminKey, adminIpAllowlist });
const KEY = 'k'.repeat(40);
const reqWith = (headers: Record<string, string>, ip = '127.0.0.1') => ({ header: (n: string) => headers[n], ip }) as any;

describe('billing-admin auth helpers', () => {
  it('compares keys in constant time regardless of length', () => {
    expect(safeEqual('a'.repeat(40), 'a'.repeat(40))).toBe(true);
    expect(safeEqual('a'.repeat(40), 'b'.repeat(40))).toBe(false);
    expect(safeEqual('short', 'a'.repeat(40))).toBe(false);
  });

  it('matches IPv4 CIDRs, single addresses, IPv4-mapped IPv6 and IPv6', () => {
    const list = buildIpAllowlist(['10.0.0.0/8', '203.0.113.7', '2001:db8::/32']);
    expect(ipAllowed(list, '10.1.2.3')).toBe(true);
    expect(ipAllowed(list, '::ffff:10.1.2.3')).toBe(true);
    expect(ipAllowed(list, '203.0.113.7')).toBe(true);
    expect(ipAllowed(list, '203.0.113.8')).toBe(false);
    expect(ipAllowed(list, '2001:db8::1')).toBe(true);
    expect(ipAllowed(list, 'garbage')).toBe(false);
    expect(ipAllowed(null, '1.2.3.4')).toBe(true);
    expect(buildIpAllowlist([])).toBeNull();
  });
});

describe('requireBillingAdminKey', () => {
  beforeEach(() => { __resetAllowlistForTests(); });

  it('accepts the right key and labels the audit row', () => {
    cfg(KEY);
    const res = { locals: {} } as any;
    const next = jest.fn();
    requireBillingAdminKey(reqWith({ 'x-admin-billing-key': KEY }), res, next);
    expect(next).toHaveBeenCalled();
    expect(res.locals.auditKeyLabel).toBe('billing-key');
  });

  it.each([['wrong', KEY], ['', KEY], ['anything', '']])('401 for provided=%p configured=%p', (provided, configured) => {
    cfg(configured);
    expect(() => requireBillingAdminKey(reqWith(provided ? { 'x-admin-billing-key': provided } : {}), { locals: {} } as any, jest.fn())).toThrow(/billing admin key/);
  });

  it('403 outside the allowlist, and re-reads the allowlist when config changes', () => {
    cfg(KEY, ['203.0.113.0/24']);
    const req = reqWith({ 'x-admin-billing-key': KEY }, '198.51.100.9');
    expect(() => requireBillingAdminKey(req, { locals: {} } as any, jest.fn())).toThrow(/not allowed/);
    cfg(KEY, ['198.51.100.0/24']);
    const next = jest.fn();
    requireBillingAdminKey(req, { locals: {} } as any, next);
    expect(next).toHaveBeenCalled();
  });
});

describe('auditLog', () => {
  beforeEach(() => { (AdminAuditLog.create as jest.Mock).mockReset().mockResolvedValue({}); });

  function run(req: any, locals: Record<string, unknown> = {}, status = 200) {
    const res = Object.assign(new EventEmitter(), { statusCode: status, locals }) as any;
    const next = jest.fn();
    auditLog('billing-admin')(req, res, next);
    res.emit('finish');
    expect(next).toHaveBeenCalled();
  }

  it('writes a digest of the body, never the body, and a key label of none when unauthenticated', () => {
    const body = { note: 'top secret reason', pw: 'hunter2' };
    run({ method: 'POST', originalUrl: '/api/v1/billing-admin/x?a=1', query: { a: '1' }, body, ip: '1.2.3.4' }, {}, 401);
    const row = (AdminAuditLog.create as jest.Mock).mock.calls[0][0];
    expect(row).toMatchObject({ surface: 'billing-admin', keyLabel: 'none', method: 'POST', path: '/api/v1/billing-admin/x', statusCode: 401, ip: '1.2.3.4' });
    expect(row.bodyDigest).toBe(crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex'));
    expect(JSON.stringify(row)).not.toContain('hunter2');
  });

  it('records the handler note under _note and null digest for empty bodies', () => {
    run({ method: 'GET', originalUrl: '/p', query: {}, body: {} }, { auditKeyLabel: 'billing-key', auditNote: { reason: 'x' } });
    const row = (AdminAuditLog.create as jest.Mock).mock.calls[0][0];
    expect(row).toMatchObject({ keyLabel: 'billing-key', bodyDigest: null, query: { _note: { reason: 'x' } }, ip: null });
  });

  it('redacts the email filter (PII) before storing the query', () => {
    run({ method: 'GET', originalUrl: '/p?email=Jane%40Example.com&limit=5', query: { email: 'Jane@Example.com', limit: '5' }, body: {} });
    const row = (AdminAuditLog.create as jest.Mock).mock.calls[0][0];
    const digest = crypto.createHash('sha256').update('jane@example.com').digest('hex').slice(0, 16);
    expect(row.query).toEqual({ email: `sha256:${digest}`, limit: '5' });
    expect(JSON.stringify(row)).not.toMatch(/jane/i);
  });

  it('never throws into the response when the write fails', async () => {
    (AdminAuditLog.create as jest.Mock).mockRejectedValue(new Error('db down'));
    expect(() => run({ method: 'GET', originalUrl: '/p', query: {} })).not.toThrow();
    await new Promise((r) => setImmediate(r));
  });
});
