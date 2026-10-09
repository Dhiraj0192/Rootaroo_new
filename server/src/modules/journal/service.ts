import { v4 as uuidv4 } from 'uuid';
import { Op } from 'sequelize';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { UniqueConstraintError } from 'sequelize';
import { JournalEntry, JournalMedia, JournalUpload, Household } from '../../database/models';
import { AppError, ConflictError, NotFoundError } from '../../shared/utils/errors';
import { assertOwnUploadKey, userUploadFolder } from '../../shared/utils/uploadKeys';
import { getUserHousehold as getUserHouseholdCore } from '../../shared/utils/household';
import { getSignedUrl, deleteObject, uploadBuffer } from '../../shared/utils/s3';
import logger from '../../shared/utils/logger';
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
  OnThisDayResponse,
  StreakDay,
} from './types';

/** Where the phone uploads encrypted photos and thumbnails (see the controller). */
const BLOB_AREA = 'journal/blobs';

/**
 * Look up the user's current household membership.
 * Throws 403 if the user does not belong to any household.
 */
async function getUserHousehold(userId: string): Promise<string> {
  return getUserHouseholdCore(userId, 'You must belong to a household to use the journal');
}

/**
 * The caller's timezone, so "today" on the streak card means the user's
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

/** `yyyy-MM-dd` for an instant, as the caller sees it. */
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

async function toMediaResponse(items: JournalMedia[]): Promise<JournalMediaResponse[]> {
  return Promise.all(items.map(async (m) => ({
    id: m.id,
    url: (await getSignedUrl(m.blobKey))!,
    thumbnailUrl: await getSignedUrl(m.thumbnailKey),
    sizeBytes: m.sizeBytes,
  })));
}

async function toEntryResponse(entry: JournalEntry): Promise<JournalEntryResponse> {
  const media = (entry.get('media') as JournalMedia[]) || [];
  return {
    id: entry.id,
    ciphertext: entry.ciphertext,
    sealedKey: entry.sealedKey,
    format: entry.format,
    media: await toMediaResponse(media),
    createdAt: entry.createdAt.toISOString(),
    updatedAt: entry.updatedAt.toISOString(),
  };
}

// Keys come from the client and are later signed into download links, so they
// must be ones this user uploaded — never another user's journal or vault file.
function assertOwnMediaKeys(userId: string, media?: EntryMediaInput[]): void {
  for (const m of media ?? []) {
    assertOwnUploadKey(m.blobKey, userId, [BLOB_AREA]);
    if (m.thumbnailKey) assertOwnUploadKey(m.thumbnailKey, userId, [BLOB_AREA]);
  }
}

/** The encrypted photos and thumbnails one user may keep across all entries (same as the vault). */
export const JOURNAL_QUOTA_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Stores encrypted blobs and records each key, so they count toward the user's
 * quota right away and the daily cleanup can remove any that never get attached
 * to an entry. The quota is checked before anything is written to storage.
 */
export async function uploadBlobs(
  userId: string,
  files: Array<{ buffer: Buffer; size: number }>,
): Promise<Array<{ fileName: string; size: number }>> {
  const incoming = files.reduce((sum, f) => sum + f.size, 0);
  const used = Number(await JournalUpload.sum('sizeBytes', { where: { userId } })) || 0;
  if (used + incoming > JOURNAL_QUOTA_BYTES) {
    throw new AppError(
      413,
      `Journal photo storage limit reached (${JOURNAL_QUOTA_BYTES / (1024 * 1024 * 1024)} GB). Delete some photos to add more.`,
      'JOURNAL_QUOTA_EXCEEDED',
    );
  }
  const results: Array<{ fileName: string; size: number }> = [];
  for (const f of files) {
    const { key } = await uploadBuffer(f.buffer, userUploadFolder(BLOB_AREA, userId), 'application/octet-stream');
    await JournalUpload.create({ key, userId, sizeBytes: f.size });
    results.push({ fileName: key, size: f.size });
  }
  return results;
}

/** An entry now owns these uploads: the cleanup job must leave them alone. */
async function markAttached(userId: string, media?: EntryMediaInput[]): Promise<void> {
  const keys = (media ?? []).flatMap((m) => [m.blobKey, m.thumbnailKey]).filter((k): k is string => Boolean(k));
  if (keys.length === 0) return;
  await JournalUpload.update({ attachedAt: new Date() }, { where: { userId, key: keys } });
}

/** Best effort: a stray object in the bucket is not worth failing a delete or save over. */
async function deleteBlobs(
  rows: Array<{ blobKey: string; thumbnailKey: string | null }>,
  userId?: string,
): Promise<void> {
  const keys = rows.flatMap((r) => [r.blobKey, r.thumbnailKey]).filter((k): k is string => Boolean(k));
  if (userId && keys.length > 0) {
    // The blobs are gone (or about to be), so they stop counting toward the quota.
    try {
      await JournalUpload.destroy({ where: { userId, key: keys } });
    } catch (error) {
      logger.warn('[Journal] Could not clear upload records:', (error as Error).message);
    }
  }
  await Promise.all(keys.map(async (key) => {
    try {
      await deleteObject(key);
    } catch (error) {
      logger.warn(`[Journal] Could not delete blob ${key}:`, (error as Error).message);
    }
  }));
}

/**
 * Journal entries are private to the author — every query here filters by
 * BOTH householdId and userId, on reads as well as writes, with no
 * admin-override escape hatch anywhere (unlike Feed/Vault). A record that
 * isn't the caller's own simply doesn't exist as far as any query is
 * concerned, so a wrong id 404s rather than 403s — the same
 * don't-leak-existence pattern Vault uses for its owner-scoped reads.
 *
 * The text, mood, tags and photos are encrypted on the phone: the server
 * stores the ciphertext and the sealed key and never reads them.
 */
export async function createEntry(
  userId: string,
  body: CreateEntryBody,
): Promise<JournalEntryResponse> {
  const householdId = await getUserHousehold(userId);
  assertOwnMediaKeys(userId, body.media);

  // The phone chose the id because the ciphertext is bound to it. A taken id
  // (even a deleted entry's) is refused, so one entry's sealed bytes can never
  // be replayed under an id that already meant something else.
  const taken = await JournalEntry.findOne({ where: { id: body.id }, attributes: ['id'], paranoid: false });
  if (taken) throw new ConflictError('An entry with this id already exists');

  let entry: JournalEntry;
  try {
    entry = await JournalEntry.create({
      id: body.id,
      householdId,
      userId,
      ciphertext: body.ciphertext,
      sealedKey: body.sealedKey,
      format: body.format,
    });
  } catch (error) {
    if (error instanceof UniqueConstraintError) throw new ConflictError('An entry with this id already exists');
    throw error;
  }
  await markAttached(userId, body.media);

  if (body.media && body.media.length > 0) {
    await JournalMedia.bulkCreate(
      body.media.map((m) => ({
        id: uuidv4(),
        entryId: entry.id,
        blobKey: m.blobKey,
        thumbnailKey: m.thumbnailKey || null,
        sizeBytes: m.sizeBytes,
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

  // The phone always re-encrypts the whole entry, so ciphertext, sealed key and
  // format are replaced together.
  await entry.update({ ciphertext: body.ciphertext, sealedKey: body.sealedKey, format: body.format });

  // Media is replace-the-whole-set: the composer always holds the complete
  // attachment list when it saves, so one authoritative array is simpler than
  // diffing and cannot drift. Items already on the entry arrive as `{ id }`
  // and are kept untouched; anything not listed is dropped, blob and all.
  if (body.media !== undefined) {
    const keptIds = body.media
      .filter((m): m is { id: string } => 'id' in m)
      .map((m) => m.id);
    const added = body.media.filter((m): m is EntryMediaInput => !('id' in m));
    const dropWhere = {
      entryId: entry.id,
      ...(keptIds.length > 0 ? { id: { [Op.notIn]: keptIds } } : {}),
    };

    const dropped = await JournalMedia.findAll({ where: dropWhere });
    await JournalMedia.destroy({ where: dropWhere });
    await deleteBlobs(dropped, userId);
    await markAttached(userId, added);
    if (added.length > 0) {
      await JournalMedia.bulkCreate(
        added.map((m) => ({
          id: uuidv4(),
          entryId: entry.id,
          blobKey: m.blobKey,
          thumbnailKey: m.thumbnailKey || null,
          sizeBytes: m.sizeBytes,
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

  // Hard delete: a soft-deleted row would keep the ciphertext and sealed key
  // in the database after the user asked for the entry to be gone.
  const media = await JournalMedia.findAll({ where: { entryId: entry.id } });
  await entry.destroy({ force: true });
  await JournalMedia.destroy({ where: { entryId: entry.id } });
  await deleteBlobs(media, userId);
}

// ── Stats: the streak card, the History calendar, "On this day" ──
// All of these work from entry dates alone; nothing here can read an entry.

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

  // Only the creation date of each entry: the streak spans the whole history
  // but needs nothing else, and the server has nothing else to give.
  const entries = await JournalEntry.findAll({
    where: { householdId, userId },
    attributes: ['createdAt'],
    order: [['createdAt', 'ASC']],
  });

  const dayKeys = new Set<string>();
  let entriesThisMonth = 0;
  for (const entry of entries) {
    const key = dateKey(entry.createdAt, timeZone);
    dayKeys.add(key);
    if (key.startsWith(monthKey)) entriesThisMonth += 1;
  }

  const sortedKeys = Array.from(dayKeys).sort();
  const last7Days: StreakDay[] = [];
  for (let i = 6; i >= 0; i -= 1) {
    const key = keyMinusDays(todayKey, i);
    last7Days.push({ date: key, wrote: dayKeys.has(key) });
  }

  return {
    streak: computeStreak(dayKeys, todayKey),
    bestStreak: computeBestStreak(sortedKeys),
    wroteToday: dayKeys.has(todayKey),
    entriesThisMonth,
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

export async function getHistory(
  userId: string,
  monthParam: string | undefined,
  clientTimeZone?: string,
): Promise<JournalHistoryResponse> {
  const householdId = await getUserHousehold(userId);
  const timeZone = await getTimeZone(householdId, clientTimeZone);
  const month = monthParam || dateKey(new Date(), timeZone).slice(0, 7);

  const entries = await JournalEntry.findAll({
    where: {
      householdId,
      userId,
      createdAt: {
        [Op.gte]: monthStart(month, timeZone),
        [Op.lt]: monthStart(monthMinus(month, -1), timeZone),
      },
    },
    attributes: ['createdAt'],
    order: [['createdAt', 'ASC']],
  });

  const entryDates = new Set<string>();
  for (const entry of entries) {
    const key = dateKey(entry.createdAt, timeZone);
    if (key.startsWith(month)) entryDates.add(key);
  }

  const [year, monthNumber] = month.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  // JS weeks start Sunday; the calendar grid starts Monday, so shift by one.
  const firstWeekday = (new Date(Date.UTC(year, monthNumber - 1, 1)).getUTCDay() + 6) % 7;

  return {
    month,
    entryDates: Array.from(entryDates).sort(),
    daysInMonth,
    firstWeekday,
  };
}

/**
 * Past entries written on the same month/day as `dateParam`, most recent
 * first. Returned encrypted: the phone decrypts them and builds the snippets
 * for the detail screen's "On this day" card.
 */
export async function getOnThisDay(
  userId: string,
  dateParam: string | undefined,
  clientTimeZone?: string,
): Promise<OnThisDayResponse> {
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
      start: fromZonedTime(`${key} 00:00:00`, timeZone),
      end: fromZonedTime(`${keyMinusDays(key, -1)} 00:00:00`, timeZone),
    });
  }

  const perYear = await Promise.all(
    windows.map(({ start, end }) =>
      JournalEntry.findAll({
        where: { householdId, userId, createdAt: { [Op.gte]: start, [Op.lt]: end } },
        include: [{ model: JournalMedia, as: 'media' }],
        order: [['createdAt', 'ASC']],
      }),
    ),
  );

  const entries = await Promise.all(perYear.flat().map(toEntryResponse));
  return { entries };
}
