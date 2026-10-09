/**
 * Key Transfer — move the account key from an old phone to a new one
 * (docs/e2e/device-transfer.md, "Transfer to a new phone").
 *
 * Threat model: the relay server is untrusted and may swap keys. Protection:
 *   - The new phone shows a QR with a random secret the server never sees.
 *   - Both phones derive a shared secret from ephemeral X25519 keys and mix in
 *     that QR secret, so a relay that did not see the QR cannot read the key.
 *   - Both phones show the same 6-digit code derived the same way; the user
 *     confirms they match, which catches a swapped ephemeral key.
 *   - The new phone checks the received key matches the account's public key.
 */

import { base64ToBytes, bytesToBase64, concat, fromUtf8, randomBytes, utf8 } from './bytes';
import {
  aesDecrypt, aesEncrypt, aesKeyFromBytes, generateX25519, hkdf, publicKeyFromPrivate, x25519,
} from './primitives';

const SAS_INFO = utf8('rootaroo-transfer-sas-v1');
const KEY_INFO = utf8('rootaroo-transfer-v1');
const SECRET_BYTES = 16;

/** Start on the new phone: make the ephemeral key + secret and open a relay session. */
export async function startOnNewPhone({ api }) {
  const eph = await generateX25519();
  const secret = bytesToBase64(randomBytes(SECRET_BYTES));
  // The secret is only ever in the QR, never sent to the server.
  const { sessionId } = await api.createSession({ ephemeralPublicKey: eph.publicKey });
  return {
    sessionId,
    qr: JSON.stringify({ v: 1, sessionId, ephemeralPublicKey: eph.publicKey, secret }),
    state: { sessionId, ephemeralPublicKey: eph.publicKey, privateKey: eph.privateKey, secret },
  };
}

export function parseTransferQr(str) {
  const notOurs = () => new Error('This is not a Rootaroo transfer code');
  let data;
  try {
    data = JSON.parse(str);
  } catch {
    throw notOurs();
  }
  const ok = data && data.v === 1
    && ['sessionId', 'ephemeralPublicKey', 'secret'].every((f) => typeof data[f] === 'string' && data[f]);
  if (!ok) throw notOurs();
  const { v, sessionId, ephemeralPublicKey, secret } = data;
  return { v, sessionId, ephemeralPublicKey, secret };
}

/** 6-digit code from the first 4 bytes of HKDF output. */
async function sasCode(shared, secretB64) {
  const out = await hkdf(shared, base64ToBytes(secretB64), SAS_INFO, 4);
  const n = new DataView(out.buffer).getUint32(0, false);
  return String(n % 1_000_000).padStart(6, '0');
}

async function transferKey(shared, secretB64, sessionId) {
  const raw = await hkdf(shared, base64ToBytes(secretB64), concat(KEY_INFO, utf8(sessionId)), 32);
  const key = await aesKeyFromBytes(raw);
  raw.fill(0);
  return key;
}

/** Old phone: verify the relay's key against the QR, compute the code, return a send() action. */
export async function prepareOnOldPhone({ qr, api, accountKey }) {
  const session = await api.getSession(qr.sessionId);
  if (session.newEphemeralPublicKey !== qr.ephemeralPublicKey) {
    throw new Error('This code does not match the one on your new phone');
  }
  const eph = await generateX25519();
  const shared = await x25519(eph.privateKey, qr.ephemeralPublicKey);
  const code = await sasCode(shared, qr.secret);
  const key = await transferKey(shared, qr.secret, qr.sessionId);
  shared.fill(0);

  const send = async () => {
    const sealed = await aesEncrypt(key, utf8(JSON.stringify(accountKey)), utf8(qr.sessionId));
    return api.sendPayload(qr.sessionId, { ephemeralPublicKey: eph.publicKey, sealed: bytesToBase64(sealed) });
  };
  return { code, send };
}

/** New phone: the same 6-digit code, from its own ephemeral private key. */
export async function codeOnNewPhone(state, oldEphemeralPublicKey) {
  const shared = await x25519(state.privateKey, oldEphemeralPublicKey);
  const code = await sasCode(shared, state.secret);
  shared.fill(0);
  return code;
}

/** New phone: decrypt the payload and check it is really this account's key. */
export async function receiveOnNewPhone(state, { ephemeralPublicKey, sealed }, expectedPublicKey) {
  const mismatch = () => new Error('The key received does not match your account');
  const shared = await x25519(state.privateKey, ephemeralPublicKey);
  const key = await transferKey(shared, state.secret, state.sessionId);
  shared.fill(0);
  const plain = await aesDecrypt(key, base64ToBytes(sealed), utf8(state.sessionId));
  let accountKey;
  try {
    accountKey = JSON.parse(fromUtf8(plain));
  } finally {
    plain.fill(0);
  }
  if (!accountKey || accountKey.publicKey !== expectedPublicKey) throw mismatch();
  let derived;
  try {
    derived = await publicKeyFromPrivate(accountKey.privateKey);
  } catch {
    throw mismatch();
  }
  if (derived !== expectedPublicKey) throw mismatch();
  return { publicKey: accountKey.publicKey, privateKey: accountKey.privateKey };
}
