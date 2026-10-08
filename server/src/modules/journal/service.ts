import { v4 as uuidv4 } from 'uuid';
import { Op } from 'sequelize';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { JournalEntry, JournalMedia, Household } from '../../database/models';
import { NotFoundError } from '../../shared/utils/errors';
import { assertOwnUploadKey } from '../../shared/utils/uploadKeys';
import { getUserHousehold as getUserHouseholdCore } from '../../shared/utils/household';
import { getSignedUrl } from '../../shared/utils/s3';
import { MOOD_VALUES } from './validation';
import type {
  CreateEntryBody,
  UpdateEntryBody,
  JournalEntryResponse,
  JournalMediaResponse,
  JournalEntryQuery,
  PaginatedJournalResponse,
  EntryMediaInput,
  JournalStatsResponse,
  JournalHistoryResponse,
  OnThisDayEntry,
  Mood,
  MoodDay,
  StreakDay,
  TagCount,
} from './types';

/**
 * Look up the user's current household membership.
 * Throws 403 if the user does not belong to any household.
 */
async function getUserHousehold(userId: string): Promise<string> {
  return getUserHouseholdCore(userId, 'You must belong to a household to use the journal');
}

/**
 * The household's timezone, so "today" on the streak card means the user's
 * today and not the server's. Same self-heal rule the dashboard uses: trust
 * the caller's `X-Timezone` when the stored value disagrees, since a phone
 * knows where it is and a household row may never have been told.
 */
async function getTimeZone(householdId: string, clientTimeZone?: string): Promise<string> {
  if (clientTimeZone && isValidTimeZone(clientTimeZone)) return clientTimeZone;
  const household = await Household.findByPk(householdId, { attributes: ['id', 'timezone'] });
  return household?.timezone || 'UTC';
}

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** `yyyy-MM-dd` for an instant, as the household sees it. */
function dateKey(d: Date, timeZone: string): string {
  return formatInTimeZone(d, timeZone, 'yyyy-MM-dd');
}

/** Plain calendar-day arithmetic on a `yyyy-MM-dd` key (no DST involved). */
function keyMinusDays(key: string, n: number): string {
  const [y, m, day] = key.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1, day));
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/** Words in an entry body — the count the composer and detail header show. */
function countWords(content: string | null): number {
  if (!content) return 0;
  const trimmed = content.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

function moodScore(mood: Mood): number {
  // 1-based so a `rough` day still draws a visible bar in the History chart;
  // a 0 would render as nothing and read as "no entry" instead of "bad day".
  return MOOD_VALUES.indexOf(mood) + 1;
}

function normalizeTags(tags: unknown): string[] {
  return Array.isArray(tags) ? (tags as string[]) : [];
}

async function toMediaResponse(items: JournalMedia[]): Promise<JournalMediaResponse[]> {
  return Promise.all(items.map(async (m) => ({
    id: m.id,
    mediaUrl: (await getSignedUrl(m.mediaUrl))!,
    mediaType: m.mediaType,
    thumbnailUrl: await getSignedUrl(m.thumbnailUrl),
    fileSizeBytes: m.fileSizeBytes,
  })));
}

async function toEntryResponse(entry: JournalEntry): Promise<JournalEntryResponse> {
  const media = (entry.get('media') as JournalMedia[]) || [];
  return {
    id: entry.id,
    content: entry.content,
    mood: (entry.mood as Mood) || null,
    tags: normalizeTags(entry.tags),
    wordCount: countWords(entry.content),
    media: await toMediaResponse(media),
    createdAt: entry.createdAt.toISOString(),
    updatedAt: entry.updatedAt.toISOString(),
  };
}

// Keys come from the client and are later signed into download links, so they
// must be ones this user uploaded — never another user's journal or vault file.
function assertOwnMediaKeys(userId: string, media?: EntryMediaInput[]): void {
  for (const m of media ?? []) {
    assertOwnUploadKey(m.mediaUrl, userId, ['journal/images']);
    if (m.thumbnailUrl) assertOwnUploadKey(m.thumbnailUrl, userId, ['journal/thumbnails']);
  }
}

/**
 * Journal entries are private to the author — every query here filters by
 * BOTH householdId and userId, on reads as well as writes, with no
 * admin-override escape hatch anywhere (unlike Feed/Vault). A record that
 * isn't the caller's own simply doesn't exist as far as any query is
 * concerned, so a wrong id 404s rather than 403s — the same
 * don't-leak-existence pattern Vault uses for its owner-scoped reads.
 */
export async function createEntry(
  userId: string,
  body: CreateEntryBody,
): Promise<JournalEntryResponse> {
  const householdId = await getUserHousehold(userId);
  assertOwnMediaKeys(userId, body.media);

  const entry = await JournalEntry.create({
    id: uuidv4(),
    householdId,
    userId,
    content: body.content || null,
    mood: body.mood || null,
    tags: body.tags && body.tags.length > 0 ? body.tags : null,
  });

  if (body.media && body.media.length > 0) {
    await JournalMedia.bulkCreate(
      body.media.map((m) => ({
        id: uuidv4(),
        entryId: entry.id,
        mediaUrl: m.mediaUrl,
        mediaType: m.mediaType,
        thumbnailUrl: m.thumbnailUrl || null,
        fileSizeBytes: m.fileSizeBytes || null,
      })),
    );
  }

  const fullEntry = await JournalEntry.findByPk(entry.id, {
    include: [{ model: JournalMedia, as: 'media' }],
  });
  if (!fullEntry) throw new Error('Failed to load created journal entry');

  return await toEntryResponse(fullEntry);
}

export async function listEntries(
  userId: string,
  options: JournalEntryQuery,
): Promise<PaginatedJournalResponse> {
  const householdId = await getUserHousehold(userId);
  const limit = options.limit || 20;
  const where: any = { householdId, userId };

  if (options.cursor) {
    const cursorEntry = await JournalEntry.findOne({
      where: { id: options.cursor, householdId, userId },
      attributes: ['createdAt'],
      paranoid: false,
    });
    if (cursorEntry) {
      where.createdAt = { [Op.lt]: cursorEntry.createdAt };
    }
  }

  const entries = await JournalEntry.findAll({
    where,
    include: [{ model: JournalMedia, as: 'media' }],
    order: [['createdAt', 'DESC']],
    limit: limit + 1,
  });

  const hasMore = entries.length > limit;
  const pageEntries = entries.slice(0, limit);

  return {
    entries: await Promise.all(pageEntries.map(toEntryResponse)),
    nextCursor: hasMore ? pageEntries[pageEntries.length - 1].id : null,
    hasMore,
  };
}

export async function getEntryById(
  userId: string,
  entryId: string,
): Promise<JournalEntryResponse> {
  const householdId = await getUserHousehold(userId);

  const entry = await JournalEntry.findOne({
    where: { id: entryId, householdId, userId },
    include: [{ model: JournalMedia, as: 'media' }],
  });
  if (!entry) throw new NotFoundError('Journal entry');

  return await toEntryResponse(entry);
}

export async function updateEntry(
  userId: string,
  entryId: string,
  body: UpdateEntryBody,
): Promise<JournalEntryResponse> {
  const householdId = await getUserHousehold(userId);

  const entry = await JournalEntry.findOne({
    where: { id: entryId, householdId, userId },
  });
  if (!entry) throw new NotFoundError('Journal entry');
  assertOwnMediaKeys(userId, body.media?.filter((m): m is EntryMediaInput => !('id' in m)));

  // PATCH semantics: only the keys the client actually sent are touched, so
  // saving a mood from the detail sheet can't blank the entry's tags.
  const changes: Record<string, unknown> = {};
  if (body.content !== undefined) changes.content = body.content;
  if (body.mood !== undefined) changes.mood = body.mood;
  if (body.tags !== undefined) changes.tags = body.tags.length > 0 ? body.tags : null;
  if (Object.keys(changes).length > 0) await entry.update(changes);

  // Media is replace-the-whole-set: the composer always holds the complete
  // attachment list when it saves, so one authoritative array is simpler than
  // diffing and cannot drift. Items already on the entry arrive as `{ id }`
  // and are kept untouched — the client only ever saw their signed URLs, and
  // writing one of those back would replace the S3 key with an expiring link.
  if (body.media !== undefined) {
    const keptIds = body.media
      .filter((m): m is { id: string } => 'id' in m)
      .map((m) => m.id);
    const added = body.media.filter((m): m is EntryMediaInput => !('id' in m));

    await JournalMedia.destroy({
      where: {
        entryId: entry.id,
        ...(keptIds.length > 0 ? { id: { [Op.notIn]: keptIds } } : {}),
      },
    });
    if (added.length > 0) {
      await JournalMedia.bulkCreate(
        added.map((m) => ({
          id: uuidv4(),
          entryId: entry.id,
          mediaUrl: m.mediaUrl,
          mediaType: m.mediaType,
          thumbnailUrl: m.thumbnailUrl || null,
          fileSizeBytes: m.fileSizeBytes || null,
        })),
      );
    }
  }

  const fullEntry = await JournalEntry.findByPk(entry.id, {
    include: [{ model: JournalMedia, as: 'media' }],
  });
  if (!fullEntry) throw new Error('Failed to load updated journal entry');

  return await toEntryResponse(fullEntry);
}

export async function deleteEntry(userId: string, entryId: string): Promise<void> {
  const householdId = await getUserHousehold(userId);

  const entry = await JournalEntry.findOne({
    where: { id: entryId, householdId, userId },
  });
  if (!entry) throw new NotFoundError('Journal entry');

  await entry.destroy();
}

// ── Stats: the streak card, the History chart, "On this day" ──

/** How far back "On this day" looks. Five anniversaries is already more than
 *  any card can show; beyond that it is five wasted queries. */
const ON_THIS_DAY_YEARS = 5;

const pad = (n: number) => String(n).padStart(2, '0');

const isLeapYear = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/**
 * Prompts rotate by day-of-year rather than at random so the home screen shows
 * the same question all day. A user who opens the app twice before lunch is
 * not meant to see two different prompts.
 */
const PROMPTS = [
  'What’s one small thing that went better than you expected today?',
  'Who made your day easier, and did you tell them?',
  'What did you notice today that you would have walked past last month?',
  'What are you carrying right now that you could put down?',
  'Describe today in one sentence you’d want to read a year from now.',
  'What did you say yes to today — and was it worth it?',
  'Where did the time actually go today?',
  'What is one thing you want tomorrow to have that today didn’t?',
  'What made you laugh?',
  'What felt like home today?',
  'What would you do again exactly the same way?',
  'What is quietly working in your life right now?',
];

const MOOD_LABELS: Record<Mood, string> = {
  rough: 'Mostly rough',
  low: 'Mostly low',
  neutral: 'Mostly steady',
  calm: 'Mostly calm',
  happy: 'Mostly bright',
};

function promptForDay(dayKey: string): string {
  // A stable hash of the date string — the point is only that consecutive days
  // land on different prompts, not that the sequence is unguessable.
  const [y, m, d] = dayKey.split('-').map(Number);
  const ordinal = Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
  return PROMPTS[((ordinal % PROMPTS.length) + PROMPTS.length) % PROMPTS.length];
}

/**
 * Consecutive days written, counting back from today.
 *
 * A day with no entry *yet* does not break the streak: a user who opens the
 * app at 9am on day 10 should still see "9 days" with "write today to keep it
 * going", not a demoralising reset to zero for the crime of being early. So
 * the walk starts at today if today has an entry, and at yesterday otherwise.
 */
function computeStreak(dayKeys: Set<string>, todayKey: string): number {
  let cursor = dayKeys.has(todayKey) ? todayKey : keyMinusDays(todayKey, 1);
  let streak = 0;
  while (dayKeys.has(cursor)) {
    streak += 1;
    cursor = keyMinusDays(cursor, 1);
  }
  return streak;
}

/** The longest run of consecutive days anywhere in the user's history. */
function computeBestStreak(sortedKeys: string[]): number {
  let best = 0;
  let run = 0;
  let previous: string | null = null;
  for (const key of sortedKeys) {
    run = previous !== null && keyMinusDays(key, 1) === previous ? run + 1 : 1;
    previous = key;
    if (run > best) best = run;
  }
  return best;
}

export async function getStats(
  userId: string,
  clientTimeZone?: string,
): Promise<JournalStatsResponse> {
  const householdId = await getUserHousehold(userId);
  const timeZone = await getTimeZone(householdId, clientTimeZone);
  const todayKey = dateKey(new Date(), timeZone);

  const monthKey = todayKey.slice(0, 7);

  // Two reads rather than one, because they want different things:
  //
  //   · the streak spans the user's whole history, but needs only the day and
  //     mood of each entry — no bodies. Selecting `content` here too would
  //     drag every word ever written (up to 10 000 chars an entry) across the
  //     wire on every home-screen focus, purely to word-count the last few.
  //   · the month totals need the bodies, but only this month's.
  const [entries, monthEntries] = await Promise.all([
    JournalEntry.findAll({
      where: { householdId, userId },
      attributes: ['createdAt', 'mood'],
      order: [['createdAt', 'ASC']],
    }),
    JournalEntry.findAll({
      where: {
        householdId,
        userId,
        createdAt: { [Op.gte]: fromZonedTime(`${monthKey}-01 00:00:00`, timeZone) },
      },
      attributes: ['createdAt', 'content'],
    }),
  ]);

  const dayKeys = new Set<string>();
  const moodByDay = new Map<string, Mood>();

  for (const entry of entries) {
    const key = dateKey(entry.createdAt, timeZone);
    dayKeys.add(key);
    // Later entries win: the last mood you recorded is how the day ended up.
    if (entry.mood) moodByDay.set(key, entry.mood as Mood);
  }

  let entriesThisMonth = 0;
  let wordsThisMonth = 0;
  for (const entry of monthEntries) {
    // The query's lower bound is this month's local midnight, but an entry
    // written late on the last day of next month would also pass it once the
    // clock rolls over — so the day key still decides.
    if (!dateKey(entry.createdAt, timeZone).startsWith(monthKey)) continue;
    entriesThisMonth += 1;
    wordsThisMonth += countWords(entry.content);
  }

  const sortedKeys = Array.from(dayKeys).sort();
  const last7Days: StreakDay[] = [];
  for (let i = 6; i >= 0; i -= 1) {
    const key = keyMinusDays(todayKey, i);
    last7Days.push({ date: key, written: dayKeys.has(key), mood: moodByDay.get(key) || null });
  }

  return {
    streak: computeStreak(dayKeys, todayKey),
    bestStreak: computeBestStreak(sortedKeys),
    wroteToday: dayKeys.has(todayKey),
    entriesThisMonth,
    wordsThisMonth,
    last7Days,
    prompt: promptForDay(todayKey),
  };
}

/** The UTC instant of local midnight on the 1st of `monthKey` (`yyyy-MM`). */
function monthStart(monthKey: string, timeZone: string): Date {
  return fromZonedTime(`${monthKey}-01 00:00:00`, timeZone);
}

/** `yyyy-MM` `n` months before `monthKey`. */
function monthMinus(monthKey: string, n: number): string {
  const [y, m] = monthKey.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 - n, 1));
  return d.toISOString().slice(0, 7);
}

/** Average mood score across days that recorded one; null when none did. */
function averageScore(moods: Mood[]): number | null {
  if (moods.length === 0) return null;
  return moods.reduce((sum, mood) => sum + moodScore(mood), 0) / moods.length;
}

export async function getHistory(
  userId: string,
  monthParam: string | undefined,
  clientTimeZone?: string,
): Promise<JournalHistoryResponse> {
  const householdId = await getUserHousehold(userId);
  const timeZone = await getTimeZone(householdId, clientTimeZone);
  const month = monthParam || dateKey(new Date(), timeZone).slice(0, 7);
  const previousMonth = monthMinus(month, 1);

  // One query spanning both months: the delta needs last month's moods, and
  // fetching them separately would double the round trips for no benefit.
  const entries = await JournalEntry.findAll({
    where: {
      householdId,
      userId,
      createdAt: {
        [Op.gte]: monthStart(previousMonth, timeZone),
        [Op.lt]: monthStart(monthMinus(month, -1), timeZone),
      },
    },
    attributes: ['createdAt', 'mood', 'tags'],
    order: [['createdAt', 'ASC']],
  });

  const moodByDay = new Map<string, Mood>();
  const entryDates = new Set<string>();
  // Both months are reduced to one mood per day before they are compared, so
  // the delta measures how the days felt — not how many times someone wrote.
  const previousMoodByDay = new Map<string, Mood>();
  const tagCounts = new Map<string, number>();

  for (const entry of entries) {
    const key = dateKey(entry.createdAt, timeZone);
    if (key.startsWith(previousMonth)) {
      if (entry.mood) previousMoodByDay.set(key, entry.mood as Mood);
      continue;
    }
    if (!key.startsWith(month)) continue;
    entryDates.add(key);
    if (entry.mood) moodByDay.set(key, entry.mood as Mood);
    for (const tag of normalizeTags(entry.tags)) {
      tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
    }
  }

  const moodDays: MoodDay[] = Array.from(moodByDay.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, mood]) => ({ date, mood, score: moodScore(mood) }));

  // The summary names the month's *most frequent* mood, not its average — a
  // month of mostly-calm days with one rough one reads as calm, and averaging
  // would blur it into "steady".
  const frequency = new Map<Mood, number>();
  for (const { mood } of moodDays) frequency.set(mood, (frequency.get(mood) || 0) + 1);
  let modalMood: Mood | null = null;
  for (const [mood, count] of frequency) {
    if (modalMood === null || count > frequency.get(modalMood)!) modalMood = mood;
  }

  const currentAverage = averageScore(moodDays.map((d) => d.mood));
  const previousAverage = averageScore(Array.from(previousMoodByDay.values()));
  const moodDeltaPercent =
    currentAverage !== null && previousAverage !== null && previousAverage > 0
      ? Math.round(((currentAverage - previousAverage) / previousAverage) * 100)
      : null;

  const topTags: TagCount[] = Array.from(tagCounts.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
    .slice(0, 6);

  const [year, monthNumber] = month.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  // JS weeks start Sunday; the calendar grid starts Monday, so shift by one.
  const firstWeekday = (new Date(Date.UTC(year, monthNumber - 1, 1)).getUTCDay() + 6) % 7;

  return {
    month,
    moodDays,
    entryDates: Array.from(entryDates).sort(),
    topTags,
    moodSummary: modalMood ? MOOD_LABELS[modalMood] : null,
    goodDays: moodDays.filter((d) => d.score > moodScore('neutral')).length,
    moodDeltaPercent,
    daysInMonth,
    firstWeekday,
  };
}

/**
 * Past entries written on the same month/day as `dateParam`, most recent
 * first. Powers the detail screen's "On this day" card.
 */
export async function getOnThisDay(
  userId: string,
  dateParam: string | undefined,
  clientTimeZone?: string,
): Promise<OnThisDayEntry[]> {
  const householdId = await getUserHousehold(userId);
  const timeZone = await getTimeZone(householdId, clientTimeZone);
  const anchor = dateParam || dateKey(new Date(), timeZone);
  const [anchorYear, anchorMonth, anchorDay] = anchor.split('-').map(Number);

  // Query one bounded day-window per past year rather than scanning the whole
  // journal: matching month/day in SQL would have to happen on a UTC column
  // and would land on the wrong local day, and loading every older entry to
  // filter in JS grows without limit as the journal does.
  const windows = [];
  for (let back = 1; back <= ON_THIS_DAY_YEARS; back += 1) {
    const year = anchorYear - back;
    // Feb 29 has no counterpart in a common year; `fromZonedTime` would roll it
    // to Mar 1, so skip the year instead of surfacing the wrong day.
    if (anchorMonth === 2 && anchorDay === 29 && !isLeapYear(year)) continue;
    const key = `${year}-${pad(anchorMonth)}-${pad(anchorDay)}`;
    windows.push({
      yearsAgo: back,
      start: fromZonedTime(`${key} 00:00:00`, timeZone),
      end: fromZonedTime(`${keyMinusDays(key, -1)} 00:00:00`, timeZone),
    });
  }

  const perYear = await Promise.all(
    windows.map(async ({ yearsAgo, start, end }) => {
      const entry = await JournalEntry.findOne({
        where: { householdId, userId, createdAt: { [Op.gte]: start, [Op.lt]: end } },
        attributes: ['id', 'createdAt', 'content'],
        order: [['createdAt', 'ASC']],
      });
      if (!entry) return null;
      return {
        id: entry.id,
        date: dateKey(entry.createdAt, timeZone),
        yearsAgo,
        snippet: (entry.content || '').trim().slice(0, 120),
      };
    }),
  );

  return perYear.filter((e): e is OnThisDayEntry => e !== null);
}
