/** Descriptor for an encrypted photo the phone has already uploaded. */
export interface EntryMediaInput {
  blobKey: string;
  thumbnailKey?: string;
  sizeBytes: number;
}

interface EncryptedBody {
  /** Base64, at most 96 KB decoded. The server never sees what is inside. */
  ciphertext: string;
  /** Base64, at most 256 bytes: the entry key sealed to the author's account key. */
  sealedKey: string;
  format: number;
}

export interface CreateEntryBody extends EncryptedBody {
  /** v4 uuid chosen by the phone; the ciphertext is bound to it. */
  id: string;
  media?: EntryMediaInput[];
}

export interface UpdateEntryBody extends EncryptedBody {
  /**
   * When present, REPLACES the entry's media set (an empty array clears it).
   * An item already on the entry is referenced by `{ id }`; a newly uploaded
   * one carries its full descriptor. See `updateMediaSchema`.
   */
  media?: Array<EntryMediaInput | { id: string }>;
}

export interface JournalMediaResponse {
  id: string;
  /** Signed link to the encrypted photo. */
  url: string;
  thumbnailUrl: string | null;
  sizeBytes: number | null;
}

export interface JournalEntryResponse {
  id: string;
  ciphertext: string;
  sealedKey: string;
  format: number;
  media: JournalMediaResponse[];
  createdAt: string;
  updatedAt: string;
}

export interface PaginatedJournalResponse {
  entries: JournalEntryResponse[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface JournalEntryQuery {
  cursor?: string;
  limit?: number;
}

/** One calendar day in the last-7-days streak strip. */
export interface StreakDay {
  /** `yyyy-MM-dd`, in the caller's timezone. */
  date: string;
  wrote: boolean;
}

/** Powers the Journal home screen's streak card and prompt. Dates only. */
export interface JournalStatsResponse {
  /** Consecutive days written up to and including today. A day missed today
   *  does NOT break the streak until tomorrow — see `computeStreak`. */
  streak: number;
  bestStreak: number;
  wroteToday: boolean;
  entriesThisMonth: number;
  /** Oldest → newest, always exactly 7 entries ending with today. */
  last7Days: StreakDay[];
  /** Today's writing prompt — stable for the whole day. */
  prompt: string;
}

/** Powers the History calendar. Dates only: the rest is decrypted on the phone. */
export interface JournalHistoryResponse {
  /** `yyyy-MM` the dates belong to. */
  month: string;
  /** Every day of the month that has at least one entry, oldest first. */
  entryDates: string[];
  daysInMonth: number;
  /** Weekday index (0 = Monday) the 1st falls on. */
  firstWeekday: number;
}

/** Encrypted entries written on the same month/day in earlier years. */
export interface OnThisDayResponse {
  entries: JournalEntryResponse[];
}
