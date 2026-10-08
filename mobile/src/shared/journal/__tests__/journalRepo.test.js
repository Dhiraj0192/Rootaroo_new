import { webcrypto } from 'node:crypto';

if (!globalThis.crypto?.subtle) globalThis.crypto = webcrypto;

const { generateAccountKeyPair } = require('../../crypto/accountKey');
const { openEntryKey, decryptAttachment, encryptEntry, encryptAttachment } = require('../journalCrypto');
const { createJournalRepo, JournalKeyMissingError, UNREADABLE_TEXT } = require('../journalRepo');

const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);
const b64 = (bytes) => Buffer.from(bytes).toString('base64');

let pair;
beforeAll(async () => {
  pair = await generateAccountKeyPair();
});

function build(overrides = {}) {
  const api = {
    create: jest.fn(async (body) => ({ id: 'e1', createdAt: '2026-10-05T10:00:00Z', updatedAt: '2026-10-05T10:00:00Z', ...body, media: [] })),
    update: jest.fn(async (id, body) => ({ id, createdAt: '2026-10-05T10:00:00Z', ...body, media: [] })),
    list: jest.fn(async () => ({ entries: [], nextCursor: null, hasMore: false })),
    getById: jest.fn(),
    history: jest.fn(async () => ({ entryDates: [], daysInMonth: 31, firstWeekday: 3 })),
    onThisDay: jest.fn(async () => ({ entries: [] })),
  };
  const deps = {
    api,
    loadKey: jest.fn(async () => pair),
    readBytes: jest.fn(async (uri) => enc(`photo:${uri}`)),
    resizeThumbnail: jest.fn(async (uri) => enc(`thumb:${uri}`)),
    uploadBlobs: jest.fn(async (blobs) => blobs.map((b, i) => ({ fileName: `blob-${i}`, size: b.length }))),
    fetchBytes: jest.fn(),
    getTimezone: () => 'UTC',
    ...overrides,
  };
  return { repo: createJournalRepo(deps), api, deps };
}

async function serverEntry(id, createdAt, content, extra = {}) {
  const e = await encryptEntry(content, pair.publicKey);
  return {
    id, createdAt, updatedAt: createdAt, ciphertext: e.ciphertext, sealedKey: e.sealedKey, format: e.format, media: [], ...extra,
  };
}

describe('saveEntry', () => {
  it('never sends text, mood or tags to the API', async () => {
    const { repo, api, deps } = build();
    await repo.saveEntry({ text: 'private words', mood: 'rough', tags: ['secret-tag'], photos: [{ uri: 'file:///a.jpg' }] });
    const seen = JSON.stringify([api.create.mock.calls, deps.uploadBlobs.mock.calls.map((c) => c[0].map(b64))]);
    for (const leak of ['private words', 'rough', 'secret-tag', 'photo:file', 'thumb:file']) expect(seen).not.toContain(leak);
    const body = api.create.mock.calls[0][0];
    expect(Object.keys(body).sort()).toEqual(['ciphertext', 'format', 'media', 'sealedKey']);
    expect(body.format).toBe(1);
  });

  it('encrypts each photo and its thumbnail with the entry key and sends blob keys', async () => {
    const { repo, api, deps } = build();
    await repo.saveEntry({ text: 'x', mood: null, tags: [], photos: [{ uri: 'a' }, { uri: 'b' }] });
    const body = api.create.mock.calls[0][0];
    expect(body.media).toEqual([
      { blobKey: 'blob-0', thumbnailKey: 'blob-1', sizeBytes: expect.any(Number) },
      { blobKey: 'blob-2', thumbnailKey: 'blob-3', sizeBytes: expect.any(Number) },
    ]);
    const blobs = deps.uploadBlobs.mock.calls[0][0];
    expect(blobs).toHaveLength(4);
    const entryKey = await openEntryKey(body.sealedKey, pair.privateKey);
    expect(dec(await decryptAttachment(blobs[0], entryKey))).toBe('photo:a');
    expect(dec(await decryptAttachment(blobs[1], entryKey))).toBe('thumb:a');
    expect(dec(await decryptAttachment(blobs[3], entryKey))).toBe('thumb:b');
    expect(deps.resizeThumbnail).toHaveBeenCalledWith('a');
  });

  it('skips uploading when there are no photos', async () => {
    const { repo, deps } = build();
    await repo.saveEntry({ text: 'x', mood: null, tags: [], photos: [] });
    expect(deps.uploadBlobs).not.toHaveBeenCalled();
  });

  it('does not create the entry when a photo upload fails', async () => {
    const { repo, api } = build({ uploadBlobs: jest.fn(async () => { throw new Error('offline'); }) });
    await expect(repo.saveEntry({ text: 'x', mood: null, tags: [], photos: [{ uri: 'a' }] })).rejects.toThrow('offline');
    expect(api.create).not.toHaveBeenCalled();
  });

  it('returns the entry decrypted', async () => {
    const { repo } = build();
    const saved = await repo.saveEntry({ text: 'hello', mood: 'calm', tags: ['t'], photos: [] });
    expect(saved).toMatchObject({ id: 'e1', text: 'hello', mood: 'calm', tags: ['t'] });
  });
});

describe('updateEntry', () => {
  it('keeps the entry key, references old media by id and adds new photos', async () => {
    const { repo, api, deps } = build();
    const entryKey = new Uint8Array(32).fill(9);
    const old = await encryptAttachment(enc('old photo'), entryKey);
    await repo.updateEntry('e9', {
      text: 'brand new words', mood: 'happy', tags: [], keepMedia: ['m1'], photos: [{ uri: 'n' }], entryKey,
    });
    const [id, body] = api.update.mock.calls[0];
    expect(id).toBe('e9');
    expect(body.media).toEqual([{ id: 'm1' }, { blobKey: 'blob-0', thumbnailKey: 'blob-1', sizeBytes: expect.any(Number) }]);
    expect(JSON.stringify(api.update.mock.calls)).not.toContain('brand new words');
    const key = await openEntryKey(body.sealedKey, pair.privateKey);
    expect(dec(await decryptAttachment(old, key))).toBe('old photo');
    expect(deps.uploadBlobs).toHaveBeenCalledTimes(1);
  });
});

describe('loadEntry and loadPage', () => {
  it('decrypts an entry', async () => {
    const { repo, api } = build();
    api.getById.mockResolvedValue(await serverEntry('e1', '2026-10-05T10:00:00Z', { text: 'hi', mood: 'calm', tags: ['a'] }));
    const e = await repo.loadEntry('e1');
    expect(e).toMatchObject({ id: 'e1', text: 'hi', mood: 'calm', tags: ['a'], unreadable: false });
    expect(e.entryKey).toBeInstanceOf(Uint8Array);
    expect(Object.keys(e)).not.toContain('entryKey');
  });

  it('shows an undecryptable entry as unreadable instead of failing the page', async () => {
    const { repo, api } = build();
    const good = await serverEntry('g', '2026-10-05T10:00:00Z', { text: 'fine', mood: null, tags: [] });
    const bad = { ...good, id: 'b', ciphertext: Buffer.from('garbage-garbage-garbage').toString('base64') };
    api.list.mockResolvedValue({ entries: [bad, good], nextCursor: 'c', hasMore: true });
    const page = await repo.loadPage({ limit: 5 });
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe('c');
    expect(page.entries[0]).toMatchObject({ id: 'b', unreadable: true, text: UNREADABLE_TEXT, tags: [], media: [] });
    expect(page.entries[1].text).toBe('fine');
    expect(api.list).toHaveBeenCalledWith({ limit: 5 });
  });

  it('marks an entry from a newer format as unreadable', async () => {
    const { repo, api } = build();
    const e = await serverEntry('n', '2026-10-05T10:00:00Z', { text: 'x', mood: null, tags: [] });
    api.getById.mockResolvedValue({ ...e, format: 2 });
    expect((await repo.loadEntry('n')).unreadable).toBe(true);
  });
});

describe('private key handling', () => {
  it('loads the key once per session and keeps it in memory only', async () => {
    const { repo, deps } = build();
    await repo.loadPage({});
    await repo.loadPage({});
    await repo.saveEntry({ text: 'x', mood: null, tags: [], photos: [] });
    expect(deps.loadKey).toHaveBeenCalledTimes(1);
  });

  it('throws a typed error when there is no key and tells the host', async () => {
    const onKeyMissing = jest.fn();
    const { repo } = build({ loadKey: jest.fn(async () => null), onKeyMissing });
    await expect(repo.loadPage({})).rejects.toBeInstanceOf(JournalKeyMissingError);
    await expect(repo.saveEntry({ text: 'x', mood: null, tags: [], photos: [] })).rejects.toMatchObject({ code: 'journal_key_missing' });
    expect(onKeyMissing).toHaveBeenCalled();
  });

  it('clears the key after more than a minute in the background', async () => {
    const { repo, deps } = build();
    await repo.loadPage({});
    repo.onAppStateChange('background', 1000);
    repo.onAppStateChange('active', 1000 + 30000);
    await repo.loadPage({});
    expect(deps.loadKey).toHaveBeenCalledTimes(1);
    repo.onAppStateChange('background', 100000);
    repo.onAppStateChange('active', 100000 + 61000);
    await repo.loadPage({});
    expect(deps.loadKey).toHaveBeenCalledTimes(2);
  });

  it('clear() forgets the key and decrypted photos', async () => {
    const { repo, deps } = build();
    await repo.loadPage({});
    repo.clear();
    await repo.loadPage({});
    expect(deps.loadKey).toHaveBeenCalledTimes(2);
  });
});

describe('loadPhoto', () => {
  it('fetches the signed url, decrypts to a data uri and caches it in memory', async () => {
    const { repo, deps } = build();
    const entryKey = new Uint8Array(32).fill(5);
    const sealed = await encryptAttachment(enc('JPEGDATA'), entryKey);
    deps.fetchBytes.mockResolvedValue(sealed);
    const media = { id: 'm1', url: 'https://s3/full', thumbnailUrl: 'https://s3/thumb' };
    const uri = await repo.loadPhoto(media, entryKey);
    expect(uri).toBe(`data:image/jpeg;base64,${b64(enc('JPEGDATA'))}`);
    expect(deps.fetchBytes).toHaveBeenCalledWith('https://s3/thumb');
    await repo.loadPhoto(media, entryKey);
    expect(deps.fetchBytes).toHaveBeenCalledTimes(1);
    await repo.loadPhoto(media, entryKey, { full: true });
    expect(deps.fetchBytes).toHaveBeenLastCalledWith('https://s3/full');
  });

  it('forgets decrypted photos on clear()', async () => {
    const { repo, deps } = build();
    const entryKey = new Uint8Array(32).fill(5);
    deps.fetchBytes.mockResolvedValue(await encryptAttachment(enc('J'), entryKey));
    const media = { id: 'm1', url: 'u' };
    await repo.loadPhoto(media, entryKey);
    repo.clear();
    await repo.loadPhoto(media, entryKey);
    expect(deps.fetchBytes).toHaveBeenCalledTimes(2);
  });
});

describe('monthView', () => {
  it('pages until it passes the month, decrypts and computes stats on the phone', async () => {
    const { repo, api } = build();
    const e1 = await serverEntry('1', '2026-10-05T10:00:00Z', { text: 'one two three', mood: 'happy', tags: ['a', 'b'] });
    const e2 = await serverEntry('2', '2026-10-02T10:00:00Z', { text: 'four five', mood: 'low', tags: ['a'] });
    const old = await serverEntry('3', '2026-09-20T10:00:00Z', { text: 'september', mood: 'calm', tags: [] });
    api.list
      .mockResolvedValueOnce({ entries: [e1], nextCursor: 'c1', hasMore: true })
      .mockResolvedValueOnce({ entries: [e2, old], nextCursor: 'c2', hasMore: true });
    api.history.mockResolvedValue({ entryDates: ['2026-10-02', '2026-10-05'], daysInMonth: 31, firstWeekday: 3 });
    const view = await repo.monthView('2026-10');
    expect(api.list).toHaveBeenCalledTimes(2);
    expect(api.list.mock.calls[1][0]).toMatchObject({ cursor: 'c1' });
    expect(view).toMatchObject({
      month: '2026-10', entriesThisMonth: 2, wordsThisMonth: 5, moodSummary: 'happy',
      entryDates: ['2026-10-02', '2026-10-05'], daysInMonth: 31, firstWeekday: 3,
    });
    expect(view.topTags[0]).toEqual({ tag: 'a', count: 2 });
    expect(view.moodDays).toEqual({ '2026-10-05': 'happy', '2026-10-02': 'low' });
  });

  it('stops when the server says there is no more', async () => {
    const { repo, api } = build();
    const view = await repo.monthView('2026-10');
    expect(api.list).toHaveBeenCalledTimes(1);
    expect(view.wordsThisMonth).toBe(0);
  });

  it('leaves unreadable entries out of the numbers', async () => {
    const { repo, api } = build();
    const good = await serverEntry('1', '2026-10-05T10:00:00Z', { text: 'one two', mood: null, tags: [] });
    const bad = { ...good, id: '2', ciphertext: 'AAAA' };
    api.list.mockResolvedValue({ entries: [good, bad], nextCursor: null, hasMore: false });
    expect((await repo.monthView('2026-10')).wordsThisMonth).toBe(2);
  });
});

describe('onThisDayView', () => {
  it('decrypts past-year entries and returns snippets', async () => {
    const { repo, api } = build();
    const past = await serverEntry('p', '2025-10-05T10:00:00Z', { text: 'a year ago today', mood: 'calm', tags: [] });
    api.onThisDay.mockResolvedValue({ entries: [past] });
    const list = await repo.onThisDayView('2026-10-05');
    expect(api.onThisDay).toHaveBeenCalledWith('2026-10-05');
    expect(list).toEqual([{ id: 'p', createdAt: '2025-10-05T10:00:00Z', yearsAgo: 1, snippet: 'a year ago today', mood: 'calm' }]);
  });
});
