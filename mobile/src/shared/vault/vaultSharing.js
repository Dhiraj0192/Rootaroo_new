/**
 * Vault file crypto with per-person key sharing.
 *
 * Each file gets a fresh AES-256-GCM key. The file key is sealed (accountKey.seal)
 * to every adult who may open the file, so the server only holds ciphertext, an
 * encrypted name/type and one sealed copy of the key per person.
 *
 * File blob:  nonce (12) ‖ AES-GCM(fileKey, bytes, aad 'rootaroo-vault-v1')
 * Sealed meta: base64(nonce ‖ AES-GCM(fileKey, JSON { name, mimeType }, aad 'rootaroo-vault-meta-v1'))
 */

import { open, seal } from '../crypto/accountKey';
import { base64ToBytes, bytesToBase64, fromUtf8, randomBytes, utf8 } from '../crypto/bytes';
import { aesDecrypt, aesEncrypt, aesKeyFromBytes } from '../crypto/primitives';

const FILE_AAD = utf8('rootaroo-vault-v1');
const META_AAD = utf8('rootaroo-vault-meta-v1');

const sealFileKey = async (publicKey, fileKey) => bytesToBase64(await seal(publicKey, fileKey));

export async function encryptMeta({ name, mimeType }, fileKey) {
  const key = await aesKeyFromBytes(fileKey);
  return bytesToBase64(await aesEncrypt(key, utf8(JSON.stringify({ name, mimeType })), META_AAD));
}

export async function decryptMeta(sealedMeta, fileKey) {
  const key = await aesKeyFromBytes(fileKey);
  const { name, mimeType } = JSON.parse(fromUtf8(await aesDecrypt(key, base64ToBytes(sealedMeta), META_AAD)));
  return { name, mimeType };
}

export async function sealFileKeyTo(recipients, fileKey) {
  const keys = [];
  for (const { userId, publicKey } of recipients) keys.push({ userId, sealedKey: await sealFileKey(publicKey, fileKey) });
  return keys;
}

export async function encryptFile({ bytes, name, mimeType }, recipients) {
  const fileKey = randomBytes(32);
  const key = await aesKeyFromBytes(fileKey);
  const blob = await aesEncrypt(key, bytes, FILE_AAD);
  const sealedMeta = await encryptMeta({ name, mimeType }, fileKey);
  return { blob, sealedMeta, keys: await sealFileKeyTo(recipients, fileKey), fileKey };
}

export const openFileKey = (sealedKeyB64, privateKey) => open(privateKey, base64ToBytes(sealedKeyB64));

export async function decryptFile(blob, fileKey) {
  return aesDecrypt(await aesKeyFromBytes(fileKey), blob, FILE_AAD);
}

/** Seals my copy of the file key to people who do not have one yet. */
export async function grantAccess({ mySealedKey, missing }, privateKey) {
  const fileKey = await openFileKey(mySealedKey, privateKey);
  const grants = [];
  for (const { userId, publicKey } of missing) {
    grants.push({ userId, sealedKey: await sealFileKey(publicKey, fileKey) });
  }
  return grants;
}

function defaultPins() {
  const { getPublicKeyPin, pinPublicKey } = require('../crypto/keyPinStore');
  return { get: getPublicKeyPin, set: pinPublicKey };
}

/** First sight pins a key; a different key later is reported as changed and the pin is left alone. */
export async function checkMemberKeys(members, pins = defaultPins()) {
  const trusted = [];
  const changed = [];
  for (const { userId, publicKey } of members) {
    const pinned = await pins.get(userId);
    if (!pinned) {
      await pins.set(userId, publicKey);
      trusted.push(userId);
    } else if (pinned === publicKey) {
      trusted.push(userId);
    } else {
      changed.push(userId);
    }
  }
  return { trusted, changed };
}
