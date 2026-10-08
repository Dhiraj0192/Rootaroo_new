import request from 'supertest';
import app from '../../../app';
import { setupAssociations } from '../../../database/models';
import { resetDb, closeIntResources } from '../../../test/int/db';

const ADMIN_KEY = process.env.ADMIN_API_KEY!;

beforeAll(() => setupAssociations());
beforeEach(() => resetDb());
afterAll(() => closeIntResources());

const admin = () => ({ 'x-admin-api-key': ADMIN_KEY });

describe('campaign admin controls (real database)', () => {
  it('lists every switch (all off) with the copy for review', async () => {
    const res = await request(app).get('/api/v1/admin/campaigns').set(admin());
    expect(res.status).toBe(200);
    expect(res.body.data.all).toBe(false);
    expect(res.body.data.signedOutNudges).toBe(false);
    expect(res.body.data.rules.inactive_3d).toBe(false);
    expect(res.body.data.copy.inactive_3d.length).toBeGreaterThan(0);
  });

  it('switches a rule and the master on and off', async () => {
    expect((await request(app).put('/api/v1/admin/campaigns/all').set(admin()).send({ enabled: true })).status).toBe(200);
    expect((await request(app).put('/api/v1/admin/campaigns/inactive_3d').set(admin()).send({ enabled: true })).status).toBe(200);
    let res = await request(app).get('/api/v1/admin/campaigns').set(admin());
    expect(res.body.data.all).toBe(true);
    expect(res.body.data.rules.inactive_3d).toBe(true);
    expect(res.body.data.updated.inactive_3d.updatedBy).toBeTruthy();

    await request(app).put('/api/v1/admin/campaigns/all').set(admin()).send({ enabled: false });
    res = await request(app).get('/api/v1/admin/campaigns').set(admin());
    expect(res.body.data.all).toBe(false);
  });

  it('rejects unknown campaigns and bad bodies', async () => {
    expect((await request(app).put('/api/v1/admin/campaigns/surprise_blast').set(admin()).send({ enabled: true })).status).toBe(400);
    expect((await request(app).put('/api/v1/admin/campaigns/all').set(admin()).send({ enabled: 'yes' })).status).toBe(400);
  });

  it('needs the admin key', async () => {
    expect((await request(app).get('/api/v1/admin/campaigns')).status).toBe(401);
    expect((await request(app).put('/api/v1/admin/campaigns/all').send({ enabled: true })).status).toBe(401);
  });

  it('the app can ask, without signing in, whether signed-out nudges are allowed', async () => {
    let res = await request(app).get('/api/v1/campaigns/signed-out');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ enabled: false });
    await request(app).put('/api/v1/admin/campaigns/signed_out_nudges').set(admin()).send({ enabled: true });
    res = await request(app).get('/api/v1/campaigns/signed-out');
    expect(res.body.data).toEqual({ enabled: true });
  });
});
