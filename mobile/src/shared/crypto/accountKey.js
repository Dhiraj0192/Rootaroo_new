/**
 * Account Key — the per-user X25519 key pair behind end-to-end encrypted
 * private data (see docs/e2e/device-transfer.md, "Keys").
 *
 * Threat model: the server never sees the private key. Anyone can seal data
 * to the public key; only the holder of the private key can open it.
 *
 * Sealed format (a single-recipient "sealed box"):
 *   e_pk (32) ‖ nonce (12) ‖ AES-256-GCM ciphertext+tag
 *   k = HKDF-SHA256(X25519(e_sk, pk), salt = e_pk ‖ pk, info = 'rootaroo-seal-v1')
 * A fresh ephemeral key per seal means sealing the same data twice differs.
 *
 * The private key lives in SecureStore behind biometrics/device credentials.
 */

import * as SecureStore from 'expo-secure-store';
import { base64ToBytes, bytesToBase64, bytesToBase64url, concat, utf8 } from './bytes';
import {
  NONCE_BYTES, aesDecrypt, aesEncrypt, aesKeyFromBytes, generateX25519, hkdf, publicKeyFromPrivate, x25519,
} from './primitives';

const SEAL_INFO = utf8('rootaroo-seal-v1');
const PK_BYTES = 32;

export const generateAccountKeyPair = generateX25519;

async function sealKey(shared, ephemeralPk, recipientPk) {
  const raw = await hkdf(shared, concat(ephemeralPk, recipientPk), SEAL_INFO, 32);
  const key = await aesKeyFromBytes(raw);
  raw.fill(0);
  return key;
}

/** Encrypt `bytes` so only the holder of the matching private key can read it. */
export async function seal(publicKeyB64, bytes) {
  const eph = await generateX25519();
  const ephPk = base64ToBytes(eph.publicKey);
  const shared = await x25519(eph.privateKey, publicKeyB64);
  const key = await sealKey(shared, ephPk, base64ToBytes(publicKeyB64));
  shared.fill(0);
  return concat(ephPk, await aesEncrypt(key, bytes));
}

/** Decrypt output of seal(). Throws if the key is wrong or any byte was changed. */
export async function open(privateKeyB64, sealed) {
  if (sealed.length < PK_BYTES + NONCE_BYTES + 16) throw new Error('Sealed data too short');
  const ephPk = sealed.slice(0, PK_BYTES);
  const myPk = base64ToBytes(await publicKeyFromPrivate(privateKeyB64));
  const shared = await x25519(privateKeyB64, bytesToBase64(ephPk));
  const key = await sealKey(shared, ephPk, myPk);
  shared.fill(0);
  return aesDecrypt(key, sealed.slice(PK_BYTES));
}

/** Short comparable fingerprint: SHA-256(raw pk)[0..12] as base64url, 4 groups of 4. */
export async function fingerprint(publicKeyB64) {
  const hash = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', base64ToBytes(publicKeyB64)));
  return bytesToBase64url(hash.slice(0, 12)).match(/.{4}/g).join(' ');
}

// ─── Storage ─────────────────────────────────────────────────────────────────

const STORE_OPTIONS = { requireAuthentication: true, authenticationPrompt: 'Unlock your private space' };

export const accountKeyStorageKey = (userId) => `account_key_${userId}`;

export async function saveAccountKey(userId, { publicKey, privateKey }) {
  await SecureStore.setItemAsync(
    accountKeyStorageKey(userId),
    JSON.stringify({ publicKey, privateKey }),
    STORE_OPTIONS,
  );
}

/** Returns { publicKey, privateKey } (prompts for biometrics) or null if none stored. */
export async function loadAccountPrivateKey(userId) {
  const raw = await SecureStore.getItemAsync(accountKeyStorageKey(userId), STORE_OPTIONS);
  return raw ? JSON.parse(raw) : null;
}

export async function deleteAccountKey(userId) {
  await SecureStore.deleteItemAsync(accountKeyStorageKey(userId));
}
