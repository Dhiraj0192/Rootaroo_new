/**
 * The vault as the screens see it: real names in, real names out. Everything
 * sent to the server is ciphertext (file, name, type) plus per-person sealed
 * keys. Household files are sealed to everyone in the household (children
 * included) whose key we trust.
 */

import { bytesToBase64 } from '../crypto/bytes';
import {
  checkMemberKeys, decryptFile, decryptMeta, encryptFile, encryptMeta, grantAccess, openFileKey, sealFileKeyTo,
} from './vaultSharing';

export const UNREADABLE_NAME = "Can't open this file";
export const PENDING_NAME = "Waiting for a family member's phone";
const TEMP_FILE_LIFETIME_MS = 60000;
const KEY_GRACE_MS = 60000;
const PREVIEW_MAX_BYTES = 8 * 1024 * 1024;

export class VaultKeyMissingError extends Error {
  constructor() {
    super('Your private space is not on this phone.');
    this.name = 'VaultKeyMissingError';
    this.code = 'vault_key_missing';
  }
}

/** Thrown before sharing when a member's key is not the one we pinned. */
export class MemberKeyChangedError extends Error {
  constructor(members) {
    super(`${members.map((m) => m.displayName).join(', ')} has a new key. Compare safety numbers in person before sharing.`);
    this.name = 'MemberKeyChangedError';
    this.code = 'member_key_changed';
    this.members = members;
  }
}

export const isKeyMissing = (e) => e?.code === 'vault_key_missing';
export const isMemberKeyChanged = (e) => e?.code === 'member_key_changed';

/** fileKey and downloadUrl stay off the enumerable fields so route params and logs never carry them. */
function hidden(doc, extras) {
  for (const [k, v] of Object.entries(extras)) Object.defineProperty(doc, k, { value: v, enumerable: false });
  return doc;
}

const extensionOf = (name) => (name.includes('.') ? name.split('.').pop().slice(0, 8) : 'bin');

export function createVaultRepo({
  api, loadKey, getUserId, readBytes, fetchBytes, writeTemp, deleteTemp, pins, onKeyMissing,
}) {
  let keyPair = null;
  let backgroundedAt = null;

  async function getKeys() {
    if (keyPair) return keyPair;
    const keys = await loadKey();
    if (!keys?.privateKey || !keys?.publicKey) {
      onKeyMissing?.();
      throw new VaultKeyMissingError();
    }
    keyPair = keys;
    return keys;
  }

  // Decrypted image previews, memory only (never written to disk), dropped on lock.
  const previews = new Map();
  const clear = () => { keyPair = null; previews.clear(); };
  const hasKeys = () => keyPair !== null;
  /** Hand over a key the screen already unlocked, so loading the list doesn't prompt again. */
  const prime = (keys) => { if (keys?.privateKey && keys?.publicKey) keyPair = keys; };

  async function describe(raw, keys) {
    const base = {
      id: raw.id,
      scope: raw.scope,
      sizeBytes: raw.sizeBytes,
      createdAt: raw.createdAt,
      uploadedBy: raw.uploadedBy,
      mine: !!raw.uploadedBy && raw.uploadedBy.id === getUserId(),
    };
    if (!raw.mySealedKey) {
      return { ...base, name: PENDING_NAME, mimeType: '', pending: true, unreadable: false };
    }
    try {
      const fileKey = await openFileKey(raw.mySealedKey, keys.privateKey);
      const meta = await decryptMeta(raw.sealedMeta, fileKey);
      return hidden({ ...base, ...meta, pending: false, unreadable: false }, { fileKey, downloadUrl: raw.downloadUrl });
    } catch {
      return { ...base, name: UNREADABLE_NAME, mimeType: '', pending: false, unreadable: true };
    }
  }

  /** Household members we may seal to, with my own key added, or a MemberKeyChangedError. */
  async function memberRecipients(keys) {
    const me = getUserId();
    const others = (await api.members()).filter((m) => m.userId !== me);
    const { trusted, changed } = await checkMemberKeys(others, pins);
    if (changed.length) throw new MemberKeyChangedError(others.filter((m) => changed.includes(m.userId)));
    return [
      { userId: me, publicKey: keys.publicKey },
      ...others.filter((m) => trusted.includes(m.userId)).map((m) => ({ userId: m.userId, publicKey: m.publicKey })),
    ];
  }

  async function fileKeyFor(doc, keys) {
    if (doc.fileKey) return doc.fileKey;
    const raw = await api.get(doc.id);
    if (!raw.mySealedKey) throw new Error('This file is not on your phone yet.');
    return openFileKey(raw.mySealedKey, keys.privateKey);
  }

  return {
    clear,
    hasKeys,
    prime,

    /** A data URI for an image file's thumbnail, or null (not an image, too big, or not readable here). */
    async preview(doc) {
      if (!doc?.mimeType?.startsWith('image/') || !doc.fileKey) return null;
      if (doc.sizeBytes > PREVIEW_MAX_BYTES) return null;
      if (previews.has(doc.id)) return previews.get(doc.id);
      // A just-uploaded file has no signed link yet; ask for one.
      const url = doc.downloadUrl || (await api.get(doc.id)).downloadUrl;
      if (!url) return null;
      const plain = await decryptFile(await fetchBytes(url), doc.fileKey);
      const uri = `data:${doc.mimeType};base64,${bytesToBase64(plain)}`;
      if (keyPair) previews.set(doc.id, uri); // locked meanwhile: don't keep it
      return uri;
    },

    onAppStateChange(next, now = Date.now()) {
      if (next === 'background') {
        if (backgroundedAt === null) backgroundedAt = now;
      } else if (next === 'active') {
        if (backgroundedAt !== null && now - backgroundedAt >= KEY_GRACE_MS) clear();
        backgroundedAt = null;
      }
    },

    async upload({ bytes: pickedBytes, uri, name, mimeType, scope }) {
      const keys = await getKeys();
      const recipients = scope === 'household'
        ? await memberRecipients(keys)
        : [{ userId: getUserId(), publicKey: keys.publicKey }];
      const bytes = pickedBytes || (await readBytes(uri));
      const sealed = await encryptFile({ bytes, name, mimeType }, recipients);
      const raw = await api.upload({
        blob: sealed.blob,
        meta: {
          scope, sealedMeta: sealed.sealedMeta, sizeBytes: sealed.blob.length, keys: sealed.keys,
        },
      });
      sealed.fileKey.fill(0);
      return describe({ ...raw, sizeBytes: raw.sizeBytes ?? sealed.blob.length, mySealedKey: sealed.keys.find((k) => k.userId === getUserId())?.sealedKey, sealedMeta: sealed.sealedMeta }, keys);
    },

    async list(params) {
      const keys = await getKeys();
      const page = await api.list(params);
      return {
        documents: await Promise.all(page.documents.map((raw) => describe(raw, keys))),
        nextCursor: page.nextCursor ?? null,
      };
    },

    async get(id) {
      const keys = await getKeys();
      return describe(await api.get(id), keys);
    },

    /** In memory by default; a temp file (deleted after a minute) only with { asFile: true }. */
    async open(docOrId, { asFile = false } = {}) {
      const keys = await getKeys();
      const id = typeof docOrId === 'string' ? docOrId : docOrId.id;
      const raw = await api.get(id);
      const doc = await describe(raw, keys);
      if (doc.pending || doc.unreadable || !raw.downloadUrl) throw new Error(doc.pending ? PENDING_NAME : UNREADABLE_NAME);
      const plain = await decryptFile(await fetchBytes(raw.downloadUrl), doc.fileKey);
      if (!asFile) return { doc, dataUri: `data:${doc.mimeType};base64,${bytesToBase64(plain)}` };
      const uri = await writeTemp(plain, extensionOf(doc.name));
      setTimeout(() => { Promise.resolve(deleteTemp(uri)).catch(() => {}); }, TEMP_FILE_LIFETIME_MS);
      return { doc, uri };
    },

    async setScope(doc, scope) {
      if (scope === 'personal') {
        await api.setScope(doc.id, { scope });
        return;
      }
      const keys = await getKeys();
      const recipients = await memberRecipients(keys);
      const fileKey = await fileKeyFor(doc, keys);
      await api.setScope(doc.id, { scope, keys: await sealFileKeyTo(recipients, fileKey) });
    },

    async rename(doc, newName) {
      const keys = await getKeys();
      const fileKey = await fileKeyFor(doc, keys);
      const raw = await api.get(doc.id);
      const { mimeType } = await decryptMeta(raw.sealedMeta, fileKey);
      await api.rename(doc.id, { sealedMeta: await encryptMeta({ name: newName, mimeType }, fileKey) });
    },

    /** Gives newly joined members access to files I can open. Skips changed keys; returns their ids. */
    async grantPending() {
      const keys = await getKeys();
      const pending = await api.pendingGrants();
      if (!pending.length) return { granted: 0, changed: [] };
      const everyone = new Map();
      for (const p of pending) for (const m of p.missing) everyone.set(m.userId, m);
      const { trusted, changed } = await checkMemberKeys([...everyone.values()], pins);
      let granted = 0;
      for (const p of pending) {
        const missing = p.missing.filter((m) => trusted.includes(m.userId));
        if (!missing.length) continue;
        const grants = await grantAccess({ documentId: p.documentId, mySealedKey: p.mySealedKey, missing }, keys.privateKey);
        await api.grant(p.documentId, grants);
        granted += grants.length;
      }
      return { granted, changed };
    },

    /** Members whose key differs from the one we pinned, for the warning banner. */
    async memberKeyStatus() {
      const me = getUserId();
      const others = (await api.members()).filter((m) => m.userId !== me);
      const { changed } = await checkMemberKeys(others, pins);
      const out = [];
      for (const m of others.filter((x) => changed.includes(x.userId))) {
        out.push({
          userId: m.userId, displayName: m.displayName, publicKey: m.publicKey, pinnedKey: await pins.get(m.userId),
        });
      }
      return { changed: out };
    },

    /** Only after the user compared safety numbers in person. */
    confirmMemberKey: (userId, publicKey) => pins.set(userId, publicKey),

    remove: (id) => api.remove(id),
  };
}

// ─── App wiring ──────────────────────────────────────────────────────────────

let instance = null;

export const peekVaultRepo = () => instance;

/** Built on first use so importing this file never loads native modules. */
export function getVaultRepo() {
  if (!instance) {
    const { vaultApi } = require('../api/vault');
    const { loadAccountPrivateKey } = require('../crypto/accountKey');
    const { useAuthStore } = require('../store/authStore');
    const { usePrivateSpaceStore } = require('../store/privateSpaceStore');
    const device = require('./vaultDevice');
    const { getPublicKeyPin, pinPublicKey } = require('../crypto/keyPinStore');
    instance = createVaultRepo({
      api: {
        ...vaultApi,
        upload: ({ blob, meta }) => device.uploadCiphertext(blob, meta),
      },
      loadKey: () => loadAccountPrivateKey(useAuthStore.getState().user?.id),
      getUserId: () => useAuthStore.getState().user?.id,
      onKeyMissing: () => usePrivateSpaceStore.getState().refresh(),
      pins: { get: getPublicKeyPin, set: pinPublicKey },
      readBytes: device.readBytes,
      fetchBytes: device.fetchBytes,
      writeTemp: device.writeTemp,
      deleteTemp: device.deleteTemp,
    });
  }
  return instance;
}
