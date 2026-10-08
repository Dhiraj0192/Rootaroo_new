/**
 * Vault file encryption: AES-256-GCM, one fresh key per file.
 *
 * The per-file key is sealed to the account public key (accountKey.js), so the
 * server only ever holds ciphertext. IVs come from crypto.getRandomValues,
 * never counters or timestamps.
 */

const subtle = globalThis.crypto?.subtle;

// ─── Constants ───────────────────────────────────────────────────────────────

/** AES-GCM IV length in bytes. 96-bit (12 bytes) is the standard for GCM. */
export const AES_GCM_IV_BYTES = 12;

// ─── AES-GCM Key ─────────────────────────────────────────────────────────────

/**
 * Generate an AES-256-GCM symmetric key for file encryption.
 * The key is extractable so it can be wrapped for storage in VaultDocumentKey.
 */
export async function generateAesKey() {
  return subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}

/** Raw 32 bytes of a file key, for sealing it to the account public key. */
export async function exportAesKey(aesKey) {
  return new Uint8Array(await subtle.exportKey('raw', aesKey));
}

/** Non-extractable decrypt-only key from the raw bytes opened out of a sealed box. */
export async function importAesKey(rawBytes) {
  return subtle.importKey('raw', rawBytes, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
}

// ─── File Encryption / Decryption ────────────────────────────────────────────

/**
 * Encrypt a file Blob with AES-256-GCM.
 * IV is generated fresh for every call via crypto.getRandomValues — never reused.
 */
export async function encryptFile(aesKey, fileBlob) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
  const plaintext = await blobToArrayBuffer(fileBlob);

  const encrypted = await subtle.encrypt(
    { name: 'AES-GCM', iv, tagLength: 128 },
    aesKey,
    plaintext
  );

  const encryptedArray = new Uint8Array(encrypted);
  const authTag = encryptedArray.slice(encryptedArray.length - 16);
  const ciphertext = encryptedArray.slice(0, encryptedArray.length - 16);

  return {
    ciphertext: arrayBufferToBase64(ciphertext.buffer),
    iv: arrayBufferToBase64(iv.buffer),
    authTag: arrayBufferToBase64(authTag.buffer),
  };
}

/**
 * Encrypt an ArrayBuffer with AES-256-GCM.
 * Returns the EncryptResult plus the combined raw encrypted bytes for upload.
 * IV is generated fresh for every call via crypto.getRandomValues.
 */
export async function encryptBuffer(aesKey, plaintext) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));

  const encrypted = await subtle.encrypt(
    { name: 'AES-GCM', iv, tagLength: 128 },
    aesKey,
    plaintext
  );

  const encryptedArray = new Uint8Array(encrypted);
  const authTag = encryptedArray.slice(encryptedArray.length - 16);
  const ciphertext = encryptedArray.slice(0, encryptedArray.length - 16);

  return {
    ciphertext: arrayBufferToBase64(ciphertext.buffer),
    iv: arrayBufferToBase64(iv.buffer),
    authTag: arrayBufferToBase64(authTag.buffer),
    encryptedBytes: encrypted,
  };
}

/**
 * Decrypt a file with AES-256-GCM.
 * Returns the plaintext ArrayBuffer held in-memory only — NEVER written to
 * disk (FR-128). Deliberately not wrapped in a Blob: React Native's built-in
 * Blob implementation doesn't support constructing from an ArrayBuffer/
 * ArrayBufferView ("Creating blobs from 'ArrayBuffer' and 'ArrayBufferView'
 * are not supported"), and every caller immediately needed the raw bytes
 * back anyway.
 * Throws a DOMException if the auth tag is invalid (tampered ciphertext or wrong key).
 */
export async function decryptFile(aesKey, ciphertextB64, ivB64, authTagB64) {
  const ciphertext = base64ToArrayBuffer(ciphertextB64);
  const iv = base64ToArrayBuffer(ivB64);
  const authTag = base64ToArrayBuffer(authTagB64);

  // AES-GCM expects ciphertext || authTag concatenated
  const combined = new Uint8Array(ciphertext.byteLength + authTag.byteLength);
  combined.set(new Uint8Array(ciphertext), 0);
  combined.set(new Uint8Array(authTag), ciphertext.byteLength);

  return subtle.decrypt(
    { name: 'AES-GCM', iv, tagLength: 128 },
    aesKey,
    combined
  );
}

// ─── Utilities ───────────────────────────────────────────────────────────────

export function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

export async function blobToArrayBuffer(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsArrayBuffer(blob);
  });
}
