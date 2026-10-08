/**
 * Tests for the vault's file encryption (AES-256-GCM). Key sealing to the
 * account key is covered in accountKey.test.js.
 */

import { webcrypto } from 'node:crypto';

// Polyfill WebCrypto for Node test environment
if (!globalThis.crypto) {
  globalThis.crypto = webcrypto;
}

import {
  generateAesKey,
  encryptBuffer,
  decryptFile,
  exportAesKey,
  importAesKey,
  AES_GCM_IV_BYTES,
} from '../vaultCrypto';

describe('IV uniqueness', () => {
  it('generates a unique IV for every encryption under the same key', async () => {
    const aesKey = await generateAesKey();
    const plaintext = new TextEncoder().encode('test payload').buffer;
    const ivs = new Set();

    for (let i = 0; i < 50; i++) {
      const { iv } = await encryptBuffer(aesKey, plaintext);
      expect(ivs.has(iv)).toBe(false);
      ivs.add(iv);
    }

    expect(ivs.size).toBe(50);
  });

  it('uses a 12-byte (96-bit) IV — the standard for AES-GCM', () => {
    expect(AES_GCM_IV_BYTES).toBe(12);
  });
});

describe('file key export / import', () => {
  it('a key exported then imported decrypts what the original encrypted', async () => {
    const key = await generateAesKey();
    const plain = new TextEncoder().encode('passport scan').buffer;
    const { ciphertext, iv, authTag } = await encryptBuffer(key, plain);
    const imported = await importAesKey(await exportAesKey(key));
    const out = await decryptFile(imported, ciphertext, iv, authTag);
    expect(new TextDecoder().decode(out)).toBe('passport scan');
  });

  it('fails to decrypt with a different key', async () => {
    const { ciphertext, iv, authTag } = await encryptBuffer(await generateAesKey(), new Uint8Array(8).buffer);
    const other = await importAesKey(await exportAesKey(await generateAesKey()));
    await expect(decryptFile(other, ciphertext, iv, authTag)).rejects.toThrow();
  });
});
