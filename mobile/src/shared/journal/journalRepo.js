/**
 * The journal as the screens see it: plain text in, plain text out. Everything
 * sent to the server is ciphertext; decryption and every stat that needs
 * content happen here, on the phone.
 */

import { bytesToBase64 } from '../crypto/bytes';
import {
  JOURNAL_FORMAT, decryptAttachment, decryptEntry, encryptAttachment, encryptEntry, newEntryId, openEntryKey,
} from './journalCrypto';
import { monthStats, onThisDay } from './journalStats';

export const UNREADABLE_TEXT = "Can't open this entry";
const KEY_GRACE_MS = 60000;
const PAGE_SIZE = 50;
/** The server takes at most 5 files per upload request. */
const UPLOAD_CHUNK = 5;

export class JournalKeyMissingError extends Error {
  constructor() {
    super('Your private space is not on this phone.');
    this.name = 'JournalKeyMissingError';
    this.code = 'journal_key_missing';
  }
}

export const isKeyMissing = (e) => e?.code === 'journal_key_missing';

/** entryKey stays off the enumerable fields so route params and logs never carry it. */
function withEntryKey(entry, entryKey) {
  Object.defineProperty(entry, 'entryKey', { value: entryKey, enumerable: false });
  return entry;
}

function unreadable(raw) {
  return {
    id: raw.id,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    text: UNREADABLE_TEXT,
    mood: null,
    tags: [],
    media: [],
    unreadable: true,
  };
}

export function createJournalRepo({
  api, getUserId, loadKey, readBytes, resizeThumbnail, uploadBlobs, fetchBytes, deleteTempFiles = async () => {},
  getTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone, onKeyMissing,
  setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  // Everything secret is held for one user only: the key pair, and the photos decrypted with it.
  let keyPair = null;
  let keyPromise = null;
  let secretsUser = null;
  let backgroundedAt = null;
  let backgroundTimer = null;
  const photos = new Map();

  const clearSecrets = () => {
    keyPair = null;
    keyPromise = null;
    secretsUser = null;
    photos.clear();
  };

  const cancelBackgroundTimer = () => {
    if (backgroundTimer !== null) clearTimer(backgroundTimer);
    backgroundTimer = null;
  };

  /** Drops anything cached for a different user than the one signed in now. */
  function currentUser() {
    const user = getUserId() || null;
    if (secretsUser !== null && secretsUser !== user) clearSecrets();
    return user;
  }

  async function getKeys() {
    const user = currentUser();
    if (!user) {
      onKeyMissing?.();
      throw new JournalKeyMissingError();
    }
    if (keyPair) return keyPair;
    if (!keyPromise) {
      secretsUser = user;
      const loading = loadKey().then((k) => {
        if (!k?.privateKey || !k?.publicKey) throw new JournalKeyMissingError();
        // Someone else may have signed in while the key was loading: never hand it over.
        if ((getUserId() || null) !== user || secretsUser !== user) throw new JournalKeyMissingError();
        keyPair = k;
        return k;
      });
      keyPromise = loading;
      loading.catch(() => { if (keyPromise === loading) keyPromise = null; });
    }
    try {
      return await keyPromise;
    } catch (e) {
      if (isKeyMissing(e)) onKeyMissing?.();
      throw e;
    }
  }

  async function decryptRaw(raw, keys) {
    try {
      const body = await decryptEntry(raw, keys.privateKey);
      const entryKey = await openEntryKey(raw.sealedKey, keys.privateKey);
      return withEntryKey({
        id: raw.id,
        createdAt: raw.createdAt,
        updatedAt: raw.updatedAt,
        text: body.text || '',
        mood: body.mood || null,
        tags: body.tags || [],
        media: raw.media || [],
        unreadable: false,
      }, entryKey);
    } catch {
      return unreadable(raw);
    }
  }

  async function sealPhotos(list, entryKey, entryId) {
    if (!list?.length) return [];
    const blobs = [];
    for (const { uri } of list) {
      blobs.push(await encryptAttachment(await readBytes(uri), entryKey, entryId));
      blobs.push(await encryptAttachment(await resizeThumbnail(uri), entryKey, entryId));
    }
    const uploaded = [];
    for (let i = 0; i < blobs.length; i += UPLOAD_CHUNK) {
      uploaded.push(...(await uploadBlobs(blobs.slice(i, i + UPLOAD_CHUNK))));
    }
    return list.map((_, i) => ({
      blobKey: uploaded[i * 2].fileName,
      thumbnailKey: uploaded[i * 2 + 1].fileName,
      sizeBytes: uploaded[i * 2].size,
    }));
  }

  /** `entryId` is the phone's own uuid for a new entry and the existing id when editing. */
  async function write(entryId, { text, mood, tags, photos: picked, keepMedia = [], entryKey }, send, withId) {
    const keys = await getKeys();
    const sealed = await encryptEntry({ text, mood, tags }, keys.publicKey, entryId, entryKey);
    const fresh = await sealPhotos(picked, sealed.entryKey, entryId);
    const body = {
      ...(withId ? { id: entryId } : {}),
      ciphertext: sealed.ciphertext,
      sealedKey: sealed.sealedKey,
      format: JOURNAL_FORMAT,
      media: [...keepMedia.map((id) => ({ id })), ...fresh],
    };
    const saved = await decryptRaw(await send(body), keys);
    // The plain picker copies are no longer needed once the encrypted entry is safely stored.
    if (picked?.length) await deleteTempFiles(picked.map((p) => p.uri)).catch(() => {});
    return saved;
  }

  return {
    clearSecrets,
    clear: clearSecrets,

    /** Plain picker copies the user will not save (discarded or removed). */
    async discardPhotos(uris) {
      if (uris?.length) await deleteTempFiles(uris).catch(() => {});
    },

    /**
     * Secrets go when the app has been in the background for a minute, even if the
     * user never comes back (a timer, not just a check on the next foreground).
     */
    onAppStateChange(next, now = Date.now()) {
      if (next === 'background') {
        if (backgroundedAt === null) backgroundedAt = now;
        if (backgroundTimer === null) {
          backgroundTimer = setTimer(() => {
            backgroundTimer = null;
            clearSecrets();
          }, KEY_GRACE_MS);
        }
      } else if (next === 'active') {
        cancelBackgroundTimer();
        if (backgroundedAt !== null && now - backgroundedAt >= KEY_GRACE_MS) clearSecrets();
        backgroundedAt = null;
      }
    },

    saveEntry: (input) => {
      const id = newEntryId();
      return write(id, input, (body) => api.create(body), true);
    },

    updateEntry: (id, input) => write(id, input, (body) => api.update(id, body), false),

    async loadEntry(id) {
      const keys = await getKeys();
      return decryptRaw(await api.getById(id), keys);
    },

    async loadPage(params) {
      const keys = await getKeys();
      const page = await api.list(params);
      return {
        entries: await Promise.all(page.entries.map((raw) => decryptRaw(raw, keys))),
        nextCursor: page.nextCursor ?? null,
        hasMore: !!page.hasMore,
      };
    },

    /** Decrypted photo as a data URI, held in memory only. `entry` is a loaded entry (its id and key). */
    async loadPhoto(media, entry, { full = false } = {}) {
      const user = currentUser();
      const url = full ? media.url : media.thumbnailUrl || media.url;
      const cacheKey = `${user}:${media.id}:${full ? 'full' : 'thumb'}`;
      if (photos.has(cacheKey)) return photos.get(cacheKey);
      const plain = await decryptAttachment(await fetchBytes(url), entry.entryKey, entry.id);
      const uri = `data:image/jpeg;base64,${bytesToBase64(plain)}`;
      // The user may have changed while the photo downloaded: never cache it under the new one.
      if ((getUserId() || null) === user) photos.set(cacheKey, uri);
      return uri;
    },

    /** Stats for one month, from entries decrypted here; the server only knows which days have entries. */
    async monthView(month) {
      const keys = await getKeys();
      const [year, mm] = month.split('-').map(Number);
      const monthStart = Date.UTC(year, mm - 1, 1) - 24 * 3600 * 1000;
      const history = api.history(month);
      history.catch(() => {});
      const decrypted = [];
      let cursor;
      for (;;) {
        const page = await api.list({ limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) });
        const entries = await Promise.all(page.entries.map((raw) => decryptRaw(raw, keys)));
        decrypted.push(...entries.filter((e) => !e.unreadable));
        const oldest = page.entries[page.entries.length - 1];
        if (!page.hasMore || !page.nextCursor || (oldest && new Date(oldest.createdAt).getTime() < monthStart)) break;
        cursor = page.nextCursor;
      }
      const { entryDates, daysInMonth, firstWeekday } = await history;
      return {
        month,
        ...monthStats(decrypted, { year, month: mm, timezone: getTimezone() }),
        entryDates,
        daysInMonth,
        firstWeekday,
      };
    },

    async onThisDayView(date) {
      const keys = await getKeys();
      const { entries } = await api.onThisDay(date);
      const decrypted = (await Promise.all(entries.map((raw) => decryptRaw(raw, keys)))).filter((e) => !e.unreadable);
      return onThisDay(decrypted, { date, timezone: getTimezone() });
    },
  };
}

// ─── App wiring ──────────────────────────────────────────────────────────────

let instance = null;

/** The repo if anything has used it yet; never builds one. */
export const peekJournalRepo = () => instance;

/** Drops the cached key pair and decrypted photos (sign-out, lock, key removed). Safe before the repo exists. */
export const clearJournalSecrets = () => instance?.clearSecrets();

/** Built on first use so importing this file never loads native modules. */
export function getJournalRepo() {
  if (!instance) {
    const { journalApi } = require('../api/journal');
    const { loadAccountPrivateKey } = require('../crypto/accountKey');
    const { useAuthStore } = require('../store/authStore');
    const { usePrivateSpaceStore } = require('../store/privateSpaceStore');
    const device = require('./journalDevice');
    instance = createJournalRepo({
      api: journalApi,
      getUserId: () => useAuthStore.getState().user?.id,
      loadKey: () => loadAccountPrivateKey(useAuthStore.getState().user?.id),
      onKeyMissing: () => usePrivateSpaceStore.getState().refresh(),
      ...device,
    });
  }
  return instance;
}
