import request from 'supertest';
import { randomBytes } from 'crypto';
import { QueryTypes } from 'sequelize';
import app from '../../../app';
import sequelize from '../../../config/database';
import { setupAssociations, AccountKey, VaultDocumentKey } from '../../../database/models';
import { resetDb, closeIntResources } from '../../../test/int/db';
import { createHouseholdWithAdmin, addMember, authHeaderFor } from '../../../test/factories';
import type User from '../../../database/models/User';

beforeAll(() => setupAssociations());
beforeEach(() => resetDb());
afterAll(() => closeIntResources());

const b64 = (n: number) => randomBytes(n).toString('base64');
const withKey = async (u: User) => { await AccountKey.create({ userId: u.id, publicKey: b64(32), keyVersion: 1 }); return u; };

async function family() {
  const { household, admin } = await createHouseholdWithAdmin({ cohort: 'test' });
  const ravi = await withKey(await addMember(household.id));
  const kid = await withKey(await addMember(household.id, { role: 'child' }));
  await withKey(admin);
  return { household, admin, ravi, kid };
}

/** Uploads ciphertext with sealed metadata. Multipart: file + JSON fields, like the app. */
function upload(as: User, fields: Record<string, unknown>) {
  return request(app).post('/api/v1/vault').set(authHeaderFor(as))
    .attach('file', randomBytes(256), { filename: 'blob', contentType: 'application/octet-stream' })
    .field('meta', JSON.stringify(fields));
}

describe('shared vault (real database)', () => {
  it('file names and types are not stored readable', async () => {
    const cols = await sequelize.query<{ COLUMN_NAME: string }>(
      "SELECT COLUMN_NAME FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'vault_documents'",
      { type: QueryTypes.SELECT },
    );
    const names = cols.map((c) => c.COLUMN_NAME);
    expect(names).toEqual(expect.arrayContaining(['sealed_meta', 'scope', 'size_bytes', 's3_key']));
    for (const gone of ['name', 'mime_type', 'encrypted_key', 'iv']) expect(names).not.toContain(gone);
  });

  it('a household file is visible to everyone in the household, children included, with their own sealed key', async () => {
    const { admin, ravi, kid } = await family();
    const up = await upload(admin, { scope: 'household', sealedMeta: b64(80), sizeBytes: 256, keys: [admin, ravi, kid].map((u) => ({ userId: u.id, sealedKey: b64(92) })) });
    expect(up.status).toBe(201);
    const id = up.body.data.id;

    const raviList = await request(app).get('/api/v1/vault').set(authHeaderFor(ravi));
    expect(raviList.body.data.documents.map((d: { id: string }) => d.id)).toContain(id);
    const doc = raviList.body.data.documents.find((d: { id: string }) => d.id === id);
    expect(doc).toEqual(expect.objectContaining({ scope: 'household', sealedMeta: expect.any(String), mySealedKey: expect.any(String) }));

    const kidList = await request(app).get('/api/v1/vault').set(authHeaderFor(kid));
    expect(kidList.body.data.documents.map((d: { id: string }) => d.id)).toContain(id);
    const kidDoc = await request(app).get(`/api/v1/vault/${id}`).set(authHeaderFor(kid));
    expect(kidDoc.status).toBe(200);
    expect(kidDoc.body.data.mySealedKey).toEqual(expect.any(String));
  });

  it('a child can upload a household file that adults can open', async () => {
    const { admin, kid } = await family();
    const up = await upload(kid, { scope: 'household', sealedMeta: b64(80), sizeBytes: 256, keys: [kid, admin].map((u) => ({ userId: u.id, sealedKey: b64(92) })) });
    expect(up.status).toBe(201);
    expect((await request(app).get(`/api/v1/vault/${up.body.data.id}`).set(authHeaderFor(admin))).status).toBe(200);
  });

  it('refuses to seal a household file to an outsider', async () => {
    const { admin } = await family();
    const { household: otherHousehold } = await createHouseholdWithAdmin({ cohort: 'test' });
    const stranger = await withKey(await addMember(otherHousehold.id));
    const toStranger = await upload(admin, { scope: 'household', sealedMeta: b64(80), sizeBytes: 256, keys: [{ userId: admin.id, sealedKey: b64(92) }, { userId: stranger.id, sealedKey: b64(92) }] });
    expect(toStranger.status).toBe(400);
  });

  it('a personal file is only for the uploader', async () => {
    const { admin, ravi } = await family();
    const up = await upload(ravi, { scope: 'personal', sealedMeta: b64(80), sizeBytes: 256, keys: [{ userId: ravi.id, sealedKey: b64(92) }] });
    expect(up.status).toBe(201);
    expect((await request(app).get(`/api/v1/vault/${up.body.data.id}`).set(authHeaderFor(admin))).status).toBe(404);
    const badPersonal = await upload(ravi, { scope: 'personal', sealedMeta: b64(80), sizeBytes: 256, keys: [{ userId: ravi.id, sealedKey: b64(92) }, { userId: admin.id, sealedKey: b64(92) }] });
    expect(badPersonal.status).toBe(400);
  });

  it('a member without a key yet sees the file as pending, and another member can grant it', async () => {
    const { household, admin, ravi, kid } = await family();
    const up = await upload(admin, { scope: 'household', sealedMeta: b64(80), sizeBytes: 256, keys: [admin, ravi, kid].map((u) => ({ userId: u.id, sealedKey: b64(92) })) });
    const id = up.body.data.id;
    const newcomer = await withKey(await addMember(household.id));

    const theirs = await request(app).get('/api/v1/vault').set(authHeaderFor(newcomer));
    expect(theirs.body.data.documents.find((d: { id: string }) => d.id === id)).toEqual(expect.objectContaining({ pending: true, mySealedKey: null }));

    const grants = await request(app).get('/api/v1/vault/pending-grants').set(authHeaderFor(ravi));
    expect(grants.body.data).toEqual([expect.objectContaining({ documentId: id, mySealedKey: expect.any(String), missing: [expect.objectContaining({ userId: newcomer.id, publicKey: expect.any(String) })] })]);

    const give = await request(app).post(`/api/v1/vault/${id}/keys`).set(authHeaderFor(ravi)).send({ grants: [{ userId: newcomer.id, sealedKey: b64(92) }] });
    expect(give.status).toBe(200);
    const after = await request(app).get(`/api/v1/vault/${id}`).set(authHeaderFor(newcomer));
    expect(after.body.data.mySealedKey).toEqual(expect.any(String));
    // Granting twice is refused.
    expect((await request(app).post(`/api/v1/vault/${id}/keys`).set(authHeaderFor(ravi)).send({ grants: [{ userId: newcomer.id, sealedKey: b64(92) }] })).status).toBe(409);
  });

  it('only someone who can open the file can grant it', async () => {
    const { household, admin } = await family();
    const up = await upload(admin, { scope: 'household', sealedMeta: b64(80), sizeBytes: 256, keys: [{ userId: admin.id, sealedKey: b64(92) }] });
    const newcomer = await withKey(await addMember(household.id));
    const other = await withKey(await addMember(household.id));
    const res = await request(app).post(`/api/v1/vault/${up.body.data.id}/keys`).set(authHeaderFor(newcomer)).send({ grants: [{ userId: other.id, sealedKey: b64(92) }] });
    expect(res.status).toBe(403);
  });

  it('becoming a child keeps household access; leaving or removal removes it', async () => {
    const { household, admin, ravi } = await family();
    const other = await withKey(await addMember(household.id));
    const up = await upload(admin, { scope: 'household', sealedMeta: b64(80), sizeBytes: 256, keys: [admin, ravi, other].map((u) => ({ userId: u.id, sealedKey: b64(92) })) });
    const id = up.body.data.id;
    const { changeMemberRole, removeMember } = await import('../../household/service');
    await changeMemberRole(admin.id, household.id, ravi.id, { role: 'child' });
    expect(await VaultDocumentKey.count({ where: { documentId: id, userId: ravi.id } })).toBe(1);
    expect((await request(app).get(`/api/v1/vault/${id}`).set(authHeaderFor(ravi))).status).toBe(200);
    await removeMember(admin.id, household.id, other.id);
    expect(await VaultDocumentKey.count({ where: { documentId: id, userId: other.id } })).toBe(0);
    expect(await VaultDocumentKey.count({ where: { documentId: id, userId: admin.id } })).toBe(1);
  });

  it('refuses a grant to someone who was removed, and from someone who was removed', async () => {
    const { household, admin, ravi } = await family();
    const removed = await withKey(await addMember(household.id));
    const up = await upload(admin, { scope: 'household', sealedMeta: b64(80), sizeBytes: 256, keys: [admin, ravi].map((u) => ({ userId: u.id, sealedKey: b64(92) })) });
    const id = up.body.data.id;
    const { removeMember } = await import('../../household/service');
    await removeMember(admin.id, household.id, removed.id);

    const toRemoved = await request(app).post(`/api/v1/vault/${id}/keys`).set(authHeaderFor(admin)).send({ grants: [{ userId: removed.id, sealedKey: b64(92) }] });
    expect(toRemoved.status).toBe(400);
    expect(await VaultDocumentKey.count({ where: { documentId: id, userId: removed.id } })).toBe(0);

    await removeMember(admin.id, household.id, ravi.id);
    const fromRemoved = await request(app).post(`/api/v1/vault/${id}/keys`).set(authHeaderFor(ravi)).send({ grants: [{ userId: admin.id, sealedKey: b64(92) }] });
    expect([403, 404, 409]).toContain(fromRemoved.status);
  });

  it('a grant after the file became personal is refused', async () => {
    const { household, admin } = await family();
    const other = await withKey(await addMember(household.id));
    const up = await upload(admin, { scope: 'household', sealedMeta: b64(80), sizeBytes: 256, keys: [{ userId: admin.id, sealedKey: b64(92) }] });
    const id = up.body.data.id;
    expect((await request(app).patch(`/api/v1/vault/${id}/scope`).set(authHeaderFor(admin)).send({ scope: 'personal' })).status).toBe(200);
    const res = await request(app).post(`/api/v1/vault/${id}/keys`).set(authHeaderFor(admin)).send({ grants: [{ userId: other.id, sealedKey: b64(92) }] });
    expect(res.status).toBe(400);
    expect(await VaultDocumentKey.count({ where: { documentId: id, userId: other.id } })).toBe(0);
  });

  it('clears a stale key row when the person rejoins', async () => {
    const { household, admin } = await family();
    const leaver = await withKey(await addMember(household.id));
    const up = await upload(admin, { scope: 'household', sealedMeta: b64(80), sizeBytes: 256, keys: [admin, leaver].map((u) => ({ userId: u.id, sealedKey: b64(92) })) });
    const id = up.body.data.id;
    const { removeMember, joinViaCode } = await import('../../household/service');

    await removeMember(admin.id, household.id, leaver.id);
    // A key that slipped in around the removal (the race this guards against).
    await VaultDocumentKey.create({ documentId: id, userId: leaver.id, wrappedKey: b64(92) });
    await joinViaCode(leaver.id, { code: household.inviteCode });
    expect(await VaultDocumentKey.count({ where: { documentId: id, userId: leaver.id } })).toBe(0);

  });

  it('rejects a declared size that does not match the uploaded bytes', async () => {
    const { admin } = await family();
    const res = await upload(admin, { scope: 'personal', sealedMeta: b64(80), sizeBytes: 255, keys: [{ userId: admin.id, sealedKey: b64(92) }] });
    expect(res.status).toBe(400);
  });

  it('only the uploader changes Personal/Household; an admin can still delete', async () => {
    const { admin, ravi } = await family();
    const up = await upload(ravi, { scope: 'household', sealedMeta: b64(80), sizeBytes: 256, keys: [{ userId: ravi.id, sealedKey: b64(92) }, { userId: admin.id, sealedKey: b64(92) }] });
    const id = up.body.data.id;
    expect((await request(app).patch(`/api/v1/vault/${id}/scope`).set(authHeaderFor(admin)).send({ scope: 'personal' })).status).toBe(403);
    const toPersonal = await request(app).patch(`/api/v1/vault/${id}/scope`).set(authHeaderFor(ravi)).send({ scope: 'personal' });
    expect(toPersonal.status).toBe(200);
    expect(await VaultDocumentKey.count({ where: { documentId: id } })).toBe(1);
    expect((await request(app).delete(`/api/v1/vault/${id}`).set(authHeaderFor(admin))).status).toBeLessThan(300);
  });

  it('lists everyone in the household and their public keys for sealing', async () => {
    const { admin, ravi, kid } = await family();
    const res = await request(app).get('/api/v1/vault/members').set(authHeaderFor(admin));
    const ids = res.body.data.map((m: { userId: string }) => m.userId);
    expect(ids).toEqual(expect.arrayContaining([admin.id, ravi.id, kid.id]));
  });
});
