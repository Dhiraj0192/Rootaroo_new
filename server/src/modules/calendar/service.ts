import { v4 as uuidv4 } from 'uuid';
import { fromZonedTime } from 'date-fns-tz';
import { isEntitledBatch } from '../billing/entitlement';
import { CalendarEvent, CalendarSyncState, EventInvitee, HouseholdMember, Household, User } from '../../database/models';
import { Op } from 'sequelize';
import { AppError, ForbiddenError, NotFoundError } from '../../shared/utils/errors';
import { getUserHousehold as getUserHouseholdCore } from '../../shared/utils/household';
import * as notificationService from '../../shared/services/notifications';
import { env } from '../../config/env';
import {
  exchangeCodeForTokens,
  getValidAccessToken,
  getPrimaryCalendarId,
  listGoogleEvents,
  upsertGoogleEvent,
  deleteGoogleEvent,
} from '../../shared/utils/googleCalendar';
import { generateOutlookFeedToken } from '../../shared/utils/outlookCalendar';
import {
  discoverPrimaryCalendar,
  listAppleEvents,
  upsertAppleEvent,
  deleteAppleEvent,
} from '../../shared/utils/appleCalendar';
import logger from '../../shared/utils/logger';
import { emitToHousehold } from '../billing/socketGate';
import type {
  CalendarEventResponse,
  CreateEventBody,
  UpdateEventBody,
  RepeatRule,
  GoogleCalendarConnectBody,
  GoogleCalendarStatusResponse,
  OutlookCalendarStatusResponse,
  AppleCalendarConnectBody,
  AppleCalendarStatusResponse,
} from './types';

// ── Helpers ──

/** The household the user currently belongs to (same rule as tasks/expenses). */
async function getUserHouseholdId(userId: string): Promise<string> {
  return getUserHouseholdCore(userId, 'You must belong to a household to use the calendar');
}

/** "2026-08-03T18:00:00.000Z" -> { date: "2026-08-03", time: "18:00:00" } in server-local time. */
function splitDateTime(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return { date, time };
}

/** Rebuild an ISO timestamp from the stored DATEONLY + TIME columns. */
function joinDateTime(eventDate: string, time: string | null): string {
  const d = new Date(`${eventDate}T${time || '00:00:00'}`);
  return d.toISOString();
}

function toRepeatRule(isRecurring: boolean, rule: string | null): RepeatRule {
  if (!isRecurring) return 'none';
  switch (rule) {
    case 'daily':
    case 'weekly':
    case 'monthly':
      return rule;
    default:
      return 'none';
  }
}

function toResponse(event: CalendarEvent): CalendarEventResponse {
  const inviteeIds = (event as any).invitees
    ? (event as any).invitees.map((u: User) => u.id)
    : [];
  return {
    id: event.id,
    householdId: event.householdId,
    title: event.title,
    description: event.description,
    startsAt: joinDateTime(String(event.eventDate), event.startTime),
    endsAt: joinDateTime(String(event.eventDate), event.endTime ?? event.startTime),
    inviteeIds,
    repeats: toRepeatRule(event.isRecurring, event.recurrenceRule),
    syncToGoogle: Boolean(event.googleEventId),
    createdAt: event.createdAt.toISOString(),
    createdBy: event.createdBy,
  };
}

// ── Service ──

export async function createEvent(
  userId: string,
  body: CreateEventBody,
): Promise<CalendarEventResponse> {
  const householdId = await getUserHouseholdId(userId);

  // Validate invitees belong to the same household before persisting.
  if (body.inviteeIds && body.inviteeIds.length > 0) {
    const inviteeCount = await HouseholdMember.count({
      where: { householdId, userId: body.inviteeIds },
    });
    if (inviteeCount !== body.inviteeIds.length) {
      throw new ForbiddenError('All invitees must be members of your household');
    }
  }

  const starts = splitDateTime(body.startsAt);
  const ends = splitDateTime(body.endsAt);
  const repeats = body.repeats ?? 'none';

  const event = await CalendarEvent.create({
    householdId,
    createdBy: userId,
    title: body.title,
    description: body.description ?? null,
    eventDate: starts.date as unknown as Date,
    startTime: starts.time,
    endTime: ends.time,
    isRecurring: repeats !== 'none',
    recurrenceRule: repeats === 'none' ? null : repeats,
    googleEventId: null,
  });

  if (body.inviteeIds && body.inviteeIds.length > 0) {
    await EventInvitee.bulkCreate(
      body.inviteeIds.map((inviteeId) => ({
        calendarEventId: event.id,
        userId: inviteeId,
      })),
    );
  }

  if (body.syncToGoogle) {
    pushEventToGoogleIfConnected(event, userId).catch((e: Error) =>
      logger.warn('[Calendar] Google push failed on create:', e.message),
    );
  }
  if (body.syncToApple) {
    pushEventToAppleIfConnected(event, userId).catch((e: Error) =>
      logger.warn('[Calendar] Apple push failed on create:', e.message),
    );
  }

  // Re-fetch with invitees so the response matches the mobile calendar schema.
  const withInvitees = await CalendarEvent.findByPk(event.id, {
    include: [{ model: User, as: 'invitees' }],
  });
  if (!withInvitees) throw new NotFoundError('Event not found');
  const response = toResponse(withInvitees);

  try {
    void emitToHousehold(householdId, 'calendar:event-created', response);
  } catch (e) {
    logger.warn('[WS] Calendar event broadcast failed:', (e as Error).message);
  }

  return response;
}

export async function listEvents(
  userId: string,
  query: { month?: string },
): Promise<CalendarEventResponse[]> {
  const householdId = await getUserHouseholdId(userId);

  // No month given (e.g. Dashboard's widget call) used to mean "every event
  // the household has ever created" — an unbounded, ever-growing payload
  // (confirmed 275KB in production) for a widget that only ever shows the
  // current period. Default to the current month instead.
  const month = query.month || new Date().toISOString().slice(0, 7);
  const where: Record<string, unknown> = {
    householdId,
    eventDate: { between: [`${month}-01`, `${month}-31`] },
  };

  const events = await CalendarEvent.findAll({
    where,
    include: [{ model: User, as: 'invitees' }],
    order: [
      ['eventDate', 'ASC'],
      ['startTime', 'ASC'],
    ],
  });

  return events.map(toResponse);
}

export async function getEventById(
  eventId: string,
  userId: string,
): Promise<CalendarEventResponse> {
  const householdId = await getUserHouseholdId(userId);
  const event = await CalendarEvent.findOne({
    where: { id: eventId, householdId },
    include: [{ model: User, as: 'invitees' }],
  });
  if (!event) throw new NotFoundError('Event not found');
  return toResponse(event);
}

// ── Permissions (FR-187: own events, FR-188: admin edits any) ──

async function isHouseholdAdmin(userId: string, householdId: string): Promise<boolean> {
  const membership = await HouseholdMember.findOne({ where: { userId, householdId } });
  return membership?.role === 'admin';
}

async function assertCanManageEvent(
  event: CalendarEvent,
  userId: string,
  householdId: string,
  action: string,
): Promise<void> {
  if (event.createdBy === userId) return;
  if (await isHouseholdAdmin(userId, householdId)) return;
  throw new ForbiddenError(`Only the creator or a household admin can ${action} this event`);
}

// ── Update (FR-187/188) ──

export async function updateEvent(
  eventId: string,
  userId: string,
  body: UpdateEventBody,
): Promise<CalendarEventResponse> {
  const householdId = await getUserHouseholdId(userId);
  const event = await CalendarEvent.findOne({ where: { id: eventId, householdId } });
  if (!event) throw new NotFoundError('Event not found');
  await assertCanManageEvent(event, userId, householdId, 'edit');

  if (body.title !== undefined) event.title = body.title;
  if (body.description !== undefined) event.description = body.description;
  if (body.startsAt !== undefined) {
    const s = splitDateTime(body.startsAt);
    event.eventDate = s.date as unknown as Date;
    event.startTime = s.time;
  }
  if (body.endsAt !== undefined) {
    const e = splitDateTime(body.endsAt);
    event.endTime = e.time;
  }
  if (body.repeats !== undefined) {
    event.isRecurring = body.repeats !== 'none';
    event.recurrenceRule = body.repeats === 'none' ? null : body.repeats;
  }

  // Replace invitees when the list is explicitly provided (FR-187 edit)
  if (body.inviteeIds !== undefined) {
    await EventInvitee.destroy({ where: { calendarEventId: eventId } });
    if (body.inviteeIds.length > 0) {
      const inviteeCount = await HouseholdMember.count({
        where: { householdId, userId: body.inviteeIds },
      });
      if (inviteeCount !== body.inviteeIds.length) {
        throw new ForbiddenError('All invitees must be members of your household');
      }
      await EventInvitee.bulkCreate(
        body.inviteeIds.map((inviteeId) => ({
          calendarEventId: eventId,
          userId: inviteeId,
        })),
      );
    }
  }

  await event.save();

  if (body.syncToGoogle || event.googleEventId) {
    pushEventToGoogleIfConnected(event, userId).catch((e: Error) =>
      logger.warn('[Calendar] Google push failed on update:', e.message),
    );
  }
  if (body.syncToApple || event.externalProvider === 'apple') {
    pushEventToAppleIfConnected(event, userId).catch((e: Error) =>
      logger.warn('[Calendar] Apple push failed on update:', e.message),
    );
  }

  const withInvitees = await CalendarEvent.findByPk(event.id, {
    include: [{ model: User, as: 'invitees' }],
  });
  if (!withInvitees) throw new NotFoundError('Event not found');
  return toResponse(withInvitees);
}

// ── Delete (FR-187/188) ──

export async function deleteEvent(
  eventId: string,
  userId: string,
): Promise<void> {
  const householdId = await getUserHouseholdId(userId);
  const event = await CalendarEvent.findOne({ where: { id: eventId, householdId } });
  if (!event) throw new NotFoundError('Event not found');
  await assertCanManageEvent(event, userId, householdId, 'delete');

  if (event.googleEventId) {
    const state = await CalendarSyncState.findOne({
      where: { userId: event.createdBy, provider: 'google', isActive: true },
    });
    if (state && state.googleCalendarId) {
      const accessToken = await getValidAccessToken(state);
      await deleteGoogleEvent(accessToken, state.googleCalendarId, event.googleEventId).catch((e: Error) =>
        logger.warn('[Calendar] Google delete failed:', e.message),
      );
    }
  }

  if (event.externalProvider === 'apple' && event.externalEventId) {
    const state = await CalendarSyncState.findOne({
      where: { userId: event.createdBy, provider: 'apple', isActive: true },
    });
    if (state && state.appleId && state.applePassword) {
      await deleteAppleEvent(state.appleId, state.applePassword, event.externalEventId, null).catch((e: Error) =>
        logger.warn('[Calendar] Apple delete failed:', e.message),
      );
    }
  }

  await EventInvitee.destroy({ where: { calendarEventId: eventId } });
  await event.destroy();
}

// ── iCalendar export (FR-185) ──

/** RFC 5545 line folding: lines must be ≤ 75 octets, continuation starts with a space. */
function foldIcsLine(line: string): string {
  if (line.length <= 75) return line;
  const chunks: string[] = [];
  let rest = line;
  while (rest.length > 0) {
    chunks.push(rest.slice(0, 75));
    rest = rest.slice(75);
  }
  return chunks.join('\r\n ');
}

function escapeIcs(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function toIcsDateTime(date: string, time: string | null): string {
  // DATETIME: 20260803T180000 (local, no zone — events are household-local)
  const t = (time || '00:00:00').replace(/:/g, '');
  return `${date.replace(/-/g, '')}T${t}`;
}

export async function exportHouseholdIcs(userId: string): Promise<string> {
  const householdId = await getUserHouseholdId(userId);
  const events = await CalendarEvent.findAll({
    where: { householdId },
    order: [
      ['eventDate', 'ASC'],
      ['startTime', 'ASC'],
    ],
  });

  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Rootaroo//Family Calendar//EN',
    'CALSCALE:GREGORIAN',
  ];

  for (const ev of events) {
    const dtStart = toIcsDateTime(String(ev.eventDate), ev.startTime);
    const dtEnd = toIcsDateTime(String(ev.eventDate), ev.endTime ?? ev.startTime);
    const uid = `${ev.id}@rootaroo`;
    const summary = escapeIcs(ev.title);
    const description = ev.description ? escapeIcs(ev.description) : '';

    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${uid}`);
    lines.push(`DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`);
    lines.push(`DTSTART:${dtStart}`);
    lines.push(`DTEND:${dtEnd}`);
    lines.push(`SUMMARY:${summary}`);
    if (description) lines.push(`DESCRIPTION:${description}`);
    if (ev.isRecurring && ev.recurrenceRule) {
      const freq = ev.recurrenceRule.toUpperCase();
      lines.push(`RRULE:FREQ=${freq}`);
    }
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return lines.map(foldIcsLine).join('\r\n') + '\r\n';
}

// ── 1-hour reminder (FR-186) ──

/**
 * Send a push to every household member for events starting within the next
 * hour. Called by a scheduled cron. Uses household event rows directly.
 */
export async function notifyUpcomingEvents(): Promise<number> {
  const now = new Date();
  const inOneHour = new Date(now.getTime() + 60 * 60 * 1000);

  const pad = (n: number) => String(n).padStart(2, '0');
  const dateStr = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  // Widen by a day on each side to cover every timezone offset a household
  // could be in (UTC-12..UTC+14) — the precise per-event check below,
  // using that event's own household timezone, is what actually decides
  // inclusion in the [now, now+1h] window.
  const dayMs = 24 * 60 * 60 * 1000;
  const candidateDates = [...new Set([
    dateStr(new Date(now.getTime() - dayMs)),
    dateStr(now),
    dateStr(inOneHour),
    dateStr(new Date(inOneHour.getTime() + dayMs)),
  ])];

  const events = await CalendarEvent.findAll({
    where: { eventDate: { [Op.in]: candidateDates } },
    include: [{ model: Household, as: 'household', attributes: ['timezone'] }],
  });
  const entitled = await isEntitledBatch(events.map((e) => e.householdId));

  let sent = 0;
  for (const ev of events) {
    if (!entitled.has(ev.householdId)) continue;
    const startTime = ev.startTime || '00:00:00';
    // The event's date+time is the household's local wall-clock time, not
    // the server's — parsing it as a bare Date (previously) interpreted it
    // in the server's own timezone instead, which is wrong for any
    // household not in that zone (F-11).
    const timezone = (ev as unknown as { household?: Household }).household?.timezone || 'UTC';
    const startsAt = fromZonedTime(`${ev.eventDate}T${startTime}`, timezone);
    if (startsAt < now || startsAt > inOneHour) continue;

    const householdId = ev.householdId;
    const title = ev.title;
    notificationService
      .notifyHousehold(
        householdId,
        'calendar',
        'Event starting soon',
        `${title} starts at ${startTime.slice(0, 5)}`,
        { type: 'calendar', eventId: ev.id },
      )
      .catch((e: Error) => logger.warn('[Calendar] Reminder push failed:', e.message));
    sent += 1;
  }
  return sent;
}

// ── Google Calendar two-way sync ──
//
// Each user who connects their own Google Calendar gets their own
// CalendarSyncState row. Sync is scoped per-connected-user: events they
// create in Rootaroo are pushed to *their* Google Calendar (stored on the
// event's single `googleEventId` column — so only the creator's connection
// owns the Google-side copy of a given event), and events pulled in from
// their Google Calendar are attributed to them as the creator. This matches
// the existing single-`googleEventId`-per-event schema rather than trying
// to fan a push out to every connected household member.

function toGoogleSyncStatusResponse(state: CalendarSyncState | null): GoogleCalendarStatusResponse {
  if (!state || !state.isActive) {
    return { connected: false, googleCalendarId: null, lastSyncedAt: null };
  }
  return {
    connected: true,
    googleCalendarId: state.googleCalendarId,
    lastSyncedAt: state.lastSyncedAt ? state.lastSyncedAt.toISOString() : null,
  };
}

export async function getGoogleSyncStatus(userId: string): Promise<GoogleCalendarStatusResponse> {
  const state = await CalendarSyncState.findOne({ where: { userId, provider: 'google' } });
  return toGoogleSyncStatusResponse(state);
}

/**
 * Exchange the authorization code from the mobile client's incremental-scope
 * consent flow, resolve the user's primary calendar, and store the
 * connection. Kicks off an initial sync so events show up immediately.
 */
export async function connectGoogleCalendar(
  userId: string,
  body: GoogleCalendarConnectBody,
): Promise<GoogleCalendarStatusResponse> {
  const tokens = await exchangeCodeForTokens(body.code, body.redirectUri);
  const calendarId = await getPrimaryCalendarId(tokens.accessToken);

  let state = await CalendarSyncState.findOne({ where: { userId, provider: 'google' } });
  if (state) {
    state.googleCalendarId = calendarId;
    state.accessToken = tokens.accessToken;
    state.refreshToken = tokens.refreshToken;
    state.tokenExpiresAt = tokens.expiresAt;
    state.syncToken = null; // force a fresh full sync on reconnect
    state.isActive = true;
    await state.save();
  } else {
    state = await CalendarSyncState.create({
      id: uuidv4(),
      userId,
      provider: 'google',
      googleCalendarId: calendarId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      tokenExpiresAt: tokens.expiresAt,
      isActive: true,
    });
  }

  syncUserCalendar(userId).catch((e: Error) => logger.warn('[Calendar] Initial Google sync failed:', e.message));

  return toGoogleSyncStatusResponse(state);
}

export async function disconnectGoogleCalendar(userId: string): Promise<void> {
  await CalendarSyncState.destroy({ where: { userId, provider: 'google' } });
}

/** Push a single Rootaroo event to its creator's connected Google Calendar, if any. */
async function pushEventToGoogleIfConnected(event: CalendarEvent, userId: string): Promise<void> {
  const state = await CalendarSyncState.findOne({ where: { userId, provider: 'google', isActive: true } });
  if (!state || !state.googleCalendarId) return;

  const accessToken = await getValidAccessToken(state);
  const startIso = joinDateTime(String(event.eventDate), event.startTime);
  const endIso = joinDateTime(String(event.eventDate), event.endTime ?? event.startTime);

  const googleEventId = await upsertGoogleEvent(
    accessToken,
    state.googleCalendarId,
    {
      title: event.title,
      description: event.description,
      startIso,
      endIso,
      recurrenceRule: event.isRecurring ? event.recurrenceRule : null,
    },
    event.googleEventId,
  );

  if (event.googleEventId !== googleEventId) {
    event.googleEventId = googleEventId;
    event.externalProvider = 'google';
    event.externalEventId = googleEventId;
    await event.save();
  }
}

/**
 * Pull the connected user's Google Calendar events into Rootaroo (creating/
 * updating/deleting local `CalendarEvent` rows tagged by `googleEventId`),
 * then push any locally-created, not-yet-synced events of theirs back out.
 * Called on connect and by the periodic `calendar-sync` cron job.
 */
export async function syncUserCalendar(userId: string): Promise<void> {
  const state = await CalendarSyncState.findOne({ where: { userId, provider: 'google', isActive: true } });
  if (!state || !state.googleCalendarId) return;

  const householdId = await getUserHouseholdId(userId);
  const accessToken = await getValidAccessToken(state);

  // ── Pull ──
  const { events, nextSyncToken } = await listGoogleEvents(accessToken, state.googleCalendarId, state.syncToken);

  for (const gEvent of events) {
    const existing = await CalendarEvent.findOne({ where: { googleEventId: gEvent.id, householdId } });

    if (gEvent.status === 'cancelled') {
      if (existing) await existing.destroy();
      continue;
    }

    const startIso = gEvent.start?.dateTime || (gEvent.start?.date ? `${gEvent.start.date}T00:00:00` : null);
    const endIso = gEvent.end?.dateTime || (gEvent.end?.date ? `${gEvent.end.date}T00:00:00` : startIso);
    if (!startIso) continue; // malformed event, skip

    const starts = splitDateTime(new Date(startIso).toISOString());
    const ends = splitDateTime(new Date(endIso || startIso).toISOString());
    const recurrenceFreq = gEvent.recurrence?.[0]?.match(/FREQ=([A-Z]+)/)?.[1]?.toLowerCase();
    const repeats = toRepeatRule(!!recurrenceFreq, recurrenceFreq || null);

    if (existing) {
      existing.title = gEvent.summary || existing.title;
      existing.description = gEvent.description ?? null;
      existing.eventDate = starts.date as unknown as Date;
      existing.startTime = starts.time;
      existing.endTime = ends.time;
      existing.isRecurring = repeats !== 'none';
      existing.recurrenceRule = repeats === 'none' ? null : repeats;
      await existing.save();
    } else {
      await CalendarEvent.create({
        id: uuidv4(),
        householdId,
        createdBy: userId,
        title: gEvent.summary || 'Untitled event',
        description: gEvent.description ?? null,
        eventDate: starts.date as unknown as Date,
        startTime: starts.time,
        endTime: ends.time,
        isRecurring: repeats !== 'none',
        recurrenceRule: repeats === 'none' ? null : repeats,
        googleEventId: gEvent.id,
        externalProvider: 'google',
        externalEventId: gEvent.id,
      });
    }
  }

  state.syncToken = nextSyncToken;
  state.lastSyncedAt = new Date();
  await state.save();

  // ── Push ──
  // Events this user created locally that were never sent to Google yet
  // (e.g. created with syncToGoogle before this connection existed).
  const unsynced = await CalendarEvent.findAll({
    where: { householdId, createdBy: userId, googleEventId: { [Op.is]: null } as any },
  });
  for (const ev of unsynced) {
    await pushEventToGoogleIfConnected(ev, userId).catch((e: Error) =>
      logger.warn('[Calendar] Sync push failed for event', ev.id, e.message),
    );
  }
}

// ── Outlook Calendar sync (one-way ICS subscription feed) ──
//
// Originally planned as a Graph API OAuth two-way sync (see Google/Apple
// sections' shape), but that requires an Azure AD app registration the
// client wasn't able to complete. Microsoft has no API-key/anonymous path
// into Graph — OAuth via an app registration is mandatory for any Graph
// access at all, so dropping to a lower sync frequency doesn't avoid it.
// Instead: expose each connected user's household calendar as a public,
// token-authenticated `.ics` feed URL ("webcal" subscription). Outlook
// polls it on its own schedule — no Azure app, no OAuth, but one-way
// (Rootaroo → Outlook only) and Microsoft controls the refresh cadence.

function buildOutlookFeedUrl(token: string): string {
  return `${env.serverBaseUrl}/api/v1/calendar-feed/${token}.ics`;
}

function toOutlookSyncStatusResponse(state: CalendarSyncState | null): OutlookCalendarStatusResponse {
  if (!state || !state.isActive || !state.outlookFeedToken) {
    return { connected: false, feedUrl: null };
  }
  return { connected: true, feedUrl: buildOutlookFeedUrl(state.outlookFeedToken) };
}

export async function getOutlookSyncStatus(userId: string): Promise<OutlookCalendarStatusResponse> {
  const state = await CalendarSyncState.findOne({ where: { userId, provider: 'outlook' } });
  return toOutlookSyncStatusResponse(state);
}

export async function connectOutlookCalendar(userId: string): Promise<OutlookCalendarStatusResponse> {
  let state = await CalendarSyncState.findOne({ where: { userId, provider: 'outlook' } });
  const token = state?.outlookFeedToken || generateOutlookFeedToken();

  if (state) {
    state.outlookFeedToken = token;
    state.isActive = true;
    await state.save();
  } else {
    state = await CalendarSyncState.create({
      id: uuidv4(),
      userId,
      provider: 'outlook',
      outlookFeedToken: token,
      isActive: true,
    });
  }

  return toOutlookSyncStatusResponse(state);
}

export async function disconnectOutlookCalendar(userId: string): Promise<void> {
  await CalendarSyncState.destroy({ where: { userId, provider: 'outlook' } });
}

/** Serves the `.ics` feed for a given feed token — public, unauthenticated route. */
export function emptyCalendarIcs(): string {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Rootaroo//Family Calendar//EN', 'CALSCALE:GREGORIAN', 'END:VCALENDAR'].join('\r\n') + '\r\n';
}

export async function getOutlookFeedIcs(token: string): Promise<string> {
  const state = await CalendarSyncState.findOne({ where: { outlookFeedToken: token, isActive: true } });
  if (!state) throw new AppError(404, 'Calendar feed not found');
  // §7.2: a household without entitlement gets a valid, empty calendar.
  const membership = await HouseholdMember.findOne({ where: { userId: state.userId }, attributes: ['householdId'] });
  if (!membership) return emptyCalendarIcs();
  const allowed = await isEntitledBatch([membership.householdId]);
  if (!allowed.has(membership.householdId)) return emptyCalendarIcs();
  return exportHouseholdIcs(state.userId);
}

// ── Apple Calendar two-way sync ──
//
// Same shape/scoping as Google and Outlook above, but no OAuth: the
// "credential" is the Apple ID + app-specific password, verified and
// resolved to a calendar right at connect time (see appleCalendar.ts's
// discoverPrimaryCalendar) since there's no token exchange to piggyback a
// validity check on the way Google/Outlook's connect flow gets one for free.
// `caldavCalendarHomeUrl` stores the resolved calendar's own URL (not
// literally a "home set" URL — the column name is a holdover from the
// original CalDAV-discovery-cache design; storing the calendar URL directly
// is simpler and is all the sync/push functions below actually need).

function toAppleSyncStatusResponse(state: CalendarSyncState | null): AppleCalendarStatusResponse {
  if (!state || !state.isActive) {
    return { connected: false, appleId: null, lastSyncedAt: null };
  }
  return {
    connected: true,
    appleId: state.appleId,
    lastSyncedAt: state.lastSyncedAt ? state.lastSyncedAt.toISOString() : null,
  };
}

export async function getAppleSyncStatus(userId: string): Promise<AppleCalendarStatusResponse> {
  const state = await CalendarSyncState.findOne({ where: { userId, provider: 'apple' } });
  return toAppleSyncStatusResponse(state);
}

export async function connectAppleCalendar(
  userId: string,
  body: AppleCalendarConnectBody,
): Promise<AppleCalendarStatusResponse> {
  // Fail fast on a bad app-specific password rather than storing it and
  // only discovering the problem on the next cron sync.
  const { calendarUrl } = await discoverPrimaryCalendar(body.appleId, body.appSpecificPassword);

  let state = await CalendarSyncState.findOne({ where: { userId, provider: 'apple' } });
  if (state) {
    state.appleId = body.appleId;
    state.applePassword = body.appSpecificPassword;
    state.caldavCalendarHomeUrl = calendarUrl;
    state.isActive = true;
    await state.save();
  } else {
    state = await CalendarSyncState.create({
      id: uuidv4(),
      userId,
      provider: 'apple',
      appleId: body.appleId,
      applePassword: body.appSpecificPassword,
      caldavCalendarHomeUrl: calendarUrl,
      isActive: true,
    });
  }

  syncAppleUserCalendar(userId).catch((e: Error) => logger.warn('[Calendar] Initial Apple sync failed:', e.message));

  return toAppleSyncStatusResponse(state);
}

export async function disconnectAppleCalendar(userId: string): Promise<void> {
  await CalendarSyncState.destroy({ where: { userId, provider: 'apple' } });
}

/** Push a single Rootaroo event to its creator's connected Apple calendar, if any. */
async function pushEventToAppleIfConnected(event: CalendarEvent, userId: string): Promise<void> {
  const state = await CalendarSyncState.findOne({ where: { userId, provider: 'apple', isActive: true } });
  if (!state || !state.appleId || !state.applePassword || !state.caldavCalendarHomeUrl) return;

  const startIso = joinDateTime(String(event.eventDate), event.startTime);
  const endIso = joinDateTime(String(event.eventDate), event.endTime ?? event.startTime);
  const existingHref = event.externalProvider === 'apple' ? event.externalEventId : null;

  const { href } = await upsertAppleEvent(
    state.appleId,
    state.applePassword,
    state.caldavCalendarHomeUrl,
    {
      uid: event.id,
      title: event.title,
      description: event.description,
      startIso,
      endIso,
      recurrenceRule: event.isRecurring ? event.recurrenceRule : null,
    },
    existingHref ? { href: existingHref, etag: null } : null,
  );

  if (existingHref !== href) {
    event.externalProvider = 'apple';
    event.externalEventId = href;
    await event.save();
  }
}

/**
 * Pull the connected user's Apple Calendar events into Rootaroo, then push
 * any locally-created, not-yet-synced events of theirs back out. Same
 * orchestration shape as the Google/Outlook sync functions above — called
 * on connect and by the periodic `calendar-sync` cron job.
 */
export async function syncAppleUserCalendar(userId: string): Promise<void> {
  const state = await CalendarSyncState.findOne({ where: { userId, provider: 'apple', isActive: true } });
  if (!state || !state.appleId || !state.applePassword || !state.caldavCalendarHomeUrl) return;

  const householdId = await getUserHouseholdId(userId);

  // ── Pull ──
  const { objects } = await listAppleEvents(state.appleId, state.applePassword, state.caldavCalendarHomeUrl);

  for (const obj of objects) {
    const existing = await CalendarEvent.findOne({
      where: { externalProvider: 'apple', externalEventId: obj.href, householdId },
    });

    const starts = splitDateTime(new Date(obj.startIso).toISOString());
    const ends = splitDateTime(new Date(obj.endIso).toISOString());
    const freqMap: Record<string, string> = { DAILY: 'daily', WEEKLY: 'weekly', MONTHLY: 'monthly' };
    const repeats = toRepeatRule(!!obj.recurrenceFreq, (obj.recurrenceFreq && freqMap[obj.recurrenceFreq]) || null);

    if (existing) {
      existing.title = obj.title || existing.title;
      existing.description = obj.description;
      existing.eventDate = starts.date as unknown as Date;
      existing.startTime = starts.time;
      existing.endTime = ends.time;
      existing.isRecurring = repeats !== 'none';
      existing.recurrenceRule = repeats === 'none' ? null : repeats;
      await existing.save();
    } else {
      await CalendarEvent.create({
        id: uuidv4(),
        householdId,
        createdBy: userId,
        title: obj.title,
        description: obj.description,
        eventDate: starts.date as unknown as Date,
        startTime: starts.time,
        endTime: ends.time,
        isRecurring: repeats !== 'none',
        recurrenceRule: repeats === 'none' ? null : repeats,
        externalProvider: 'apple',
        externalEventId: obj.href,
      });
    }
  }

  // No incremental cursor for Apple (see appleCalendar.ts) — just record
  // that a sync happened.
  state.lastSyncedAt = new Date();
  await state.save();

  // ── Push ──
  const unsynced = await CalendarEvent.findAll({
    where: {
      householdId,
      createdBy: userId,
      externalProvider: { [Op.is]: null } as any,
      googleEventId: { [Op.is]: null } as any,
    },
  });
  for (const ev of unsynced) {
    await pushEventToAppleIfConnected(ev, userId).catch((e: Error) =>
      logger.warn('[Calendar] Apple sync push failed for event', ev.id, e.message),
    );
  }
}
