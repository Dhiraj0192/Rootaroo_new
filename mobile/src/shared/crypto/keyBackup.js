/**
 * Key Backup — password / recovery-code backup of the account key
 * (docs/e2e/device-transfer.md, "Backup and recovery").
 *
 * Threat model: the server stores the backup blob and checks a proof, but must
 * never be able to open the blob.
 *   stretched = Argon2id(secret, salt)                           (64 bytes, memory-hard)
 *   authKey   = HKDF(stretched, info 'rootaroo-backup-auth-v1')  -> sent to server
 *   encKey    = HKDF(stretched, info 'rootaroo-backup-enc-v1')   -> never leaves device
 *   blob      = nonce ‖ AES-256-GCM(encKey, JSON(accountKey))
 * Argon2 parameters are stored with the backup so they can be raised later.
 */

import { base64ToBytes, bytesToBase64, fromUtf8, randomBytes, utf8 } from './bytes';
import { aesDecrypt, aesEncrypt, aesKeyFromBytes, hkdf } from './primitives';

export const ARGON2_PARAMS = {
  algorithm: 'argon2id', memoryKiB: 19456, iterations: 2, parallelism: 1, length: 64,
};
export const MIN_PASSWORD_LENGTH = 6;

const SALT_BYTES = 16;
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 chars, no 0/O/1/I
const RECOVERY_LENGTH = 24;

/** 24 random characters as XXXX-XXXX-XXXX-XXXX-XXXX-XXXX. */
export function generateRecoveryCode() {
  const chars = [];
  // Rejection sampling: only bytes below the largest multiple of the alphabet
  // size are used, so every character is equally likely (no modulo bias).
  const limit = 256 - (256 % RECOVERY_ALPHABET.length);
  while (chars.length < RECOVERY_LENGTH) {
    const buf = randomBytes(RECOVERY_LENGTH);
    for (const b of buf) {
      if (b < limit && chars.length < RECOVERY_LENGTH) chars.push(RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]);
    }
    buf.fill(0);
  }
  return chars.join('').match(/.{4}/g).join('-');
}

export function normalizeSecret(secret, kind) {
  return kind === 'recovery_code' ? secret.toUpperCase().replace(/[\s-]/g, '') : secret;
}

/**
 * Default Argon2id via react-native-quick-crypto's `argon2(algorithm, params, cb)`.
 * Required lazily so Node tests that inject their own kdf never load the native module.
 */
export async function defaultKdf(secretBytes, saltBytes, params) {
  const { argon2 } = require('react-native-quick-crypto');
  const out = await new Promise((resolve, reject) => {
    argon2(
      params.algorithm,
      {
        message: secretBytes,
        nonce: saltBytes,
        parallelism: params.parallelism,
        tagLength: params.length,
        memory: params.memoryKiB,
        passes: params.iterations,
      },
      (err, result) => (err ? reject(err) : resolve(result)),
    );
  });
  return new Uint8Array(out);
}

export async function deriveBackupKeys(secret, saltB64, params, kdf = defaultKdf) {
  const secretBytes = utf8(secret);
  const stretched = await kdf(secretBytes, base64ToBytes(saltB64), params);
  secretBytes.fill(0);
  const empty = new Uint8Array(0);
  const auth = await hkdf(stretched, empty, utf8('rootaroo-backup-auth-v1'), 32);
  const enc = await hkdf(stretched, empty, utf8('rootaroo-backup-enc-v1'), 32);
  stretched.fill(0);
  const keys = { authKey: bytesToBase64(auth), encKey: bytesToBase64(enc) };
  auth.fill(0);
  enc.fill(0);
  return keys;
}

async function encKeyFrom(encKeyB64) {
  const raw = base64ToBytes(encKeyB64);
  const key = await aesKeyFromBytes(raw);
  raw.fill(0);
  return key;
}

export async function createBackup({ secret, kind, accountKey, kdf = defaultKdf }) {
  if (kind === 'password' && secret.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Use at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  const salt = bytesToBase64(randomBytes(SALT_BYTES));
  const { authKey, encKey } = await deriveBackupKeys(normalizeSecret(secret, kind), salt, ARGON2_PARAMS, kdf);
  const blob = await aesEncrypt(await encKeyFrom(encKey), utf8(JSON.stringify(accountKey)));
  return { kind, salt, kdf: ARGON2_PARAMS, authKey, blob: bytesToBase64(blob) };
}

export async function openBackup({ secret, kind, salt, kdf, blob, kdfFn = defaultKdf }) {
  const { encKey } = await deriveBackupKeys(normalizeSecret(secret, kind), salt, kdf, kdfFn);
  const plain = await aesDecrypt(await encKeyFrom(encKey), base64ToBytes(blob));
  try {
    return JSON.parse(fromUtf8(plain));
  } finally {
    plain.fill(0);
  }
}
