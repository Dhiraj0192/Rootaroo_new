/**
 * Small WebCrypto wrappers used by accountKey, keyTransfer and keyBackup.
 *
 * Everything here is a thin call into `globalThis.crypto.subtle`
 * (react-native-quick-crypto on device, Node webcrypto in tests): X25519,
 * HKDF-SHA256 and AES-256-GCM. No custom cryptography.
 */

import { base64ToBytes, bytesToBase64, concat, randomBytes } from './bytes';

export const NONCE_BYTES = 12;

const subtle = () => globalThis.crypto.subtle;

/** HKDF-SHA256 -> `length` bytes. */
export async function hkdf(ikm, salt, info, length = 32) {
  const key = await subtle().importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

/** Import raw bytes as a non-extractable AES-256-GCM key. */
export function aesKeyFromBytes(bytes) {
  return subtle().importKey('raw', bytes, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** Returns nonce ‖ ciphertext+tag. */
export async function aesEncrypt(key, plaintext, additionalData) {
  const nonce = randomBytes(NONCE_BYTES);
  const params = { name: 'AES-GCM', iv: nonce, tagLength: 128 };
  if (additionalData) params.additionalData = additionalData;
  const ct = new Uint8Array(await subtle().encrypt(params, key, plaintext));
  return concat(nonce, ct);
}

/** Inverse of aesEncrypt. Throws if the key, data or tag is wrong. */
export async function aesDecrypt(key, nonceAndCiphertext, additionalData) {
  if (nonceAndCiphertext.length < NONCE_BYTES + 16) throw new Error('Ciphertext too short');
  const params = { name: 'AES-GCM', iv: nonceAndCiphertext.slice(0, NONCE_BYTES), tagLength: 128 };
  if (additionalData) params.additionalData = additionalData;
  return new Uint8Array(await subtle().decrypt(params, key, nonceAndCiphertext.slice(NONCE_BYTES)));
}

/** New extractable X25519 pair -> { publicKey: raw b64, privateKey: pkcs8 b64 }. */
export async function generateX25519() {
  const pair = await subtle().generateKey({ name: 'X25519' }, true, ['deriveBits']);
  const pub = new Uint8Array(await subtle().exportKey('raw', pair.publicKey));
  const priv = new Uint8Array(await subtle().exportKey('pkcs8', pair.privateKey));
  const result = { publicKey: bytesToBase64(pub), privateKey: bytesToBase64(priv) };
  priv.fill(0);
  return result;
}

/** Raw public key (b64) belonging to a pkcs8 private key (b64). */
export async function publicKeyFromPrivate(privateKeyB64) {
  const pkcs8 = base64ToBytes(privateKeyB64);
  const key = await subtle().importKey('pkcs8', pkcs8, { name: 'X25519' }, true, ['deriveBits']);
  pkcs8.fill(0);
  const jwk = await subtle().exportKey('jwk', key);
  return bytesToBase64(base64ToBytes(jwk.x));
}

/** X25519 shared secret (32 bytes). The caller should fill(0) it when done. */
export async function x25519(privateKeyB64, publicKeyB64) {
  const pkcs8 = base64ToBytes(privateKeyB64);
  const priv = await subtle().importKey('pkcs8', pkcs8, { name: 'X25519' }, false, ['deriveBits']);
  pkcs8.fill(0);
  const pub = await subtle().importKey('raw', base64ToBytes(publicKeyB64), { name: 'X25519' }, false, []);
  return new Uint8Array(await subtle().deriveBits({ name: 'X25519', public: pub }, priv, 256));
}
