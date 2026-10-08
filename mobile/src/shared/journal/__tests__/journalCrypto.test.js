import { webcrypto } from 'node:crypto';

if (!globalThis.crypto?.subtle) globalThis.crypto = webcrypto;

const { generateAccountKeyPair } = require('../../crypto/accountKey');
const { encryptEntry, decryptEntry, openEntryKey, encryptAttachment, decryptAttachment, JOURNAL_FORMAT } = require('../journalCrypto');

const bytes = (n, fill = 7) => new Uint8Array(n).fill(fill);

describe('journal entry encryption', () => {
  it('round trip: text, mood and tags come back exactly', async () => {
    const k = await generateAccountKeyPair();
    const enc = await encryptEntry({ text: 'Picnic by the river 🌳', mood: 'happy', tags: ['family', 'outdoors'] }, k.publicKey);
    expect(enc).toEqual({ ciphertext: expect.any(String), sealedKey: expect.any(String), format: JOURNAL_FORMAT, entryKey: expect.any(Uint8Array) });
    const dec = await decryptEntry({ ciphertext: enc.ciphertext, sealedKey: enc.sealedKey, format: enc.format }, k.privateKey);
    expect(dec).toEqual({ text: 'Picnic by the river 🌳', mood: 'happy', tags: ['family', 'outdoors'] });
  });

  it('what goes to the server contains none of the words, mood or tags', async () => {
    const k = await generateAccountKeyPair();
    const enc = await encryptEntry({ text: 'secret diary words', mood: 'rough', tags: ['private-tag'] }, k.publicKey);
    const wire = JSON.stringify({ ciphertext: enc.ciphertext, sealedKey: enc.sealedKey, format: enc.format });
    for (const leak of ['secret', 'diary', 'rough', 'private-tag']) expect(wire).not.toContain(leak);
  });

  it('every entry gets its own key', async () => {
    const k = await generateAccountKeyPair();
    const a = await encryptEntry({ text: 'same', mood: null, tags: [] }, k.publicKey);
    const b = await encryptEntry({ text: 'same', mood: null, tags: [] }, k.publicKey);
    expect(Buffer.from(a.entryKey).equals(Buffer.from(b.entryKey))).toBe(false);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("someone else's account key cannot read it", async () => {
    const mine = await generateAccountKeyPair();
    const theirs = await generateAccountKeyPair();
    const enc = await encryptEntry({ text: 'hi', mood: null, tags: [] }, mine.publicKey);
    await expect(decryptEntry({ ciphertext: enc.ciphertext, sealedKey: enc.sealedKey, format: enc.format }, theirs.privateKey)).rejects.toThrow();
  });

  it('a tampered entry is rejected', async () => {
    const k = await generateAccountKeyPair();
    const enc = await encryptEntry({ text: 'hi', mood: null, tags: [] }, k.publicKey);
    const raw = Buffer.from(enc.ciphertext, 'base64');
    raw[raw.length - 1] ^= 1;
    await expect(decryptEntry({ ciphertext: raw.toString('base64'), sealedKey: enc.sealedKey, format: enc.format }, k.privateKey)).rejects.toThrow();
  });

  it('refuses an unknown format version instead of guessing', async () => {
    const k = await generateAccountKeyPair();
    const enc = await encryptEntry({ text: 'hi', mood: null, tags: [] }, k.publicKey);
    await expect(decryptEntry({ ...enc, format: 99 }, k.privateKey)).rejects.toThrow('newer version');
  });
});

describe('photo encryption', () => {
  it('photos are encrypted with the entry key and come back byte for byte', async () => {
    const k = await generateAccountKeyPair();
    const enc = await encryptEntry({ text: '', mood: null, tags: [] }, k.publicKey);
    const photo = bytes(5000, 42);
    const sealedPhoto = await encryptAttachment(photo, enc.entryKey);
    expect(sealedPhoto.length).toBe(12 + 5000 + 16);
    expect(Buffer.from(sealedPhoto).includes(Buffer.from(bytes(64, 42)))).toBe(false);
    const entryKey = await openEntryKey(enc.sealedKey, k.privateKey);
    expect(Buffer.from(await decryptAttachment(sealedPhoto, entryKey)).equals(Buffer.from(photo))).toBe(true);
  });

  it('two photos in the same entry never reuse a nonce', async () => {
    const k = await generateAccountKeyPair();
    const enc = await encryptEntry({ text: '', mood: null, tags: [] }, k.publicKey);
    const a = await encryptAttachment(bytes(10), enc.entryKey);
    const b = await encryptAttachment(bytes(10), enc.entryKey);
    expect(Buffer.from(a.slice(0, 12)).equals(Buffer.from(b.slice(0, 12)))).toBe(false);
  });
});

describe('editing keeps the entry key', () => {
  it('re-encrypting with the existing key still opens old attachments', async () => {
    const k = await generateAccountKeyPair();
    const first = await encryptEntry({ text: 'one', mood: null, tags: [] }, k.publicKey);
    const photo = await encryptAttachment(bytes(20), first.entryKey);
    const second = await encryptEntry({ text: 'two', mood: 'calm', tags: [] }, k.publicKey, first.entryKey);
    expect(second.sealedKey).not.toBe(first.sealedKey);
    const key = await openEntryKey(second.sealedKey, k.privateKey);
    expect(Array.from(await decryptAttachment(photo, key))).toEqual(Array.from(bytes(20)));
  });
});
