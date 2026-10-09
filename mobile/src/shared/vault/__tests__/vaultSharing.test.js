import { webcrypto } from 'node:crypto';

if (!globalThis.crypto?.subtle) globalThis.crypto = webcrypto;

const { generateAccountKeyPair } = require('../../crypto/accountKey');
const {
  encryptFile, openFileKey, decryptFile, decryptMeta, grantAccess, checkMemberKeys,
} = require('../vaultSharing');

const file = (n = 2048) => new Uint8Array(n).map((_, i) => i % 251);

async function people(...names) {
  const out = {};
  for (const n of names) out[n] = await generateAccountKeyPair();
  return out;
}

describe('encrypting a vault file', () => {
  it('a household file opens for every adult it was sealed to', async () => {
    const p = await people('asha', 'ravi');
    const enc = await encryptFile(
      { bytes: file(), name: 'passport.pdf', mimeType: 'application/pdf' },
      [{ userId: 'asha', publicKey: p.asha.publicKey }, { userId: 'ravi', publicKey: p.ravi.publicKey }],
    );
    expect(enc.keys.map((k) => k.userId).sort()).toEqual(['asha', 'ravi']);
    for (const who of ['asha', 'ravi']) {
      const fileKey = await openFileKey(enc.keys.find((k) => k.userId === who).sealedKey, p[who].privateKey);
      expect(Buffer.from(await decryptFile(enc.blob, fileKey)).equals(Buffer.from(file()))).toBe(true);
      expect(await decryptMeta(enc.sealedMeta, fileKey)).toEqual({ name: 'passport.pdf', mimeType: 'application/pdf' });
    }
  });

  it('the name and type are not readable in what goes to the server', async () => {
    const p = await people('asha');
    const enc = await encryptFile({ bytes: file(), name: 'passport.pdf', mimeType: 'application/pdf' }, [{ userId: 'asha', publicKey: p.asha.publicKey }]);
    const wire = JSON.stringify({ sealedMeta: enc.sealedMeta, keys: enc.keys });
    expect(wire).not.toContain('passport');
    expect(wire).not.toContain('pdf');
  });

  it('someone it was not sealed to cannot open it', async () => {
    const p = await people('asha', 'kid');
    const enc = await encryptFile({ bytes: file(), name: 'x', mimeType: 'image/png' }, [{ userId: 'asha', publicKey: p.asha.publicKey }]);
    await expect(openFileKey(enc.keys[0].sealedKey, p.kid.privateKey)).rejects.toThrow();
  });

  it('a tampered file is rejected', async () => {
    const p = await people('asha');
    const enc = await encryptFile({ bytes: file(), name: 'x', mimeType: 'image/png' }, [{ userId: 'asha', publicKey: p.asha.publicKey }]);
    const fileKey = await openFileKey(enc.keys[0].sealedKey, p.asha.privateKey);
    const bad = Uint8Array.from(enc.blob);
    bad[20] ^= 1;
    await expect(decryptFile(bad, fileKey)).rejects.toThrow();
  });
});

describe('giving a new adult access', () => {
  it('re-seals the file key from my copy to each person who is missing one', async () => {
    const p = await people('asha', 'newAdult');
    const enc = await encryptFile({ bytes: file(), name: 'will.pdf', mimeType: 'application/pdf' }, [{ userId: 'asha', publicKey: p.asha.publicKey }]);
    const grants = await grantAccess(
      { documentId: 'd1', mySealedKey: enc.keys[0].sealedKey, missing: [{ userId: 'newAdult', publicKey: p.newAdult.publicKey }] },
      p.asha.privateKey,
    );
    expect(grants).toEqual([{ userId: 'newAdult', sealedKey: expect.any(String) }]);
    const fileKey = await openFileKey(grants[0].sealedKey, p.newAdult.privateKey);
    expect(await decryptMeta(enc.sealedMeta, fileKey)).toEqual({ name: 'will.pdf', mimeType: 'application/pdf' });
  });
});

describe('checking member keys before sharing', () => {
  function memoryPins() {
    const m = new Map();
    return { get: async (id) => m.get(id) ?? null, set: async (id, k) => { m.set(id, k); }, m };
  }

  it('first sight pins a key; the same key later is trusted', async () => {
    const pins = memoryPins();
    const p = await people('ravi');
    expect(await checkMemberKeys([{ userId: 'ravi', publicKey: p.ravi.publicKey }], pins)).toEqual({ trusted: ['ravi'], changed: [] });
    expect(await checkMemberKeys([{ userId: 'ravi', publicKey: p.ravi.publicKey }], pins)).toEqual({ trusted: ['ravi'], changed: [] });
  });

  it('a changed key is reported and not trusted (the app asks before sharing)', async () => {
    const pins = memoryPins();
    const first = await generateAccountKeyPair();
    const second = await generateAccountKeyPair();
    await checkMemberKeys([{ userId: 'ravi', publicKey: first.publicKey }], pins);
    expect(await checkMemberKeys([{ userId: 'ravi', publicKey: second.publicKey }], pins)).toEqual({ trusted: [], changed: ['ravi'] });
    expect(pins.m.get('ravi')).toBe(first.publicKey);
  });
});
