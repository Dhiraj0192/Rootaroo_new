import request from 'supertest';
import app from '../../../app';
import { setupAssociations, LocationShare } from '../../../database/models';
import { resetDb, closeIntResources } from '../../../test/int/db';
import { createHouseholdWithAdmin, addMember, authHeaderFor } from '../../../test/factories';
import { endExpiredShares } from '../service';

beforeAll(() => setupAssociations());
beforeEach(() => resetDb());
afterAll(() => closeIntResources());

async function family() {
  const { household, admin } = await createHouseholdWithAdmin({ cohort: 'test' });
  const ravi = await addMember(household.id);
  const kid = await addMember(household.id, { role: 'child' });
  return { household, admin, ravi, kid };
}

describe('location shares (real database)', () => {
  it('start, see, update, stop', async () => {
    const { admin, ravi, kid } = await family();
    const start = await request(app).post('/api/v1/location-shares').set(authHeaderFor(kid))
      .send({ durationMinutes: 60, viewerIds: [admin.id], latitude: 27.7, longitude: 85.3, accuracy: 12 });
    expect(start.status).toBe(201);
    const id = start.body.data.id;

    const adminView = await request(app).get('/api/v1/location-shares').set(authHeaderFor(admin));
    expect(adminView.body.data.visible.map((s: { id: string }) => s.id)).toEqual([id]);
    const raviView = await request(app).get('/api/v1/location-shares').set(authHeaderFor(ravi));
    expect(raviView.body.data.visible).toEqual([]);
    const kidView = await request(app).get('/api/v1/location-shares').set(authHeaderFor(kid));
    expect(kidView.body.data.mine.id).toBe(id);

    const moved = await request(app).post(`/api/v1/location-shares/${id}/location`).set(authHeaderFor(kid)).send({ latitude: 27.71, longitude: 85.31 });
    expect(moved.status).toBe(200);
    expect(moved.body.data.latitude).toBeCloseTo(27.71);

    expect((await request(app).post(`/api/v1/location-shares/${id}/location`).set(authHeaderFor(admin)).send({ latitude: 1, longitude: 2 })).status).toBe(403);

    // A child can stop their own share.
    expect((await request(app).post(`/api/v1/location-shares/${id}/stop`).set(authHeaderFor(kid))).status).toBe(200);
    expect((await request(app).post(`/api/v1/location-shares/${id}/location`).set(authHeaderFor(kid)).send({ latitude: 1, longitude: 2 })).status).toBe(410);
  });

  it('rejects more than 8 hours', async () => {
    const { admin } = await family();
    const res = await request(app).post('/api/v1/location-shares').set(authHeaderFor(admin))
      .send({ durationMinutes: 481, viewerIds: null, latitude: 1, longitude: 2 });
    expect(res.status).toBe(400);
  });

  it('accepting a ping starts a share visible only to the person who asked', async () => {
    const { admin, ravi, kid } = await family();
    const ping = await request(app).post('/api/v1/pings').set(authHeaderFor(admin)).send({ targetUserId: kid.id });
    expect(ping.status).toBe(201);
    const accept = await request(app).post(`/api/v1/pings/${ping.body.data.id}/respond`).set(authHeaderFor(kid))
      .send({ action: 'accept', latitude: 27.7, longitude: 85.3, durationMinutes: 15 });
    expect(accept.status).toBe(200);
    expect(accept.body.data.locationShareId).toBeTruthy();

    const adminView = await request(app).get('/api/v1/location-shares').set(authHeaderFor(admin));
    expect(adminView.body.data.visible).toHaveLength(1);
    const raviView = await request(app).get('/api/v1/location-shares').set(authHeaderFor(ravi));
    expect(raviView.body.data.visible).toHaveLength(0);
  });

  it('removing the sharer from the household ends their share and stops their updates', async () => {
    const { household, admin, ravi } = await family();
    const start = await request(app).post('/api/v1/location-shares').set(authHeaderFor(ravi))
      .send({ durationMinutes: 480, viewerIds: null, latitude: 27.7, longitude: 85.3 });
    expect(start.status).toBe(201);
    const id = start.body.data.id;

    const { removeMember } = await import('../../household/service');
    await removeMember(admin.id, household.id, ravi.id);

    const row = await LocationShare.findByPk(id);
    expect(row!.endedAt).not.toBeNull();
    expect(row!.latitude).toBeNull();
    expect((await request(app).get('/api/v1/location-shares').set(authHeaderFor(admin))).body.data.visible).toEqual([]);
  });

  it('the expiry job closes finished shares', async () => {
    const { admin } = await family();
    await request(app).post('/api/v1/location-shares').set(authHeaderFor(admin))
      .send({ durationMinutes: 15, viewerIds: null, latitude: 1, longitude: 2 });
    expect(await endExpiredShares(new Date(Date.now() + 16 * 60_000))).toBe(1);
    expect(await LocationShare.count({ where: { endedAt: null } })).toBe(0);
  });
});
