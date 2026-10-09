import request from 'supertest';
import { createHash, randomBytes } from 'crypto';
import app from '../../../app';
import { setupAssociations, Device, KeyBackup, KeyRestoreCode } from '../../../database/models';
import { resetDb, closeIntResources } from '../../../test/int/db';
import { __setServicesForTests } from '../../../services';

beforeAll(() => setupAssociations());
afterAll(() => closeIntResources());

const sentEmails: Array<{ to: string; subject: string; text: string }> = [];
beforeEach(async () => {
  await resetDb();
  sentEmails.length = 0;
  __setServicesForTests({ email: { name: 'fake', send: async (m: { to: string; subject: string; text: string }) => { sentEmails.push(m); } } });
});

const OLD = { 'X-Device-Id': '11111111-2222-4333-8444-555555555555', 'X-Device-Name': 'Old phone', 'X-Platform': 'ios' };
const NEW = { 'X-Device-Id': '66666666-7777-4888-9999-000000000000', 'X-Device-Name': 'New phone', 'X-Platform': 'android' };
const creds = { email: 'asha@example.test', password: 'correct horse battery' };
const b64 = (n: number) => randomBytes(n).toString('base64');
const PUB = b64(32);

async function signIn(headers: Record<string, string>) {
  const res = await request(app).post('/api/v1/auth/login').set(headers).send(creds);
  expect(res.status).toBe(200);
  return { ...headers, Authorization: `Bearer ${res.body.data.tokens.accessToken}`, refreshToken: res.body.data.tokens.refreshToken };
}
const h = (s: Record<string, string>) => { const { refreshToken: _r, ...rest } = s; return rest; };

async function setupOldPhone() {
  await request(app).post('/api/v1/auth/register').set(OLD).send({ ...creds, displayName: 'Asha' });
  const old = await signIn(OLD);
  const put = await request(app).put('/api/v1/account-key').set(h(old)).send({ publicKey: PUB });
  expect(put.status).toBe(201);
  return old;
}

describe('account key', () => {
  it('created once; this phone holds it; a second create is refused', async () => {
    const old = await setupOldPhone();
    const got = await request(app).get('/api/v1/account-key').set(h(old));
    expect(got.body.data).toEqual(expect.objectContaining({ publicKey: PUB, holdsKey: true, hasBackup: false }));
    expect((await request(app).put('/api/v1/account-key').set(h(old)).send({ publicKey: b64(32) })).status).toBe(409);
  });

  it('rejects a public key that is not 32 bytes', async () => {
    await request(app).post('/api/v1/auth/register').set(OLD).send({ ...creds, displayName: 'Asha' });
    const old = await signIn(OLD);
    expect((await request(app).put('/api/v1/account-key').set(h(old)).send({ publicKey: b64(16) })).status).toBe(400);
  });

  it('a second phone sees the key exists but does not hold it', async () => {
    await setupOldPhone();
    const fresh = await signIn(NEW);
    const got = await request(app).get('/api/v1/account-key').set(h(fresh));
    expect(got.body.data).toEqual(expect.objectContaining({ publicKey: PUB, holdsKey: false }));
  });
});

describe('moving to a new phone', () => {
  it('relays the sealed key, makes the new phone the holder and signs the old phone out', async () => {
    const old = await setupOldPhone();
    const fresh = await signIn(NEW);
    const eN = b64(32);

    const created = await request(app).post('/api/v1/key-transfer/sessions').set(h(fresh)).send({ ephemeralPublicKey: eN });
    expect(created.status).toBe(201);
    const id = created.body.data.sessionId;

    const seen = await request(app).get(`/api/v1/key-transfer/sessions/${id}`).set(h(old));
    expect(seen.body.data.newEphemeralPublicKey).toBe(eN);

    // Only the phone holding the key can send it.
    expect((await request(app).post(`/api/v1/key-transfer/sessions/${id}/payload`).set(h(fresh)).send({ ephemeralPublicKey: b64(32), sealed: b64(80) })).status).toBe(403);
    expect((await request(app).post(`/api/v1/key-transfer/sessions/${id}/payload`).set(h(old)).send({ ephemeralPublicKey: b64(32), sealed: b64(80) })).status).toBe(200);

    // Only the new phone can complete.
    expect((await request(app).post(`/api/v1/key-transfer/sessions/${id}/complete`).set(h(old))).status).toBe(403);
    const done = await request(app).post(`/api/v1/key-transfer/sessions/${id}/complete`).set(h(fresh));
    expect(done.status).toBe(200);

    expect((await request(app).get('/api/v1/account-key').set(h(fresh))).body.data.holdsKey).toBe(true);
    expect(await Device.count({ where: { holdsAccountKey: true } })).toBe(1);

    const refresh = await request(app).post('/api/v1/auth/refresh').set(OLD).send({ refreshToken: old.refreshToken });
    expect(refresh.status).toBe(401);
    expect(refresh.body.code ?? refresh.body.error?.code).toBe('DEVICE_REVOKED');

    // Sessions are single use.
    expect((await request(app).post(`/api/v1/key-transfer/sessions/${id}/complete`).set(h(fresh))).status).toBe(409);
  });

  it("another user cannot read or use someone's session", async () => {
    await setupOldPhone();
    const fresh = await signIn(NEW);
    const id = (await request(app).post('/api/v1/key-transfer/sessions').set(h(fresh)).send({ ephemeralPublicKey: b64(32) })).body.data.sessionId;
    await request(app).post('/api/v1/auth/register').set(OLD).send({ email: 'ravi@example.test', password: 'another long pass', displayName: 'Ravi' });
    const ravi = await request(app).post('/api/v1/auth/login').set(OLD).send({ email: 'ravi@example.test', password: 'another long pass' });
    const auth = { ...OLD, Authorization: `Bearer ${ravi.body.data.tokens.accessToken}` };
    expect((await request(app).get(`/api/v1/key-transfer/sessions/${id}`).set(auth)).status).toBe(404);
  });

  it('needs an account key to exist first', async () => {
    await request(app).post('/api/v1/auth/register').set(OLD).send({ ...creds, displayName: 'Asha' });
    const fresh = await signIn(NEW);
    expect((await request(app).post('/api/v1/key-transfer/sessions').set(h(fresh)).send({ ephemeralPublicKey: b64(32) })).status).toBe(409);
  });
});

describe('backup and restore', () => {
  const authKey = b64(32);
  const blob = b64(120);

  async function withBackup() {
    const old = await setupOldPhone();
    const put = await request(app).put('/api/v1/key-backup').set(h(old)).send({
      kind: 'password', salt: b64(16), kdf: { algorithm: 'argon2id', memoryKiB: 19456, iterations: 2, parallelism: 1, length: 64 }, authKey, blob,
    });
    expect(put.status).toBe(200);
    return old;
  }

  async function restoreToken(fresh: Record<string, string>) {
    expect((await request(app).post('/api/v1/key-backup/restore/start').set(h(fresh))).status).toBe(200);
    const code = sentEmails.at(-1)!.text.match(/\b(\d{6})\b/)![1];
    const params = await request(app).post('/api/v1/key-backup/restore/params').set(h(fresh)).send({ emailCode: code });
    expect(params.status).toBe(200);
    return params.body.data;
  }

  it('never stores the proof or the blob as sent', async () => {
    await withBackup();
    const row = await KeyBackup.findOne();
    expect(JSON.stringify(row!.toJSON())).not.toContain(authKey);
    expect(JSON.stringify(row!.toJSON())).not.toContain(blob);
  });

  it('records which key vault protected the backup', async () => {
    await withBackup();
    expect((await KeyBackup.findOne())?.vaultProvider).toBe('local');
  });

  it('only the phone holding the key can set the backup', async () => {
    await withBackup();
    const fresh = await signIn(NEW);
    expect((await request(app).put('/api/v1/key-backup').set(h(fresh)).send({ kind: 'password', salt: b64(16), kdf: {}, authKey, blob })).status).toBe(403);
  });

  it('email code, then the right password returns the backup and moves the key here', async () => {
    const old = await withBackup();
    const fresh = await signIn(NEW);
    const p = await restoreToken(fresh);
    expect(p).toEqual(expect.objectContaining({ kind: 'password', attemptsLeft: 10, salt: expect.any(String), restoreToken: expect.any(String) }));
    const ok = await request(app).post('/api/v1/key-backup/restore').set(h(fresh)).send({ restoreToken: p.restoreToken, authKey });
    expect(ok.status).toBe(200);
    expect(ok.body.data.blob).toBe(blob);
    expect((await request(app).get('/api/v1/account-key').set(h(fresh))).body.data.holdsKey).toBe(true);
    expect((await request(app).post('/api/v1/auth/refresh').set(OLD).send({ refreshToken: old.refreshToken })).status).toBe(401);
  });

  it('wrong passwords count down and the 10th erases the backup for good', async () => {
    await withBackup();
    const fresh = await signIn(NEW);
    const p = await restoreToken(fresh);
    for (let left = 9; left >= 1; left--) {
      const r = await request(app).post('/api/v1/key-backup/restore').set(h(fresh)).send({ restoreToken: p.restoreToken, authKey: b64(32) });
      expect(r.status).toBe(401);
      expect(r.body.attemptsLeft ?? r.body.error?.attemptsLeft).toBe(left);
    }
    const last = await request(app).post('/api/v1/key-backup/restore').set(h(fresh)).send({ restoreToken: p.restoreToken, authKey: b64(32) });
    expect(last.status).toBe(410);
    expect(await KeyBackup.count()).toBe(0);
    expect(sentEmails.some((m) => /erased/i.test(m.subject))).toBe(true);
    const after = await request(app).post('/api/v1/key-backup/restore').set(h(fresh)).send({ restoreToken: p.restoreToken, authKey });
    expect([404, 410]).toContain(after.status);
  });

  it('a wrong email code is refused and limited', async () => {
    await withBackup();
    const fresh = await signIn(NEW);
    await request(app).post('/api/v1/key-backup/restore/start').set(h(fresh));
    for (let i = 0; i < 5; i++) {
      expect((await request(app).post('/api/v1/key-backup/restore/params').set(h(fresh)).send({ emailCode: '000000' })).status).toBe(400);
    }
    const real = sentEmails.at(-1)!.text.match(/\b(\d{6})\b/)![1];
    expect((await request(app).post('/api/v1/key-backup/restore/params').set(h(fresh)).send({ emailCode: real })).status).toBe(400);
    expect(await KeyRestoreCode.count()).toBeLessThanOrEqual(1);
  });

  it('cannot start more than 3 restores an hour', async () => {
    await withBackup();
    const fresh = await signIn(NEW);
    for (let i = 0; i < 3; i++) expect((await request(app).post('/api/v1/key-backup/restore/start').set(h(fresh))).status).toBe(200);
    expect((await request(app).post('/api/v1/key-backup/restore/start').set(h(fresh))).status).toBe(429);
  });

  it('changing the backup ends a restore in progress', async () => {
    const old = await withBackup();
    const fresh = await signIn(NEW);
    const p = await restoreToken(fresh);
    const put = await request(app).put('/api/v1/key-backup').set(h(old)).send({
      kind: 'password', salt: b64(16), kdf: { algorithm: 'argon2id', memoryKiB: 19456, iterations: 2, parallelism: 1, length: 64 }, authKey, blob,
    });
    expect(put.status).toBe(200);
    expect(await KeyRestoreCode.count()).toBe(0);
    const res = await request(app).post('/api/v1/key-backup/restore').set(h(fresh)).send({ restoreToken: p.restoreToken, authKey });
    expect(res.status).toBe(400);
  });

  it('email codes are stored as vault MACs, not a plain SHA-256', async () => {
    await withBackup();
    const fresh = await signIn(NEW);
    await request(app).post('/api/v1/key-backup/restore/start').set(h(fresh));
    const code = sentEmails.at(-1)!.text.match(/\b(\d{6})\b/)![1];
    const row = await KeyRestoreCode.findOne();
    expect(row!.codeHash).not.toBe(createHash('sha256').update(code).digest('hex'));
    expect(row!.codeHash).toMatch(/^[A-Za-z0-9+/]{43}=$/);
  });
});

describe('the key holder is removed', () => {
  it('clears the holder: nobody holds the key, transfer says NO_KEY_HOLDER, restore is the path', async () => {
    const old = await setupOldPhone();
    const fresh = await signIn(NEW);
    const oldDevice = await Device.findOne({ where: { holdsAccountKey: true } });
    const removed = await request(app).delete(`/api/v1/devices/${oldDevice!.id}`).set(h(fresh));
    expect(removed.status).toBe(200);
    expect(await Device.count({ where: { holdsAccountKey: true } })).toBe(0);
    expect((await request(app).get('/api/v1/account-key').set(h(fresh))).body.data.holdsKey).toBe(false);
    const create = await request(app).post('/api/v1/key-transfer/sessions').set(h(fresh)).send({ ephemeralPublicKey: b64(32) });
    expect(create.status).toBe(409);
    expect(create.body.code ?? create.body.error?.code).toBe('NO_KEY_HOLDER');
    expect(old.Authorization).toBeDefined();
  });

  it('a sent transfer is not cancelled by another start', async () => {
    const old = await setupOldPhone();
    const fresh = await signIn(NEW);
    const id = (await request(app).post('/api/v1/key-transfer/sessions').set(h(fresh)).send({ ephemeralPublicKey: b64(32) })).body.data.sessionId;
    expect((await request(app).post(`/api/v1/key-transfer/sessions/${id}/payload`).set(h(old)).send({ ephemeralPublicKey: b64(32), sealed: b64(80) })).status).toBe(200);
    const again = await request(app).post('/api/v1/key-transfer/sessions').set(h(fresh)).send({ ephemeralPublicKey: b64(32) });
    expect(again.status).toBe(409);
    expect(again.body.code ?? again.body.error?.code).toBe('TRANSFER_IN_PROGRESS');
    expect((await request(app).post(`/api/v1/key-transfer/sessions/${id}/complete`).set(h(fresh))).status).toBe(200);
  });
});
