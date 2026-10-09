/**
 * Byte helpers shared by the account-key, transfer and backup code.
 *
 * Pure JS on purpose: React Native does not guarantee Buffer, and these must
 * behave identically on device and under Node in tests.
 */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

/** Uint8Array -> standard base64 (with padding). */
export function bytesToBase64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? B64[n & 63] : '=';
  }
  return out;
}

/** Standard or url-safe base64 (padding optional) -> Uint8Array. Throws on bad input. */
export function base64ToBytes(b64) {
  const s = String(b64).replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  if (s.length % 4 === 1) throw new Error('Invalid base64');
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < s.length; i++) {
    const v = s.charCodeAt(i) < 128 ? B64_LOOKUP[s.charCodeAt(i)] : -1;
    if (v < 0) throw new Error('Invalid base64');
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}

/** Uint8Array -> base64url without padding. */
export function bytesToBase64url(bytes) {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function utf8(str) {
  return new TextEncoder().encode(str);
}

export function fromUtf8(bytes) {
  return new TextDecoder().decode(bytes);
}

/** Concatenate Uint8Arrays into a new one. */
export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function randomBytes(n) {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}
