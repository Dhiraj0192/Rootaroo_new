import {
  createEntry,
  listEntries,
  getEntryById,
  updateEntry,
  deleteEntry,
  getStats,
  getHistory,
  getOnThisDay,
} from '../service';
import * as models from '../../../database/models';
import * as s3 from '../../../shared/utils/s3';
import { ForbiddenError, NotFoundError } from '../../../shared/utils/errors';

const userId = '550e8400-e29b-41d4-a716-446655440001';
const otherUserId = '660e8400-e29b-41d4-a716-446655440002';
const householdId = '880e8400-e29b-41d4-a716-446655440004';
const entryId = '990e8400-e29b-41d4-a716-446655440005';

jest.mock('../../../database/models', () => {
  const mockModel = (name: string) => {
    const cls: any = jest.fn().mockName(name);
    cls.create = jest.fn();
    cls.findAll = jest.fn();
    cls.findOne = jest.fn();
    cls.findByPk = jest.fn();
    cls.bulkCreate = jest.fn();
    cls.destroy = jest.fn();
    return cls;
  };
  return {
    JournalEntry: mockModel('JournalEntry'),
    JournalMedia: mockModel('JournalMedia'),
    HouseholdMember: mockModel('HouseholdMember'),
    Household: mockModel('Household'),
  };
});

jest.mock('../../../shared/utils/s3', () => ({
  getSignedUrl: jest.fn(async (key: string | null) => (key ? `signed:${key}` : null)),
  deleteObject: jest.fn().mockResolvedValue(undefined),
}));

const modelsMock = models as any;
const s3Mock = s3 as any;

const body = { ciphertext: 'Y2lwaGVy', sealedKey: 'c2VhbGVk', format: 1 };

function mockEntry(overrides: any = {}) {
  const entry: any = {
    id: entryId,
    householdId,
    userId,
    ciphertext: 'Y2lwaGVy',
    sealedKey: 'c2VhbGVk',
    format: 1,
    createdAt: new Date('2026-07-10T10:00:00Z'),
    updatedAt: new Date('2026-07-10T10:00:00Z'),
    destroy: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockImplementation(function (this: any, data: any) {
      Object.assign(this, data);
      return Promise.resolve(this);
    }),
    get: jest.fn(),
    ...overrides,
  };
  entry.get.mockImplementation((key: string) => (key === 'media' ? overrides.media || [] : entry[key]));
  return entry;
}

describe('Journal Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    modelsMock.HouseholdMember.findOne.mockResolvedValue({ householdId, userId });
    modelsMock.Household.findByPk.mockResolvedValue({ id: householdId, timezone: 'UTC' });
  });

  describe('createEntry', () => {
    it('stores only the ciphertext and the sealed key', async () => {
      const entry = mockEntry();
      modelsMock.JournalEntry.create.mockResolvedValue(entry);
      modelsMock.JournalEntry.findByPk.mockResolvedValue(entry);

      const result = await createEntry(userId, body);

      expect(modelsMock.JournalEntry.create).toHaveBeenCalledWith(
        expect.objectContaining({ householdId, userId, ciphertext: 'Y2lwaGVy', sealedKey: 'c2VhbGVk', format: 1 }),
      );
      expect(modelsMock.JournalMedia.bulkCreate).not.toHaveBeenCalled();
      expect(result).toEqual(expect.objectContaining({ ciphertext: 'Y2lwaGVy', sealedKey: 'c2VhbGVk', format: 1 }));
      for (const k of ['content', 'mood', 'tags', 'wordCount']) expect(result).not.toHaveProperty(k);
    });

    it('creates an entry with encrypted media and returns signed links', async () => {
      const blobKey = `journal/blobs/${userId}/photo`;
      const thumbnailKey = `journal/blobs/${userId}/thumb`;
      const entry = mockEntry({ media: [{ id: 'm1', blobKey, thumbnailKey, sizeBytes: 1000 }] });
      modelsMock.JournalEntry.create.mockResolvedValue(entry);
      modelsMock.JournalEntry.findByPk.mockResolvedValue(entry);

      const result = await createEntry(userId, { ...body, media: [{ blobKey, thumbnailKey, sizeBytes: 1000 }] });

      expect(modelsMock.JournalMedia.bulkCreate).toHaveBeenCalledWith([
        expect.objectContaining({ entryId, blobKey, thumbnailKey, sizeBytes: 1000 }),
      ]);
      expect(result.media).toEqual([
        { id: 'm1', url: `signed:${blobKey}`, thumbnailUrl: `signed:${thumbnailKey}`, sizeBytes: 1000 },
      ]);
    });

    it('should throw ForbiddenError if user is not a household member', async () => {
      modelsMock.HouseholdMember.findOne.mockResolvedValue(null);

      await expect(createEntry(userId, body)).rejects.toThrow(ForbiddenError);
    });

    it("refuses to attach someone else's upload, so it can't be turned into a download link", async () => {
      for (const blobKey of [
        `journal/blobs/${otherUserId}/photo`,
        `journal/images/${userId}/photo`,
        `vault/${householdId}/secret`,
        'https://example.com/x.jpg',
      ]) {
        await expect(createEntry(userId, { ...body, media: [{ blobKey, sizeBytes: 1 }] })).rejects.toThrow(ForbiddenError);
      }
      await expect(createEntry(userId, {
        ...body,
        media: [{ blobKey: `journal/blobs/${userId}/p`, thumbnailKey: `journal/blobs/${otherUserId}/t`, sizeBytes: 1 }],
      })).rejects.toThrow(ForbiddenError);
      expect(modelsMock.JournalEntry.create).not.toHaveBeenCalled();
    });
  });

  describe('listEntries', () => {
    it('should only query entries scoped to the caller (householdId + userId)', async () => {
      modelsMock.JournalEntry.findAll.mockResolvedValue([mockEntry()]);

      await listEntries(userId, { limit: 20 });

      expect(modelsMock.JournalEntry.findAll).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { householdId, userId },
        }),
      );
    });

    it('should indicate hasMore when more rows than limit are returned', async () => {
      modelsMock.JournalEntry.findAll.mockResolvedValue([mockEntry(), mockEntry({ id: 'e2' })]);

      const result = await listEntries(userId, { limit: 1 });

      expect(result.entries).toHaveLength(1);
      expect(result.hasMore).toBe(true);
      expect(result.nextCursor).toBe(entryId);
    });
  });

  describe('getEntryById', () => {
    it('should return the entry when it belongs to the caller', async () => {
      modelsMock.JournalEntry.findOne.mockResolvedValue(mockEntry());

      const result = await getEntryById(userId, entryId);

      expect(modelsMock.JournalEntry.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: entryId, householdId, userId } }),
      );
      expect(result.id).toBe(entryId);
    });

    it('should throw NotFoundError (not ForbiddenError) for another user\'s entry', async () => {
      // Simulates another user's entry: the owner-scoped where clause matches nothing.
      modelsMock.JournalEntry.findOne.mockResolvedValue(null);

      await expect(getEntryById(otherUserId, entryId)).rejects.toThrow(NotFoundError);
    });
  });

  describe('updateEntry', () => {
    it('replaces the ciphertext of the caller\'s own entry', async () => {
      const entry = mockEntry();
      modelsMock.JournalEntry.findOne.mockResolvedValue(entry);
      modelsMock.JournalEntry.findByPk.mockResolvedValue(mockEntry({ ciphertext: 'bmV4dA==' }));

      const result = await updateEntry(userId, entryId, { ...body, ciphertext: 'bmV4dA==' });

      expect(entry.update).toHaveBeenCalledWith({ ciphertext: 'bmV4dA==', sealedKey: 'c2VhbGVk', format: 1 });
      expect(result.ciphertext).toBe('bmV4dA==');
    });

    it('should throw NotFoundError for an entry that is not the caller\'s own', async () => {
      modelsMock.JournalEntry.findOne.mockResolvedValue(null);

      await expect(updateEntry(otherUserId, entryId, body)).rejects.toThrow(NotFoundError);
    });

    it('checks new attachments are the caller\'s own, keeps listed ones and drops the rest', async () => {
      const entry = mockEntry();
      modelsMock.JournalEntry.findOne.mockResolvedValue(entry);
      modelsMock.JournalEntry.findByPk.mockResolvedValue(entry);

      await expect(
        updateEntry(userId, entryId, { ...body, media: [{ blobKey: `journal/blobs/${otherUserId}/x`, sizeBytes: 1 }] }),
      ).rejects.toThrow(ForbiddenError);

      modelsMock.JournalMedia.findAll.mockResolvedValue([]);
      await updateEntry(userId, entryId, {
        ...body,
        media: [{ id: 'keep-me' }, { blobKey: `journal/blobs/${userId}/new`, sizeBytes: 5 }],
      });
      expect(modelsMock.JournalMedia.destroy).toHaveBeenCalled();
      expect(modelsMock.JournalMedia.bulkCreate).toHaveBeenCalledWith([
        expect.objectContaining({ entryId, blobKey: `journal/blobs/${userId}/new`, sizeBytes: 5 }),
      ]);
    });
  });

  describe('deleteEntry', () => {
    it('should delete the caller\'s own entry and its stored blobs', async () => {
      const entry = mockEntry();
      modelsMock.JournalEntry.findOne.mockResolvedValue(entry);
      modelsMock.JournalMedia.findAll.mockResolvedValue([
        { blobKey: 'journal/blobs/u/a', thumbnailKey: 'journal/blobs/u/b' },
      ]);

      await deleteEntry(userId, entryId);

      expect(entry.destroy).toHaveBeenCalled();
      expect(s3Mock.deleteObject).toHaveBeenCalledWith('journal/blobs/u/a');
      expect(s3Mock.deleteObject).toHaveBeenCalledWith('journal/blobs/u/b');
    });

    it('still deletes the entry when removing a blob fails', async () => {
      const entry = mockEntry();
      modelsMock.JournalEntry.findOne.mockResolvedValue(entry);
      modelsMock.JournalMedia.findAll.mockResolvedValue([{ blobKey: 'journal/blobs/u/a', thumbnailKey: null }]);
      s3Mock.deleteObject.mockRejectedValueOnce(new Error('s3 down'));

      await expect(deleteEntry(userId, entryId)).resolves.toBeUndefined();
      expect(entry.destroy).toHaveBeenCalled();
    });

    it('should throw NotFoundError for an entry that is not the caller\'s own', async () => {
      modelsMock.JournalEntry.findOne.mockResolvedValue(null);

      await expect(deleteEntry(otherUserId, entryId)).rejects.toThrow(NotFoundError);
    });
  });
});

// ── Stats / history / on-this-day ──
//
// These all bucket instants into calendar days, so every test here pins both
// the clock and the timezone: a "streak" that only holds in UTC-during-July is
// not a tested streak.

describe('Journal Stats', () => {
  const NOW = new Date('2026-07-17T09:00:00Z');

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(NOW);
    modelsMock.HouseholdMember.findOne.mockResolvedValue({ householdId, userId });
    modelsMock.Household.findByPk.mockResolvedValue({ id: householdId, timezone: 'UTC' });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  /** A bare entry row as `getStats`/`getHistory` read it: just the date. */
  function row(dateIso: string) {
    return { createdAt: new Date(dateIso) };
  }

  describe('getStats', () => {
    it('counts consecutive days ending today', async () => {
      modelsMock.JournalEntry.findAll.mockResolvedValue([
        row('2026-07-15T08:00:00Z'),
        row('2026-07-16T08:00:00Z'),
        row('2026-07-17T08:00:00Z'),
      ]);

      const stats = await getStats(userId, 'UTC');

      expect(stats.streak).toBe(3);
      expect(stats.wroteToday).toBe(true);
    });

    it('keeps the streak alive on a day not yet written', async () => {
      // Yesterday and the day before are written; today is not. The user has
      // until midnight, so the card must still read 2 — not 0.
      modelsMock.JournalEntry.findAll.mockResolvedValue([
        row('2026-07-15T08:00:00Z'),
        row('2026-07-16T08:00:00Z'),
      ]);

      const stats = await getStats(userId, 'UTC');

      expect(stats.streak).toBe(2);
      expect(stats.wroteToday).toBe(false);
    });

    it('breaks the streak across a missed day but remembers the best run', async () => {
      modelsMock.JournalEntry.findAll.mockResolvedValue([
        row('2026-07-01T08:00:00Z'),
        row('2026-07-02T08:00:00Z'),
        row('2026-07-03T08:00:00Z'),
        row('2026-07-04T08:00:00Z'),
        // 5th–16th missed.
        row('2026-07-17T08:00:00Z'),
      ]);

      const stats = await getStats(userId, 'UTC');

      expect(stats.streak).toBe(1);
      expect(stats.bestStreak).toBe(4);
    });

    it('counts multiple entries on one day as a single streak day', async () => {
      modelsMock.JournalEntry.findAll.mockResolvedValue([
        row('2026-07-17T06:00:00Z'),
        row('2026-07-17T20:00:00Z'),
      ]);

      const stats = await getStats(userId, 'UTC');

      expect(stats.streak).toBe(1);
      expect(stats.entriesThisMonth).toBe(2);
    });

    it('buckets days in the caller timezone, not the server one', async () => {
      // 00:30 UTC on the 17th is still the 16th in New York — so in that zone
      // there is no entry today and the streak is yesterday's single day.
      modelsMock.JournalEntry.findAll.mockResolvedValue([row('2026-07-17T00:30:00Z')]);

      const stats = await getStats(userId, 'America/New_York');

      expect(stats.wroteToday).toBe(false);
      expect(stats.last7Days[5]).toEqual({ date: '2026-07-16', wrote: true });
    });

    it('returns seven days ending today, and today’s prompt', async () => {
      modelsMock.JournalEntry.findAll.mockResolvedValue([]);

      const stats = await getStats(userId, 'UTC');

      expect(stats.last7Days).toHaveLength(7);
      expect(stats.last7Days[0].date).toBe('2026-07-11');
      expect(stats.last7Days[6].date).toBe('2026-07-17');
      expect(stats.streak).toBe(0);
      expect(stats.prompt).toEqual(expect.any(String));
      // Stable within the day — the home screen must not reshuffle on refresh.
      expect((await getStats(userId, 'UTC')).prompt).toBe(stats.prompt);
    });

    it('counts only this month, and reports no words or moods', async () => {
      modelsMock.JournalEntry.findAll.mockResolvedValue([
        row('2026-06-30T08:00:00Z'),
        row('2026-07-02T08:00:00Z'),
      ]);

      const stats = await getStats(userId, 'UTC');

      expect(stats.entriesThisMonth).toBe(1);
      for (const k of ['wordsThisMonth', 'moodSummary', 'topTags']) expect(stats).not.toHaveProperty(k);
      expect(stats.last7Days[0]).toEqual({ date: '2026-07-11', wrote: false });
    });
  });

  describe('getHistory', () => {
    it('lists the days of the month that have entries, dates only', async () => {
      modelsMock.JournalEntry.findAll.mockResolvedValue([
        row('2026-06-30T23:00:00Z'),
        row('2026-07-01T08:00:00Z'),
        row('2026-07-02T08:00:00Z'),
        row('2026-07-02T22:00:00Z'),
      ]);

      const history = await getHistory(userId, '2026-07', 'UTC');

      expect(history.entryDates).toEqual(['2026-07-01', '2026-07-02']);
      for (const k of ['moodDays', 'topTags', 'moodSummary', 'goodDays', 'moodDeltaPercent']) {
        expect(history).not.toHaveProperty(k);
      }
    });

    it('describes the grid: 31 days starting on a Wednesday', async () => {
      modelsMock.JournalEntry.findAll.mockResolvedValue([]);

      const history = await getHistory(userId, '2026-07', 'UTC');

      expect(history.daysInMonth).toBe(31);
      // 2026-07-01 is a Wednesday; the grid starts Monday, so index 2.
      expect(history.firstWeekday).toBe(2);
    });

    it('defaults to the current month', async () => {
      modelsMock.JournalEntry.findAll.mockResolvedValue([]);

      expect((await getHistory(userId, undefined, 'UTC')).month).toBe('2026-07');
    });
  });

  describe('getOnThisDay', () => {
    it('returns the encrypted entries from earlier years, most recent first', async () => {
      const at = (iso: string, id: string) => mockEntry({ id, createdAt: new Date(iso), updatedAt: new Date(iso) });
      modelsMock.JournalEntry.findAll
        .mockResolvedValueOnce([at('2025-07-17T08:00:00Z', 'a')])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([at('2023-07-17T08:00:00Z', 'c')])
        .mockResolvedValue([]);

      const result = await getOnThisDay(userId, '2026-07-17', 'UTC');

      expect(result.entries.map((e) => e.id)).toEqual(['a', 'c']);
      expect(result.entries[0]).toEqual(expect.objectContaining({ ciphertext: 'Y2lwaGVy', sealedKey: 'c2VhbGVk' }));
      expect(result.entries[0]).not.toHaveProperty('content');
    });

    it('skips Feb 29 in years that do not have one', async () => {
      modelsMock.JournalEntry.findAll.mockResolvedValue([]);

      await getOnThisDay(userId, '2028-02-29', 'UTC');

      // 2027, 2026, 2025 and 2023 are common years; only 2024 is queried.
      expect(modelsMock.JournalEntry.findAll).toHaveBeenCalledTimes(1);
    });
  });
});
