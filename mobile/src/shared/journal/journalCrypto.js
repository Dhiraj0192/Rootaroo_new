/**
 * Journal encryption: every entry gets its own random key, sealed to the
 * account public key. Photos use the same entry key. Only the phone can read.
 *
 * The entry id is part of what is authenticated, for the body and for every
 * photo, so a ciphertext copied onto a different entry (or a photo moved to
 * another entry) fails to open instead of showing the wrong content.
 */

import { base64ToBytes, bytesToBase64, fromUtf8, randomBytes, utf8 } from '../crypto/bytes';
import { aesDecrypt, aesEncrypt, aesKeyFromBytes } from '../crypto/primitives';
import { open, seal } from '../crypto/accountKey';

export const JOURNAL_FORMAT = 1;

const entryAad = (entryId) => utf8(`rootaroo-journal-v1:${entryId}`);
const mediaAad = (entryId) => utf8(`rootaroo-journal-media-v1:${entryId}`);

function requireEntryId(entryId) {
  if (!entryId || typeof entryId !== 'string') throw new Error('An entry id is required to encrypt or decrypt a journal entry.');
  return entryId;
}

/** A random v4 uuid; the phone picks the id of every new entry because the ciphertext is bound to it. */
export function newEntryId() {
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Pass `existingEntryKey` when editing so photos already stored under that key stay readable. */
export async function encryptEntry({ text, mood, tags }, accountPublicKey, entryId, existingEntryKey) {
  requireEntryId(entryId);
  const entryKey = existingEntryKey || randomBytes(32);
  const key = await aesKeyFromBytes(entryKey);
  const plaintext = utf8(JSON.stringify({ v: JOURNAL_FORMAT, text, mood, tags }));
  const ciphertext = bytesToBase64(await aesEncrypt(key, plaintext, entryAad(entryId)));
  const sealedKey = bytesToBase64(await seal(accountPublicKey, entryKey));
  return { ciphertext, sealedKey, format: JOURNAL_FORMAT, entryKey };
}

export async function openEntryKey(sealedKeyB64, accountPrivateKey) {
  return open(accountPrivateKey, base64ToBytes(sealedKeyB64));
}

export async function decryptEntry({ id, ciphertext, sealedKey, format }, accountPrivateKey) {
  if (format !== JOURNAL_FORMAT) {
    throw new Error('This entry was written by a newer version of Rootaroo. Update the app to read it.');
  }
  requireEntryId(id);
  const entryKey = await openEntryKey(sealedKey, accountPrivateKey);
  const key = await aesKeyFromBytes(entryKey);
  const plain = await aesDecrypt(key, base64ToBytes(ciphertext), entryAad(id));
  const body = JSON.parse(fromUtf8(plain));
  if (body.v !== JOURNAL_FORMAT) throw new Error('Unsupported journal entry version.');
  const { text, mood, tags } = body;
  return { text, mood, tags };
}

export async function encryptAttachment(bytes, entryKey, entryId) {
  return aesEncrypt(await aesKeyFromBytes(entryKey), bytes, mediaAad(requireEntryId(entryId)));
}

export async function decryptAttachment(sealedBytes, entryKey, entryId) {
  return aesDecrypt(await aesKeyFromBytes(entryKey), sealedBytes, mediaAad(requireEntryId(entryId)));
}
