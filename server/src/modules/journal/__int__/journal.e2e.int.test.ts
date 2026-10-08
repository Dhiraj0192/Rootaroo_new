import request from 'supertest';
import { randomBytes } from 'crypto';
import { QueryTypes } from 'sequelize';
import app from '../../../app';
import sequelize from '../../../config/database';
import { setupAssociations } from '../../../database/models';
import { resetDb, closeIntResources } from '../../../test/int/db';
import { createHouseholdWithAdmin, addMember, authHeaderFor } from '../../../test/factories';

beforeAll(() => setupAssociations());
beforeEach(() => resetDb());
afterAll(() => closeIntResources());

const b64 = (n: number) => randomBytes(n).toString('base64');
const entryBody = (extra: Record<string, unknown> = {}) => ({ ciphertext: b64(300), sealedKey: b64(92), format: 1, ...extra });

describe('encrypted journal (real database)', () => {
  it('the table no longer has readable content columns', async () => {
    const cols = await sequelize.query<{ COLUMN_NAME: string }>(
      "SELECT COLUMN_NAME FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'journal_entries'",
      { type: QueryTypes.SELECT },
    );
    const names = cols.map((c) => c.COLUMN_NAME);
    expect(names).toEqual(expect.arrayContaining(['id', 'user_id', 'household_id', 'created_at', 'ciphertext', 'sealed_key', 'format']));
    for (const gone of ['content', 'mood', 'tags']) expect(names).not.toContain(gone);
  });

  it('stores and returns only ciphertext; refuses readable content', async () => {
    const { admin } = await createHouseholdWithAdmin({ cohort: 'test' });
    const body = entryBody();
    const created = await request(app).post('/api/v1/journal').set(authHeaderFor(admin)).send(body);
    expect(created.status).toBe(201);
    expect(created.body.data).toEqual(expect.objectContaining({ id: expect.any(String), createdAt: expect.any(String), ciphertext: body.ciphertext, sealedKey: body.sealedKey, format: 1 }));
    for (const k of ['content', 'mood', 'tags', 'wordCount']) expect(created.body.data).not.toHaveProperty(k);

    const plain = await request(app).post('/api/v1/journal').set(authHeaderFor(admin)).send({ content: 'readable', mood: 'happy' });
    expect(plain.status).toBe(400);
  });

  it('only the author can see their entries', async () => {
    const { household, admin } = await createHouseholdWithAdmin({ cohort: 'test' });
    const other = await addMember(household.id);
    const created = await request(app).post('/api/v1/journal').set(authHeaderFor(admin)).send(entryBody());
    expect((await request(app).get(`/api/v1/journal/${created.body.data.id}`).set(authHeaderFor(other))).status).toBe(404);
    expect((await request(app).get('/api/v1/journal').set(authHeaderFor(other))).body.data.entries ?? []).toHaveLength(0);
  });

  it('stats come from dates only: streak, wrote today, entries this month — no words or moods', async () => {
    const { admin } = await createHouseholdWithAdmin({ cohort: 'test' });
    await request(app).post('/api/v1/journal').set(authHeaderFor(admin)).send(entryBody());
    const stats = await request(app).get('/api/v1/journal/stats').set(authHeaderFor(admin));
    expect(stats.status).toBe(200);
    expect(stats.body.data).toEqual(expect.objectContaining({ streak: 1, wroteToday: true, entriesThisMonth: 1, prompt: expect.any(String) }));
    for (const k of ['wordsThisMonth', 'moodSummary', 'topTags']) expect(stats.body.data).not.toHaveProperty(k);
    const history = await request(app).get('/api/v1/journal/history').set(authHeaderFor(admin)).query({ month: new Date().toISOString().slice(0, 7) });
    expect(history.status).toBe(200);
    expect(history.body.data.entryDates).toHaveLength(1);
    for (const k of ['moodDays', 'topTags', 'moodSummary']) expect(history.body.data).not.toHaveProperty(k);
  });

  it('attachments must be the author\'s own encrypted uploads', async () => {
    const { household, admin } = await createHouseholdWithAdmin({ cohort: 'test' });
    const other = await addMember(household.id);
    const theirs = `journal/blobs/${other.id}/x`;
    const res = await request(app).post('/api/v1/journal').set(authHeaderFor(admin)).send(entryBody({ media: [{ blobKey: theirs, sizeBytes: 100 }] }));
    expect(res.status).toBe(403);
  });

  it('update replaces the ciphertext; delete removes the entry', async () => {
    const { admin } = await createHouseholdWithAdmin({ cohort: 'test' });
    const created = await request(app).post('/api/v1/journal').set(authHeaderFor(admin)).send(entryBody());
    const id = created.body.data.id;
    const next = b64(300);
    const upd = await request(app).patch(`/api/v1/journal/${id}`).set(authHeaderFor(admin)).send({ ciphertext: next, sealedKey: created.body.data.sealedKey, format: 1 });
    expect(upd.status).toBe(200);
    expect(upd.body.data.ciphertext).toBe(next);
    expect((await request(app).delete(`/api/v1/journal/${id}`).set(authHeaderFor(admin))).status).toBeLessThan(300);
    expect((await request(app).get(`/api/v1/journal/${id}`).set(authHeaderFor(admin))).status).toBe(404);
  });
});
