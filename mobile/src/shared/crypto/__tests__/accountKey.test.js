import { webcrypto } from 'node:crypto';

if (!globalThis.crypto?.subtle) globalThis.crypto = webcrypto;

const SecureStore = require('expo-secure-store');
const {
  generateAccountKeyPair, seal, open, saveAccountKey, loadAccountPrivateKey, deleteAccountKey,
  accountKeyStorageKey, fingerprint,
} = require('../accountKey');

const bytes = (s) => new TextEncoder().encode(s);
const text = (b) => new TextDecoder().decode(b);
const b64len = (s) => Buffer.from(s, 'base64').length;

beforeEach(() => jest.clearAllMocks());

describe('account key', () => {
  it('is an X25519 pair: 32-byte public key, private key as exportable text', async () => {
    const k = await generateAccountKeyPair();
    expect(b64len(k.publicKey)).toBe(32);
    expect(typeof k.privateKey).toBe('string');
    expect(k.privateKey.length).toBeGreaterThan(40);
  });

  it('seal then open gives the bytes back', async () => {
    const k = await generateAccountKeyPair();
    const sealed = await seal(k.publicKey, bytes('my journal entry'));
    expect(text(await open(k.privateKey, sealed))).toBe('my journal entry');
  });

  it('sealed output is ephemeral key + nonce + ciphertext, and differs every time', async () => {
    const k = await generateAccountKeyPair();
    const a = await seal(k.publicKey, bytes('same'));
    const b = await seal(k.publicKey, bytes('same'));
    expect(a.length).toBe(32 + 12 + 4 + 16);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it("someone else's key cannot open it", async () => {
    const mine = await generateAccountKeyPair();
    const theirs = await generateAccountKeyPair();
    const sealed = await seal(mine.publicKey, bytes('secret'));
    await expect(open(theirs.privateKey, sealed)).rejects.toThrow();
  });

  it('any changed byte is rejected', async () => {
    const k = await generateAccountKeyPair();
    const sealed = await seal(k.publicKey, bytes('secret'));
    for (const i of [0, 33, sealed.length - 1]) {
      const bad = Uint8Array.from(sealed);
      bad[i] ^= 1;
      await expect(open(k.privateKey, bad)).rejects.toThrow();
    }
  });

  it('a short fingerprint people can compare', async () => {
    const k = await generateAccountKeyPair();
    const f = await fingerprint(k.publicKey);
    expect(f).toMatch(/^[A-Za-z0-9_-]{4}( [A-Za-z0-9_-]{4}){3}$/);
    expect(await fingerprint(k.publicKey)).toBe(f);
  });
});

describe('key storage', () => {
  it('stores the private key behind biometrics and the public key next to it', async () => {
    await saveAccountKey('u1', { publicKey: 'PUB', privateKey: 'PRIV' });
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
      accountKeyStorageKey('u1'),
      JSON.stringify({ publicKey: 'PUB', privateKey: 'PRIV' }),
      expect.objectContaining({ requireAuthentication: true }),
    );
  });

  it('loads it back (asking for biometrics) and returns null when absent', async () => {
    SecureStore.getItemAsync.mockResolvedValueOnce(JSON.stringify({ publicKey: 'PUB', privateKey: 'PRIV' }));
    expect(await loadAccountPrivateKey('u1')).toEqual({ publicKey: 'PUB', privateKey: 'PRIV' });
    expect(SecureStore.getItemAsync).toHaveBeenCalledWith(accountKeyStorageKey('u1'), expect.objectContaining({ requireAuthentication: true }));
    SecureStore.getItemAsync.mockResolvedValueOnce(null);
    expect(await loadAccountPrivateKey('u1')).toBeNull();
  });

  it('deletes it (used when this phone is signed out after a move)', async () => {
    await deleteAccountKey('u1');
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith(accountKeyStorageKey('u1'));
  });
});
