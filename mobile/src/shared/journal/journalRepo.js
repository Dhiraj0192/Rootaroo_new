/**
 * The journal as the screens see it: plain text in, plain text out. Everything
 * sent to the server is ciphertext; decryption and every stat that needs
 * content happen here, on the phone.
 */

import { bytesToBase64 } from '../crypto/bytes';
import {
  JOURNAL_FORMAT, decryptAttachment, decryptEntry, encryptAttachment, encryptEntry, openEntryKey,
} from './journalCrypto';
import { monthStats, onThisDay } from './journalStats';

export const UNREADABLE_TEXT = "Can't open this entry";
const KEY_GRACE_MS = 60000;
const PAGE_SIZE = 50;

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
  api, loadKey, readBytes, resizeThumbnail, uploadBlobs, fetchBytes, getTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone, onKeyMissing,
}) {
  let keyPair = null;
  let keyPromise = null;
  let backgroundedAt = null;
  const photos = new Map();

  const clear = () => {
    keyPair = null;
    keyPromise = null;
    photos.clear();
  };

  async function getKeys() {
    if (keyPair) return keyPair;
    if (!keyPromise) {
      keyPromise = loadKey().then((k) => {
        if (!k?.privateKey || !k?.publicKey) throw new JournalKeyMissingError();
        keyPair = k;
        return k;
      });
      keyPromise.catch(() => { keyPromise = null; });
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

  async function sealPhotos(list, entryKey) {
    if (!list?.length) return [];
    const blobs = [];
    for (const { uri } of list) {
      blobs.push(await encryptAttachment(await readBytes(uri), entryKey));
      blobs.push(await encryptAttachment(await resizeThumbnail(uri), entryKey));
    }
    const uploaded = await uploadBlobs(blobs);
    return list.map((_, i) => ({
      blobKey: uploaded[i * 2].fileName,
      thumbnailKey: uploaded[i * 2 + 1].fileName,
      sizeBytes: uploaded[i * 2].size,
    }));
  }

  async function write({ text, mood, tags, photos: picked, keepMedia = [], entryKey }, send) {
    const keys = await getKeys();
    const sealed = await encryptEntry({ text, mood, tags }, keys.publicKey, entryKey);
    const fresh = await sealPhotos(picked, sealed.entryKey);
    const body = {
      ciphertext: sealed.ciphertext,
      sealedKey: sealed.sealedKey,
      format: JOURNAL_FORMAT,
      media: [...keepMedia.map((id) => ({ id })), ...fresh],
    };
    return decryptRaw(await send(body), keys);
  }

  return {
    clear,

    onAppStateChange(next, now = Date.now()) {
      if (next === 'background') {
        if (backgroundedAt === null) backgroundedAt = now;
      } else if (next === 'active') {
        if (backgroundedAt !== null && now - backgroundedAt >= KEY_GRACE_MS) clear();
        backgroundedAt = null;
      }
    },

    saveEntry: (input) => write(input, (body) => api.create(body)),

    updateEntry: (id, input) => write(input, (body) => api.update(id, body)),

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

    /** Decrypted photo as a data URI, held in memory only. */
    async loadPhoto(media, entryKey, { full = false } = {}) {
      const url = full ? media.url : media.thumbnailUrl || media.url;
      const cacheKey = `${media.id}:${full ? 'full' : 'thumb'}`;
      if (photos.has(cacheKey)) return photos.get(cacheKey);
      const plain = await decryptAttachment(await fetchBytes(url), entryKey);
      const uri = `data:image/jpeg;base64,${bytesToBase64(plain)}`;
      photos.set(cacheKey, uri);
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
      loadKey: () => loadAccountPrivateKey(useAuthStore.getState().user?.id),
      onKeyMissing: () => usePrivateSpaceStore.getState().refresh(),
      ...device,
    });
  }
  return instance;
}
