/**
 * Journal encryption: every entry gets its own random key, sealed to the
 * account public key. Photos use the same entry key. Only the phone can read.
 */

import { base64ToBytes, bytesToBase64, fromUtf8, randomBytes, utf8 } from '../crypto/bytes';
import { aesDecrypt, aesEncrypt, aesKeyFromBytes } from '../crypto/primitives';
import { open, seal } from '../crypto/accountKey';

export const JOURNAL_FORMAT = 1;

const ENTRY_AAD = utf8('rootaroo-journal-v1');
const MEDIA_AAD = utf8('rootaroo-journal-media-v1');

export async function encryptEntry({ text, mood, tags }, accountPublicKey) {
  const entryKey = randomBytes(32);
  const key = await aesKeyFromBytes(entryKey);
  const plaintext = utf8(JSON.stringify({ v: JOURNAL_FORMAT, text, mood, tags }));
  const ciphertext = bytesToBase64(await aesEncrypt(key, plaintext, ENTRY_AAD));
  const sealedKey = bytesToBase64(await seal(accountPublicKey, entryKey));
  return { ciphertext, sealedKey, format: JOURNAL_FORMAT, entryKey };
}

export async function openEntryKey(sealedKeyB64, accountPrivateKey) {
  return open(accountPrivateKey, base64ToBytes(sealedKeyB64));
}

export async function decryptEntry({ ciphertext, sealedKey, format }, accountPrivateKey) {
  if (format !== JOURNAL_FORMAT) {
    throw new Error('This entry was written by a newer version of Rootaroo. Update the app to read it.');
  }
  const entryKey = await openEntryKey(sealedKey, accountPrivateKey);
  const key = await aesKeyFromBytes(entryKey);
  const plain = await aesDecrypt(key, base64ToBytes(ciphertext), ENTRY_AAD);
  const { text, mood, tags } = JSON.parse(fromUtf8(plain));
  return { text, mood, tags };
}

export async function encryptAttachment(bytes, entryKey) {
  return aesEncrypt(await aesKeyFromBytes(entryKey), bytes, MEDIA_AAD);
}

export async function decryptAttachment(sealedBytes, entryKey) {
  return aesDecrypt(await aesKeyFromBytes(entryKey), sealedBytes, MEDIA_AAD);
}
