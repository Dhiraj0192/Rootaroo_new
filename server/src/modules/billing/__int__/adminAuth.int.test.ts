import request from 'supertest';
import app from '../../../app';
import { setupAssociations, AdminAuditLog } from '../../../database/models';
import { resetDb, closeIntResources } from '../../../test/int/db';
import { installStripeMock } from '../../../test/billing/stripeMock';
import { testBillingConfig } from '../../../test/billing/config';
import { __resetAllowlistForTests } from '../admin/auth';

const BILLING_KEY = process.env.ADMIN_BILLING_API_KEY!;
const ADMIN_KEY = process.env.ADMIN_API_KEY!;

beforeAll(() => setupAssociations());
beforeEach(async () => { await resetDb(); installStripeMock('test', testBillingConfig({ adminKey: BILLING_KEY })); __resetAllowlistForTests(); });
afterAll(() => closeIntResources());

const settle = () => new Promise((r) => setTimeout(r, 150)); // audit rows are written on response finish

describe('billing-admin auth (B8, spec 11)', () => {
  it('accepts the billing key', async () => {
    const res = await request(app).get('/api/v1/billing-admin/ping').set('x-admin-billing-key', BILLING_KEY);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { ok: true } });
  });

  it('each key returns 401 on the other surface', async () => {
    expect((await request(app).get('/api/v1/billing-admin/ping').set('x-admin-api-key', ADMIN_KEY)).status).toBe(401);
    expect((await request(app).get('/api/v1/billing-admin/ping').set('x-admin-billing-key', ADMIN_KEY)).status).toBe(401);
    expect((await request(app).get('/api/v1/admin/requests').set('x-admin-api-key', BILLING_KEY)).status).toBe(401);
    expect((await request(app).get('/api/v1/admin/requests').set('x-admin-billing-key', BILLING_KEY)).status).toBe(401);
  });

  it('audits every request, including rejected ones, on both surfaces', async () => {
    await request(app).get('/api/v1/billing-admin/ping?x=1').set('x-admin-billing-key', BILLING_KEY);
    await request(app).get('/api/v1/billing-admin/ping').set('x-admin-billing-key', 'wrong');
    await request(app).get('/api/v1/admin/requests').set('x-admin-api-key', ADMIN_KEY);
    await settle();
    const rows = await AdminAuditLog.findAll();
    expect(rows.map((r) => [r.surface, r.statusCode, r.keyLabel])).toEqual(expect.arrayContaining([
      ['billing-admin', 200, 'billing-key'], ['billing-admin', 401, 'none'], ['admin', 200, 'admin-key'],
    ]));
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.statusCode === 200 && r.surface === 'billing-admin'))
      .toMatchObject({ method: 'GET', path: '/api/v1/billing-admin/ping', query: { x: '1' } });
    expect(JSON.stringify(rows)).not.toContain(BILLING_KEY);
  });

  it('enforces the IP allowlist', async () => {
    installStripeMock('test', testBillingConfig({ adminKey: BILLING_KEY, adminIpAllowlist: ['203.0.113.0/24'] }));
    __resetAllowlistForTests();
    expect((await request(app).get('/api/v1/billing-admin/ping').set('x-admin-billing-key', BILLING_KEY)).status).toBe(403);
  });

  it('401 for everyone when no billing key is configured', async () => {
    installStripeMock('test', testBillingConfig({ adminKey: '' }));
    expect((await request(app).get('/api/v1/billing-admin/ping').set('x-admin-billing-key', '')).status).toBe(401);
  });
});
