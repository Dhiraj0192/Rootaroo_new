import { webcrypto, pbkdf2Sync } from 'node:crypto';

if (!globalThis.crypto?.subtle) globalThis.crypto = webcrypto;

const { generateAccountKeyPair } = require('../accountKey');
const {
  ARGON2_PARAMS, MIN_PASSWORD_LENGTH, generateRecoveryCode, normalizeSecret, createBackup, deriveBackupKeys, openBackup,
} = require('../keyBackup');

// Node has no Argon2id; tests inject a cheap stand-in with the same shape (secret, salt, params) -> 64 bytes.
const fakeKdf = jest.fn(async (secret, salt, params) => new Uint8Array(pbkdf2Sync(secret, Buffer.from(salt), 10, params.length, 'sha256')));

beforeEach(() => jest.clearAllMocks());

describe('backup settings', () => {
  it('uses Argon2id at the OWASP minimum and a 6-character minimum password', () => {
    expect(ARGON2_PARAMS).toEqual({ algorithm: 'argon2id', memoryKiB: 19456, iterations: 2, parallelism: 1, length: 64 });
    expect(MIN_PASSWORD_LENGTH).toBe(6);
  });
});

describe('recovery code', () => {
  it('is 24 characters from an unambiguous alphabet, shown in groups of 4', () => {
    const code = generateRecoveryCode();
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){5}$/);
    expect(generateRecoveryCode()).not.toBe(code);
  });

  it('typing it with spaces, lowercase or without dashes still works', () => {
    expect(normalizeSecret('abcd efgh-JKLM', 'recovery_code')).toBe('ABCDEFGHJKLM');
    expect(normalizeSecret('  Biscuit ', 'password')).toBe('  Biscuit ');
  });
});

describe('backup and restore', () => {
  it('the backup opens with the right password and gives the same account key back', async () => {
    const account = await generateAccountKeyPair();
    const backup = await createBackup({ secret: 'Biscuit', kind: 'password', accountKey: account, kdf: fakeKdf });
    expect(backup).toEqual({
      kind: 'password', salt: expect.any(String), kdf: ARGON2_PARAMS, authKey: expect.any(String), blob: expect.any(String),
    });
    expect(Buffer.from(backup.salt, 'base64')).toHaveLength(16);
    const restored = await openBackup({ secret: 'Biscuit', kind: 'password', salt: backup.salt, kdf: backup.kdf, blob: backup.blob, kdfFn: fakeKdf });
    expect(restored).toEqual(account);
  });

  it('the server proof and the decryption key are different, so the server learns nothing that opens the blob', async () => {
    const { authKey, encKey } = await deriveBackupKeys('Biscuit', Buffer.alloc(16, 1).toString('base64'), ARGON2_PARAMS, fakeKdf);
    expect(authKey).not.toBe(encKey);
    expect(Buffer.from(authKey, 'base64')).toHaveLength(32);
  });

  it('the same password and salt always give the same proof (so the server can check it)', async () => {
    const salt = Buffer.alloc(16, 2).toString('base64');
    const a = await deriveBackupKeys('Biscuit', salt, ARGON2_PARAMS, fakeKdf);
    const b = await deriveBackupKeys('Biscuit', salt, ARGON2_PARAMS, fakeKdf);
    expect(a.authKey).toBe(b.authKey);
  });

  it('a wrong password fails', async () => {
    const account = await generateAccountKeyPair();
    const backup = await createBackup({ secret: 'Biscuit', kind: 'password', accountKey: account, kdf: fakeKdf });
    await expect(openBackup({ secret: 'biscuit', kind: 'password', salt: backup.salt, kdf: backup.kdf, blob: backup.blob, kdfFn: fakeKdf })).rejects.toThrow();
  });

  it('refuses passwords shorter than 6 characters', async () => {
    const account = await generateAccountKeyPair();
    await expect(createBackup({ secret: 'Rex', kind: 'password', accountKey: account, kdf: fakeKdf })).rejects.toThrow('at least 6');
  });

  it('a recovery code works however it is typed', async () => {
    const account = await generateAccountKeyPair();
    const code = generateRecoveryCode();
    const backup = await createBackup({ secret: code, kind: 'recovery_code', accountKey: account, kdf: fakeKdf });
    const typed = code.toLowerCase().replace(/-/g, ' ');
    const restored = await openBackup({ secret: typed, kind: 'recovery_code', salt: backup.salt, kdf: backup.kdf, blob: backup.blob, kdfFn: fakeKdf });
    expect(restored).toEqual(account);
  });

  it('passes the stored Argon2 settings to the key derivation, so they can be raised later', async () => {
    const account = await generateAccountKeyPair();
    const backup = await createBackup({ secret: 'Biscuit', kind: 'password', accountKey: account, kdf: fakeKdf });
    const stronger = { ...backup.kdf, iterations: 3 };
    await openBackup({ secret: 'Biscuit', kind: 'password', salt: backup.salt, kdf: stronger, blob: backup.blob, kdfFn: fakeKdf }).catch(() => {});
    expect(fakeKdf).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), stronger);
  });
});
