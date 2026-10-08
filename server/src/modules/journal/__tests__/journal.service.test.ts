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

const modelsMock = models as any;

function mockEntry(overrides: any = {}) {
  const entry: any = {
    id: entryId,
    householdId,
    userId,
    content: 'Today was a good day',
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
    it('should create a text-only entry', async () => {
      const entry = mockEntry();
      modelsMock.JournalEntry.create.mockResolvedValue(entry);
      modelsMock.JournalEntry.findByPk.mockResolvedValue(entry);

      const result = await createEntry(userId, { content: 'Today was a good day' });

      expect(modelsMock.JournalEntry.create).toHaveBeenCalledWith(
        expect.objectContaining({ householdId, userId, content: 'Today was a good day' }),
      );
      expect(modelsMock.JournalMedia.bulkCreate).not.toHaveBeenCalled();
      expect(result.content).toBe('Today was a good day');
    });

    it('should create an entry with media', async () => {
      const media = [{ id: 'm1', mediaUrl: `journal/images/${userId}/photo.jpg`, mediaType: 'photo', thumbnailUrl: null, fileSizeBytes: 1000 }];
      const entry = mockEntry({ content: null, media });
      modelsMock.JournalEntry.create.mockResolvedValue(entry);
      modelsMock.JournalEntry.findByPk.mockResolvedValue(entry);

      const result = await createEntry(userId, {
        media: [{ mediaUrl: `journal/images/${userId}/photo.jpg`, mediaType: 'photo', fileSizeBytes: 1000 }],
      });

      expect(modelsMock.JournalMedia.bulkCreate).toHaveBeenCalledWith([
        expect.objectContaining({ entryId, mediaUrl: `journal/images/${userId}/photo.jpg`, mediaType: 'photo' }),
      ]);
      expect(result.media).toHaveLength(1);
    });

    it('should throw ForbiddenError if user is not a household member', async () => {
      modelsMock.HouseholdMember.findOne.mockResolvedValue(null);

      await expect(createEntry(userId, { content: 'Hi' })).rejects.toThrow(ForbiddenError);
    });

    it("refuses to attach someone else's upload, so it can't be turned into a download link", async () => {
      for (const mediaUrl of [`journal/images/${otherUserId}/photo.jpg`, `vault/${householdId}/secret`, 'https://example.com/x.jpg']) {
        await expect(createEntry(userId, { media: [{ mediaUrl, mediaType: 'photo' }] } as any)).rejects.toThrow(ForbiddenError);
      }
      await expect(createEntry(userId, {
        media: [{ mediaUrl: `journal/images/${userId}/p.jpg`, thumbnailUrl: `journal/thumbnails/${otherUserId}/t.jpg`, mediaType: 'photo' }],
      } as any)).rejects.toThrow(ForbiddenError);
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
    it('should update the content of the caller\'s own entry', async () => {
      const entry = mockEntry();
      modelsMock.JournalEntry.findOne.mockResolvedValue(entry);
      modelsMock.JournalEntry.findByPk.mockResolvedValue(mockEntry({ content: 'Updated' }));

      const result = await updateEntry(userId, entryId, { content: 'Updated' });

      expect(entry.update).toHaveBeenCalledWith({ content: 'Updated' });
      expect(result.content).toBe('Updated');
    });

    it('should throw NotFoundError for an entry that is not the caller\'s own', async () => {
      modelsMock.JournalEntry.findOne.mockResolvedValue(null);

      await expect(updateEntry(otherUserId, entryId, { content: 'Nope' })).rejects.toThrow(NotFoundError);
    });
  });

  describe('deleteEntry', () => {
    it('should delete the caller\'s own entry', async () => {
      const entry = mockEntry();
      modelsMock.JournalEntry.findOne.mockResolvedValue(entry);

      await deleteEntry(userId, entryId);

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

  /** A bare entry row as `getStats`/`getHistory` read it (no media, no `get`). */
  function row(dateIso: string, extra: any = {}) {
    return { createdAt: new Date(dateIso), content: 'a few words here', mood: null, tags: null, ...extra };
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
      expect(stats.last7Days[5]).toMatchObject({ date: '2026-07-16', written: true });
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

    it('sums words only for the current month', async () => {
      modelsMock.JournalEntry.findAll.mockResolvedValue([
        row('2026-06-30T08:00:00Z', { content: 'one two three four five' }),
        row('2026-07-02T08:00:00Z', { content: 'one two three' }),
      ]);

      const stats = await getStats(userId, 'UTC');

      expect(stats.entriesThisMonth).toBe(1);
      expect(stats.wordsThisMonth).toBe(3);
    });
  });

  describe('getHistory', () => {
    it('takes the last mood of a day and reports the modal mood', async () => {
      modelsMock.JournalEntry.findAll.mockResolvedValue([
        row('2026-07-01T08:00:00Z', { mood: 'calm', tags: ['gratitude'] }),
        row('2026-07-02T08:00:00Z', { mood: 'low' }),
        // Same day, written later — the day ended calm.
        row('2026-07-02T22:00:00Z', { mood: 'calm', tags: ['gratitude', 'family'] }),
        row('2026-07-03T08:00:00Z', { mood: 'happy' }),
      ]);

      const history = await getHistory(userId, '2026-07', 'UTC');

      expect(history.moodDays).toEqual([
        { date: '2026-07-01', mood: 'calm', score: 4 },
        { date: '2026-07-02', mood: 'calm', score: 4 },
        { date: '2026-07-03', mood: 'happy', score: 5 },
      ]);
      expect(history.moodSummary).toBe('Mostly calm');
      expect(history.goodDays).toBe(3);
      expect(history.topTags).toEqual([
        { tag: 'gratitude', count: 2 },
        { tag: 'family', count: 1 },
      ]);
    });

    it('compares against the previous month per day, not per entry', async () => {
      modelsMock.JournalEntry.findAll.mockResolvedValue([
        // June: one rough day, written about three times over.
        row('2026-06-10T08:00:00Z', { mood: 'rough' }),
        row('2026-06-10T12:00:00Z', { mood: 'rough' }),
        row('2026-06-10T18:00:00Z', { mood: 'rough' }),
        // July: one calm day. 4 vs 1 → +300%, regardless of June's entry count.
        row('2026-07-05T08:00:00Z', { mood: 'calm' }),
      ]);

      const history = await getHistory(userId, '2026-07', 'UTC');

      expect(history.moodDeltaPercent).toBe(300);
    });

    it('reports no delta when the previous month recorded no mood', async () => {
      modelsMock.JournalEntry.findAll.mockResolvedValue([
        row('2026-07-05T08:00:00Z', { mood: 'calm' }),
      ]);

      expect((await getHistory(userId, '2026-07', 'UTC')).moodDeltaPercent).toBeNull();
    });

    it('describes the grid: 31 days starting on a Wednesday', async () => {
      modelsMock.JournalEntry.findAll.mockResolvedValue([]);

      const history = await getHistory(userId, '2026-07', 'UTC');

      expect(history.daysInMonth).toBe(31);
      // 2026-07-01 is a Wednesday; the grid starts Monday, so index 2.
      expect(history.firstWeekday).toBe(2);
      expect(history.moodSummary).toBeNull();
    });

    it('defaults to the current month', async () => {
      modelsMock.JournalEntry.findAll.mockResolvedValue([]);

      expect((await getHistory(userId, undefined, 'UTC')).month).toBe('2026-07');
    });
  });

  describe('getOnThisDay', () => {
    it('returns one entry per past year, most recent first', async () => {
      modelsMock.JournalEntry.findOne
        .mockResolvedValueOnce({ id: 'a', createdAt: new Date('2025-07-17T08:00:00Z'), content: 'Yellowstone trip' })
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'c', createdAt: new Date('2023-07-17T08:00:00Z'), content: 'Moving day' })
        .mockResolvedValue(null);

      const results = await getOnThisDay(userId, '2026-07-17', 'UTC');

      expect(results).toEqual([
        { id: 'a', date: '2025-07-17', yearsAgo: 1, snippet: 'Yellowstone trip' },
        { id: 'c', date: '2023-07-17', yearsAgo: 3, snippet: 'Moving day' },
      ]);
    });

    it('skips Feb 29 in years that do not have one', async () => {
      modelsMock.JournalEntry.findOne.mockResolvedValue(null);

      await getOnThisDay(userId, '2028-02-29', 'UTC');

      // 2027, 2026, 2025 and 2023 are common years; only 2024 is queried.
      expect(modelsMock.JournalEntry.findOne).toHaveBeenCalledTimes(1);
    });
  });
});
