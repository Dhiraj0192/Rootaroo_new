import { webcrypto } from 'node:crypto';

if (!globalThis.crypto?.subtle) globalThis.crypto = webcrypto;

const { generateAccountKeyPair } = require('../../crypto/accountKey');
const { encryptFile, openFileKey, decryptFile, decryptMeta } = require('../vaultSharing');
const {
  createVaultRepo, MemberKeyChangedError, UNREADABLE_NAME, PENDING_NAME,
} = require('../vaultRepo');

const enc = (s) => new TextEncoder().encode(s);
const b64 = (bytes) => Buffer.from(bytes).toString('base64');

let me;
let ravi;
let kid;
beforeAll(async () => {
  me = await generateAccountKeyPair();
  ravi = await generateAccountKeyPair();
  kid = await generateAccountKeyPair();
});

function memoryPins() {
  const m = new Map();
  return { get: async (id) => m.get(id) ?? null, set: async (id, k) => { m.set(id, k); }, m };
}

function build(overrides = {}) {
  const api = {
    upload: jest.fn(async ({ meta }) => ({ id: 'd1', scope: meta.scope, sealedMeta: meta.sealedMeta })),
    list: jest.fn(async () => ({ documents: [], nextCursor: null })),
    get: jest.fn(),
    members: jest.fn(async () => [
      { userId: 'me', displayName: 'Me', publicKey: me.publicKey },
      { userId: 'ravi', displayName: 'Ravi', publicKey: ravi.publicKey },
    ]),
    pendingGrants: jest.fn(async () => []),
    grant: jest.fn(async () => ({})),
    rename: jest.fn(async () => ({})),
    setScope: jest.fn(async () => ({})),
  };
  const files = new Map();
  const deps = {
    api,
    loadKey: jest.fn(async () => me),
    getUserId: () => 'me',
    readBytes: jest.fn(async () => enc('secret passport scan')),
    fetchBytes: jest.fn(),
    writeTemp: jest.fn(async (bytes, ext) => { const uri = `file:///tmp/x.${ext}`; files.set(uri, bytes); return uri; }),
    deleteTemp: jest.fn(async (uri) => { files.delete(uri); }),
    pins: memoryPins(),
    ...overrides,
  };
  return { repo: createVaultRepo(deps), api, deps, files };
}

async function serverDoc(id, recipients, { uploadedBy = 'me', scope = 'household', name = 'will.pdf', mimeType = 'application/pdf' } = {}) {
  const e = await encryptFile({ bytes: enc('file body'), name, mimeType }, recipients);
  const mine = e.keys.find((k) => k.userId === 'me');
  return {
    raw: {
      id,
      scope,
      sealedMeta: e.sealedMeta,
      sizeBytes: e.blob.length,
      createdAt: '2026-10-01T10:00:00Z',
      uploadedBy: { id: uploadedBy, displayName: 'Someone' },
      mySealedKey: mine?.sealedKey ?? null,
      pending: !mine,
      downloadUrl: mine ? `https://cdn/${id}` : null,
    },
    blob: e.blob,
    enc: e,
  };
}

describe('upload', () => {
  it('never sends the name, type or bytes to the API', async () => {
    const { repo, api } = build();
    await repo.upload({ uri: 'file:///a.pdf', name: 'passport.pdf', mimeType: 'application/pdf', scope: 'household' });
    const { blob, meta } = api.upload.mock.calls[0][0];
    const seen = JSON.stringify([meta, b64(blob)]);
    for (const leak of ['passport', 'pdf', 'secret passport scan', b64(enc('secret passport scan'))]) expect(seen).not.toContain(leak);
    expect(Buffer.from(blob).includes(Buffer.from('secret passport scan'))).toBe(false);
    expect(Object.keys(meta).sort()).toEqual(['keys', 'scope', 'sealedMeta', 'sizeBytes']);
  });

  it('personal files are sealed to me only and do not ask for members', async () => {
    const { repo, api } = build();
    await repo.upload({ uri: 'u', name: 'diary.txt', mimeType: 'text/plain', scope: 'personal' });
    const { blob, meta } = api.upload.mock.calls[0][0];
    expect(meta.scope).toBe('personal');
    expect(meta.keys.map((k) => k.userId)).toEqual(['me']);
    expect(api.members).not.toHaveBeenCalled();
    const fileKey = await openFileKey(meta.keys[0].sealedKey, me.privateKey);
    expect(Buffer.from(await decryptFile(blob, fileKey)).toString()).toBe('secret passport scan');
    expect(await decryptMeta(meta.sealedMeta, fileKey)).toEqual({ name: 'diary.txt', mimeType: 'text/plain' });
  });

  it('household files are sealed to everyone in the household and me', async () => {
    const { repo, api } = build();
    await repo.upload({ uri: 'u', name: 'a.pdf', mimeType: 'application/pdf', scope: 'household' });
    expect(api.upload.mock.calls[0][0].meta.keys.map((k) => k.userId).sort()).toEqual(['me', 'ravi']);
  });

  it('seals to children too: household files are for everyone', async () => {
    const { repo, api } = build();
    api.members.mockResolvedValue([
      { userId: 'me', displayName: 'Me', publicKey: me.publicKey, role: 'admin' },
      { userId: 'ravi', displayName: 'Ravi', publicKey: ravi.publicKey, role: 'member' },
      { userId: 'kid', displayName: 'Kid', publicKey: kid.publicKey, role: 'child' },
    ]);
    await repo.upload({ uri: 'u', name: 'a.pdf', mimeType: 'application/pdf', scope: 'household' });
    expect(api.upload.mock.calls[0][0].meta.keys.map((k) => k.userId).sort()).toEqual(['kid', 'me', 'ravi']);
  });

  it('stops with the names of members whose key changed, and uploads nothing', async () => {
    const { repo, api, deps } = build();
    await deps.pins.set('ravi', (await generateAccountKeyPair()).publicKey);
    const err = await repo.upload({ uri: 'u', name: 'a', mimeType: 'x/y', scope: 'household' }).catch((e) => e);
    expect(err).toBeInstanceOf(MemberKeyChangedError);
    expect(err.members.map((m) => m.displayName)).toEqual(['Ravi']);
    expect(api.upload).not.toHaveBeenCalled();
  });

  it('confirmMemberKey re-pins so the next upload goes through', async () => {
    const { repo, api, deps } = build();
    await deps.pins.set('ravi', (await generateAccountKeyPair()).publicKey);
    const err = await repo.upload({ uri: 'u', name: 'a', mimeType: 'x/y', scope: 'household' }).catch((e) => e);
    await repo.confirmMemberKey(err.members[0].userId, err.members[0].publicKey);
    await repo.upload({ uri: 'u', name: 'a', mimeType: 'x/y', scope: 'household' });
    expect(api.upload.mock.calls[0][0].meta.keys.map((k) => k.userId).sort()).toEqual(['me', 'ravi']);
  });
});

describe('key handling', () => {
  it('asks for the key once, and again after clear()', async () => {
    const { repo, deps } = build();
    await repo.list();
    await repo.list();
    expect(deps.loadKey).toHaveBeenCalledTimes(1);
    repo.clear();
    await repo.list();
    expect(deps.loadKey).toHaveBeenCalledTimes(2);
  });

  it('forgets the key after a minute in the background', async () => {
    const { repo, deps } = build();
    await repo.list();
    repo.onAppStateChange('background', 1000);
    repo.onAppStateChange('active', 70000);
    await repo.list();
    expect(deps.loadKey).toHaveBeenCalledTimes(2);
  });
});

describe('list', () => {
  it('decrypts names and types, and marks unreadable and waiting files', async () => {
    const ok = await serverDoc('ok', [{ userId: 'me', publicKey: me.publicKey }]);
    const waiting = await serverDoc('wait', [{ userId: 'ravi', publicKey: ravi.publicKey }], { uploadedBy: 'ravi' });
    const broken = await serverDoc('bad', [{ userId: 'ravi', publicKey: ravi.publicKey }], { uploadedBy: 'ravi' });
    broken.raw.mySealedKey = ok.raw.mySealedKey;
    broken.raw.pending = false;
    const { repo, api } = build();
    api.list.mockResolvedValue({ documents: [ok.raw, waiting.raw, broken.raw], nextCursor: 'c2' });
    const page = await repo.list();
    expect(page.nextCursor).toBe('c2');
    const [a, b, c] = page.documents;
    expect(a).toMatchObject({ id: 'ok', name: 'will.pdf', mimeType: 'application/pdf', pending: false, unreadable: false, mine: true });
    expect(b).toMatchObject({ name: PENDING_NAME, pending: true, mine: false });
    expect(c).toMatchObject({ name: UNREADABLE_NAME, unreadable: true });
  });
});

describe('open', () => {
  it('decrypts in memory to a data URI without touching disk', async () => {
    const d = await serverDoc('d', [{ userId: 'me', publicKey: me.publicKey }], { name: 'pic.png', mimeType: 'image/png' });
    const { repo, api, deps } = build();
    api.get.mockResolvedValue(d.raw);
    deps.fetchBytes.mockResolvedValue(d.blob);
    const out = await repo.open({ id: 'd' });
    expect(out.dataUri).toBe(`data:image/png;base64,${b64(enc('file body'))}`);
    expect(out.doc.name).toBe('pic.png');
    expect(deps.writeTemp).not.toHaveBeenCalled();
  });

  it('writes a temp file only when asked, and deletes it after 60 seconds', async () => {
    jest.useFakeTimers();
    try {
      const d = await serverDoc('d', [{ userId: 'me', publicKey: me.publicKey }]);
      const { repo, api, deps } = build();
      api.get.mockResolvedValue(d.raw);
      deps.fetchBytes.mockResolvedValue(d.blob);
      const out = await repo.open({ id: 'd' }, { asFile: true });
      expect(out.uri).toBe('file:///tmp/x.pdf');
      expect(out.dataUri).toBeUndefined();
      expect(deps.deleteTemp).not.toHaveBeenCalled();
      jest.advanceTimersByTime(60000);
      expect(deps.deleteTemp).toHaveBeenCalledWith('file:///tmp/x.pdf');
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects a tampered file', async () => {
    const d = await serverDoc('d', [{ userId: 'me', publicKey: me.publicKey }]);
    const { repo, api, deps } = build();
    const bad = Uint8Array.from(d.blob);
    bad[14] ^= 1;
    api.get.mockResolvedValue(d.raw);
    deps.fetchBytes.mockResolvedValue(bad);
    await expect(repo.open({ id: 'd' })).rejects.toThrow();
  });
});

describe('setScope', () => {
  it('to household seals the key to the current members', async () => {
    const d = await serverDoc('d', [{ userId: 'me', publicKey: me.publicKey }], { scope: 'personal' });
    const { repo, api } = build();
    api.get.mockResolvedValue(d.raw);
    await repo.setScope({ id: 'd' }, 'household');
    const [id, body] = api.setScope.mock.calls[0];
    expect(id).toBe('d');
    expect(body.scope).toBe('household');
    expect(body.keys.map((k) => k.userId).sort()).toEqual(['me', 'ravi']);
    const key = await openFileKey(body.keys.find((k) => k.userId === 'ravi').sealedKey, ravi.privateKey);
    expect(await decryptMeta(d.raw.sealedMeta, key)).toMatchObject({ name: 'will.pdf' });
  });

  it('to personal sends no keys', async () => {
    const { repo, api } = build();
    await repo.setScope({ id: 'd' }, 'personal');
    expect(api.setScope).toHaveBeenCalledWith('d', { scope: 'personal' });
  });

  it('to household stops when a member key changed', async () => {
    const d = await serverDoc('d', [{ userId: 'me', publicKey: me.publicKey }], { scope: 'personal' });
    const { repo, api, deps } = build();
    api.get.mockResolvedValue(d.raw);
    await deps.pins.set('ravi', (await generateAccountKeyPair()).publicKey);
    await expect(repo.setScope({ id: 'd' }, 'household')).rejects.toBeInstanceOf(MemberKeyChangedError);
    expect(api.setScope).not.toHaveBeenCalled();
  });
});

describe('rename', () => {
  it('sends only a new sealed name, keeping the type', async () => {
    const d = await serverDoc('d', [{ userId: 'me', publicKey: me.publicKey }]);
    const { repo, api } = build();
    api.get.mockResolvedValue(d.raw);
    await repo.rename({ id: 'd' }, 'Will 2026.pdf');
    const [id, body] = api.rename.mock.calls[0];
    expect(id).toBe('d');
    expect(JSON.stringify(body)).not.toContain('Will');
    expect(await decryptMeta(body.sealedMeta, d.enc.fileKey)).toEqual({ name: 'Will 2026.pdf', mimeType: 'application/pdf' });
  });
});

describe('grantPending', () => {
  it('seals my key copy to the missing members and posts the grants', async () => {
    const d = await serverDoc('d', [{ userId: 'me', publicKey: me.publicKey }]);
    const { repo, api } = build();
    api.pendingGrants.mockResolvedValue([{ documentId: 'd', mySealedKey: d.raw.mySealedKey, missing: [{ userId: 'ravi', publicKey: ravi.publicKey }] }]);
    const out = await repo.grantPending();
    expect(out).toMatchObject({ granted: 1, changed: [] });
    const [id, grants] = api.grant.mock.calls[0];
    expect(id).toBe('d');
    const key = await openFileKey(grants[0].sealedKey, ravi.privateKey);
    expect(await decryptMeta(d.raw.sealedMeta, key)).toMatchObject({ name: 'will.pdf' });
  });

  it('grants to a child who is missing a key too', async () => {
    const d = await serverDoc('d', [{ userId: 'me', publicKey: me.publicKey }]);
    const { repo, api } = build();
    api.pendingGrants.mockResolvedValue([{ documentId: 'd', mySealedKey: d.raw.mySealedKey, missing: [{ userId: 'kid', publicKey: kid.publicKey, role: 'child' }] }]);
    expect(await repo.grantPending()).toMatchObject({ granted: 1, changed: [] });
    expect(api.grant.mock.calls[0][1].map((g) => g.userId)).toEqual(['kid']);
  });

  it('skips members whose key changed and reports them', async () => {
    const d = await serverDoc('d', [{ userId: 'me', publicKey: me.publicKey }]);
    const { repo, api, deps } = build();
    await deps.pins.set('ravi', (await generateAccountKeyPair()).publicKey);
    api.pendingGrants.mockResolvedValue([{ documentId: 'd', mySealedKey: d.raw.mySealedKey, missing: [{ userId: 'ravi', publicKey: ravi.publicKey }] }]);
    const out = await repo.grantPending();
    expect(api.grant).not.toHaveBeenCalled();
    expect(out.granted).toBe(0);
    expect(out.changed).toEqual(['ravi']);
  });

  it('does nothing when nothing is pending', async () => {
    const { repo, api } = build();
    expect(await repo.grantPending()).toEqual({ granted: 0, changed: [] });
    expect(api.grant).not.toHaveBeenCalled();
  });
});

describe('memberKeyStatus', () => {
  it('lists changed members with the key we had pinned', async () => {
    const old = await generateAccountKeyPair();
    const { repo, deps } = build();
    await deps.pins.set('ravi', old.publicKey);
    const { changed } = await repo.memberKeyStatus();
    expect(changed).toEqual([{ userId: 'ravi', displayName: 'Ravi', publicKey: ravi.publicKey, pinnedKey: old.publicKey }]);
  });
});
