jest.mock('../../billing/entitlement', () => ({ isEntitledBatch: jest.fn(async (ids: string[]) => new Set(ids)) }));
import { isEntitledBatch } from '../../billing/entitlement';
jest.mock('../../billing/socketGate', () => ({ emitToHousehold: jest.fn().mockResolvedValue(undefined) }));
import {
  createEvent,
  listEvents,
  getEventById,
  updateEvent,
  deleteEvent,
  exportHouseholdIcs,
  notifyUpcomingEvents,
  getGoogleSyncStatus,
  connectGoogleCalendar,
  disconnectGoogleCalendar,
  syncUserCalendar,
  getOutlookSyncStatus,
  connectOutlookCalendar,
  disconnectOutlookCalendar,
  getOutlookFeedIcs,
  getAppleSyncStatus,
  connectAppleCalendar,
  disconnectAppleCalendar,
  syncAppleUserCalendar,
  emptyCalendarIcs,
} from '../service';
import { ForbiddenError } from '../../../shared/utils/errors';

const userId = '550e8400-e29b-41d4-a716-446655440001';
const adminId = '660e8400-e29b-41d4-a716-446655440009';
const otherUserId = '660e8400-e29b-41d4-a716-446655440003';
const householdId = '770e8400-e29b-41d4-a716-446655440003';
const eventId = '880e8400-e29b-41d4-a716-446655440004';

jest.mock('../../../database/models', () => ({
  CalendarEvent: {
    create: jest.fn(),
    findAll: jest.fn(),
    findOne: jest.fn(),
    findByPk: jest.fn(),
  },
  EventInvitee: {
    bulkCreate: jest.fn(),
    destroy: jest.fn(),
  },
  HouseholdMember: {
    findOne: jest.fn(),
    count: jest.fn(),
  },
  CalendarSyncState: {
    create: jest.fn(),
    findOne: jest.fn(),
    findAll: jest.fn(),
    destroy: jest.fn(),
  },
  User: {},
}));

jest.mock('../../../shared/services/notifications', () => ({
  notifyHousehold: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../../shared/utils/googleCalendar', () => ({
  exchangeCodeForTokens: jest.fn(),
  getValidAccessToken: jest.fn(),
  getPrimaryCalendarId: jest.fn(),
  listGoogleEvents: jest.fn(),
  upsertGoogleEvent: jest.fn(),
  deleteGoogleEvent: jest.fn(),
}));

jest.mock('../../../shared/utils/outlookCalendar', () => ({
  generateOutlookFeedToken: jest.fn(),
}));

jest.mock('../../../shared/utils/appleCalendar', () => ({
  discoverPrimaryCalendar: jest.fn(),
  listAppleEvents: jest.fn(),
  upsertAppleEvent: jest.fn(),
  deleteAppleEvent: jest.fn(),
}));

import * as models from '../../../database/models';
import * as notifications from '../../../shared/services/notifications';
import * as googleCalendar from '../../../shared/utils/googleCalendar';
import * as outlookCalendar from '../../../shared/utils/outlookCalendar';
import * as appleCalendar from '../../../shared/utils/appleCalendar';

function fakeEvent(overrides: any = {}) {
  return {
    id: eventId,
    householdId,
    createdBy: userId,
    title: 'Family dinner',
    description: null,
    eventDate: '2026-08-03',
    startTime: '18:00:00',
    endTime: '20:00:00',
    isRecurring: false,
    recurrenceRule: null,
    googleEventId: null,
    createdAt: new Date('2026-08-03T10:00:00.000Z'),
    household: { timezone: 'UTC' },
    invitees: [],
    save: jest.fn().mockResolvedValue(undefined),
    destroy: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const modelsMock = models as jest.Mocked<typeof models>;

beforeEach(() => {
  jest.clearAllMocks();
  (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({
    householdId,
    userId,
    role: 'member',
  });
});

describe('createEvent', () => {
  it('creates an event with description (FR-181)', async () => {
    (modelsMock.HouseholdMember.count as jest.Mock).mockResolvedValue(0);
    (modelsMock.CalendarEvent.create as jest.Mock).mockResolvedValue(fakeEvent());
    (modelsMock.CalendarEvent.findByPk as jest.Mock).mockResolvedValue(fakeEvent());

    await createEvent(userId, {
      title: 'Family dinner',
      startsAt: '2026-08-03T18:00:00.000Z',
      endsAt: '2026-08-03T20:00:00.000Z',
      description: 'Bring dessert',
    });

    expect(modelsMock.CalendarEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'Bring dessert' }),
    );
  });
});

describe('listEvents (FR-180/182)', () => {
  it('lists household events and filters by month', async () => {
    (modelsMock.CalendarEvent.findAll as jest.Mock).mockResolvedValue([fakeEvent()]);

    const result = await listEvents(userId, { month: '2026-08' });

    expect(modelsMock.CalendarEvent.findAll).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { householdId, eventDate: { between: ['2026-08-01', '2026-08-31'] } },
      }),
    );
    expect(result.length).toBe(1);
  });
});

describe('getEventById', () => {
  it('returns an event within the household', async () => {
    (modelsMock.CalendarEvent.findOne as jest.Mock).mockResolvedValue(fakeEvent());

    const result = await getEventById(eventId, userId);
    expect(result.id).toBe(eventId);
  });

  it('throws NotFound when missing', async () => {
    (modelsMock.CalendarEvent.findOne as jest.Mock).mockResolvedValue(null);

    await expect(getEventById(eventId, userId)).rejects.toThrow('Event not found');
  });
});

describe('updateEvent (FR-187)', () => {
  it('lets the creator edit their own event', async () => {
    const event = fakeEvent(); // createdBy = userId (the caller)
    (modelsMock.CalendarEvent.findOne as jest.Mock).mockResolvedValue(event);
    (modelsMock.CalendarEvent.findByPk as jest.Mock).mockResolvedValue(event);

    const result = await updateEvent(eventId, userId, {
      title: 'Dinner moved',
      description: 'Now at 7pm',
    });

    expect(result.title).toBe('Dinner moved');
  });

  it('lets a household admin edit any event (FR-188)', async () => {
    const event = fakeEvent({ createdBy: adminId }); // created by someone else
    (modelsMock.CalendarEvent.findOne as jest.Mock).mockResolvedValue(event);
    (modelsMock.CalendarEvent.findByPk as jest.Mock).mockResolvedValue(event);
    (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({
      householdId,
      userId: adminId,
      role: 'admin',
    });

    const result = await updateEvent(eventId, adminId, { title: 'Admin edit' });
    expect(result.title).toBe('Admin edit');
  });

  it('blocks a non-creator non-admin from editing (FR-188)', async () => {
    const event = fakeEvent({ createdBy: adminId }); // creator is admin, not caller
    (modelsMock.CalendarEvent.findOne as jest.Mock).mockResolvedValue(event);
    (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({
      householdId,
      userId: otherUserId,
      role: 'member',
    });

    await expect(updateEvent(eventId, otherUserId, { title: 'Hijack' })).rejects.toThrow(
      ForbiddenError,
    );
  });
});

describe('deleteEvent (FR-187/188)', () => {
  it('deletes when the user is the creator', async () => {
    const event = fakeEvent(); // createdBy = creator (the caller)
    (modelsMock.CalendarEvent.findOne as jest.Mock).mockResolvedValue(event);

    await deleteEvent(eventId, userId);

    expect(modelsMock.EventInvitee.destroy).toHaveBeenCalledWith({
      where: { calendarEventId: eventId },
    });
    expect(event.destroy).toHaveBeenCalled();
  });

  it('blocks a plain member deleting someone else event', async () => {
    const event = fakeEvent({ createdBy: adminId });
    (modelsMock.CalendarEvent.findOne as jest.Mock).mockResolvedValue(event);
    (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({
      householdId,
      userId: otherUserId,
      role: 'member',
    });

    await expect(deleteEvent(eventId, otherUserId)).rejects.toThrow(ForbiddenError);
  });
});

describe('exportHouseholdIcs (FR-185)', () => {
  it('produces a valid VCALENDAR with VEVENT entries', async () => {
    (modelsMock.CalendarEvent.findAll as jest.Mock).mockResolvedValue([
      fakeEvent({ title: 'Family, dinner; 1' }),
    ]);

    const ics = await exportHouseholdIcs(userId);

    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('VERSION:2.0');
    expect(ics).toContain('BEGIN:VEVENT');
    expect(ics).toContain('UID:');
    expect(ics).toContain('DTSTART:20260803T180000');
    expect(ics).toContain('END:VCALENDAR');
    expect(ics).toContain('Family\\, dinner\\; 1');
  });

  it('includes RRULE for recurring events', async () => {
    (modelsMock.CalendarEvent.findAll as jest.Mock).mockResolvedValue([
      fakeEvent({ isRecurring: true, recurrenceRule: 'weekly' }),
    ]);

    const ics = await exportHouseholdIcs(userId);
    expect(ics).toContain('RRULE:FREQ=WEEKLY');
  });

  it('uses the rootaroo UID domain and product id (branding)', async () => {
    (modelsMock.CalendarEvent.findAll as jest.Mock).mockResolvedValue([fakeEvent({ id: 'ev-1' })]);
    const ics = await exportHouseholdIcs(userId);
    expect(ics).toContain('UID:ev-1@rootaroo');
    expect(ics).toContain('PRODID:-//Rootaroo//Family Calendar//EN');
  });
});

describe('notifyUpcomingEvents (FR-186)', () => {
  // Fixed system time (23:15 UTC) so this deterministically exercises the
  // midnight-crossing [now, now+1h] window regardless of when the suite
  // actually runs — real-wall-clock `new Date()` here previously made this
  // flaky once per day right around midnight.
  // Explicit 'Z' suffix: notifyUpcomingEvents compares real UTC instants
  // against each event's own household timezone (fakeEvent defaults to
  // 'UTC' below) — unlike other calendar functions in this file
  // (splitDateTime/joinDateTime), it must not depend on the test
  // runner's local system timezone (F-11).
  const FIXED_NOW = new Date('2026-08-10T23:15:00Z');

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('notifies the household for events starting within the hour', async () => {
    (modelsMock.CalendarEvent.findAll as jest.Mock).mockResolvedValue([
      fakeEvent({ title: 'Standup', eventDate: '2026-08-10', startTime: '23:45:00' }),
    ]);

    const sent = await notifyUpcomingEvents();

    expect(sent).toBe(1);
    expect(notifications.notifyHousehold).toHaveBeenCalledWith(
      householdId,
      'calendar',
      'Event starting soon',
      expect.stringContaining('Standup'),
      expect.objectContaining({ type: 'calendar', eventId }),
    );
  });

  it('notifies for events just after midnight, within the hour window', async () => {
    (modelsMock.CalendarEvent.findAll as jest.Mock).mockResolvedValue([
      fakeEvent({ title: 'Red-eye', eventDate: '2026-08-11', startTime: '00:05:00' }),
    ]);

    const sent = await notifyUpcomingEvents();

    expect(sent).toBe(1);
  });

  it('skips events already started or beyond the window', async () => {
    (modelsMock.CalendarEvent.findAll as jest.Mock).mockResolvedValue([
      fakeEvent({ title: 'Already started', eventDate: '2026-08-10', startTime: '23:00:00' }),
      fakeEvent({ title: 'Too far out', eventDate: '2026-08-11', startTime: '01:00:00' }),
    ]);

    const sent = await notifyUpcomingEvents();

    expect(sent).toBe(0);
    expect(notifications.notifyHousehold).not.toHaveBeenCalled();
  });

  it('interprets the event time in the household\'s own timezone, not UTC (F-11)', async () => {
    // FIXED_NOW is 23:15 UTC. A household in America/New_York (UTC-4 in
    // August) with a local wall-clock event at 19:45 is also 23:45 UTC —
    // within the next hour. Reading it as a bare UTC/server time (the old
    // behavior) would have placed it 4 hours in the past instead.
    (modelsMock.CalendarEvent.findAll as jest.Mock).mockResolvedValue([
      fakeEvent({
        title: 'Evening call',
        eventDate: '2026-08-10',
        startTime: '19:45:00',
        household: { timezone: 'America/New_York' },
      }),
    ]);

    const sent = await notifyUpcomingEvents();

    expect(sent).toBe(1);
    expect(notifications.notifyHousehold).toHaveBeenCalledWith(
      householdId,
      'calendar',
      'Event starting soon',
      expect.stringContaining('Evening call'),
      expect.objectContaining({ type: 'calendar', eventId }),
    );
  });
});
describe('Google Calendar sync', () => {
  const syncUserId = userId;
  const googleCalendarId = 'primary-cal-id';

  function fakeSyncState(overrides: any = {}) {
    return {
      id: 'sync-1',
      userId: syncUserId,
      googleCalendarId,
      syncToken: null,
      lastSyncedAt: null,
      isActive: true,
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      tokenExpiresAt: new Date(Date.now() + 3600_000),
      save: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  describe('getGoogleSyncStatus', () => {
    it('returns disconnected when no sync state exists', async () => {
      (modelsMock.CalendarSyncState.findOne as jest.Mock).mockResolvedValue(null);

      const result = await getGoogleSyncStatus(syncUserId);

      expect(result).toEqual({ connected: false, googleCalendarId: null, lastSyncedAt: null });
    });

    it('returns connected with calendar id when active', async () => {
      (modelsMock.CalendarSyncState.findOne as jest.Mock).mockResolvedValue(fakeSyncState());

      const result = await getGoogleSyncStatus(syncUserId);

      expect(result.connected).toBe(true);
      expect(result.googleCalendarId).toBe(googleCalendarId);
    });
  });

  describe('connectGoogleCalendar', () => {
    it('exchanges the code, resolves the calendar, and creates a sync state', async () => {
      (googleCalendar.exchangeCodeForTokens as jest.Mock).mockResolvedValue({
        accessToken: 'new-access', refreshToken: 'new-refresh', expiresAt: new Date(),
      });
      (googleCalendar.getPrimaryCalendarId as jest.Mock).mockResolvedValue(googleCalendarId);
      (modelsMock.CalendarSyncState.findOne as jest.Mock)
        .mockResolvedValueOnce(null) // no existing state
        .mockResolvedValue(fakeSyncState()); // used by the background syncUserCalendar call
      (modelsMock.CalendarSyncState.create as jest.Mock).mockResolvedValue(fakeSyncState());
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId, userId: syncUserId });
      (googleCalendar.getValidAccessToken as jest.Mock).mockResolvedValue('access-token');
      (googleCalendar.listGoogleEvents as jest.Mock).mockResolvedValue({ events: [], nextSyncToken: null });
      (modelsMock.CalendarEvent.findAll as jest.Mock).mockResolvedValue([]);

      const result = await connectGoogleCalendar(syncUserId, { code: 'auth-code', redirectUri: 'rootaroo://redirect' });

      expect(googleCalendar.exchangeCodeForTokens).toHaveBeenCalledWith('auth-code', 'rootaroo://redirect');
      expect(modelsMock.CalendarSyncState.create).toHaveBeenCalledWith(
        expect.objectContaining({ userId: syncUserId, googleCalendarId }),
      );
      expect(result.connected).toBe(true);
    });
  });

  describe('disconnectGoogleCalendar', () => {
    it('deletes the sync state', async () => {
      await disconnectGoogleCalendar(syncUserId);

      expect(modelsMock.CalendarSyncState.destroy).toHaveBeenCalledWith({
        where: { userId: syncUserId, provider: 'google' },
      });
    });
  });

  describe('syncUserCalendar', () => {
    it('does nothing when there is no active sync state', async () => {
      (modelsMock.CalendarSyncState.findOne as jest.Mock).mockResolvedValue(null);

      await syncUserCalendar(syncUserId);

      expect(googleCalendar.listGoogleEvents).not.toHaveBeenCalled();
    });

    it('creates a local event for a new Google event and stores the new sync token', async () => {
      const state = fakeSyncState();
      (modelsMock.CalendarSyncState.findOne as jest.Mock).mockResolvedValue(state);
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId, userId: syncUserId });
      (googleCalendar.getValidAccessToken as jest.Mock).mockResolvedValue('access-token');
      (googleCalendar.listGoogleEvents as jest.Mock).mockResolvedValue({
        events: [{
          id: 'g-event-1',
          summary: 'Dentist',
          start: { dateTime: '2026-08-10T09:00:00.000Z' },
          end: { dateTime: '2026-08-10T09:30:00.000Z' },
        }],
        nextSyncToken: 'new-sync-token',
      });
      (modelsMock.CalendarEvent.findOne as jest.Mock).mockResolvedValue(null);
      (modelsMock.CalendarEvent.create as jest.Mock).mockResolvedValue(fakeEvent());
      (modelsMock.CalendarEvent.findAll as jest.Mock).mockResolvedValue([]);

      await syncUserCalendar(syncUserId);

      expect(modelsMock.CalendarEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Dentist', googleEventId: 'g-event-1', createdBy: syncUserId }),
      );
      expect(state.syncToken).toBe('new-sync-token');
      expect(state.save).toHaveBeenCalled();
    });

    it('deletes the local event when Google reports it cancelled', async () => {
      const state = fakeSyncState();
      const localEvent = fakeEvent({ googleEventId: 'g-event-2' });
      (modelsMock.CalendarSyncState.findOne as jest.Mock).mockResolvedValue(state);
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId, userId: syncUserId });
      (googleCalendar.getValidAccessToken as jest.Mock).mockResolvedValue('access-token');
      (googleCalendar.listGoogleEvents as jest.Mock).mockResolvedValue({
        events: [{ id: 'g-event-2', status: 'cancelled' }],
        nextSyncToken: 'tok-2',
      });
      (modelsMock.CalendarEvent.findOne as jest.Mock).mockResolvedValue(localEvent);
      (modelsMock.CalendarEvent.findAll as jest.Mock).mockResolvedValue([]);

      await syncUserCalendar(syncUserId);

      expect(localEvent.destroy).toHaveBeenCalled();
    });
  });
});

describe('Outlook Calendar sync (one-way ICS feed)', () => {
  const syncUserId = userId;
  const feedToken = 'a'.repeat(48);

  function fakeOutlookSyncState(overrides: any = {}) {
    return {
      id: 'sync-outlook-1',
      userId: syncUserId,
      provider: 'outlook',
      outlookFeedToken: feedToken,
      isActive: true,
      save: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  describe('getOutlookSyncStatus', () => {
    it('returns disconnected when no sync state exists', async () => {
      (modelsMock.CalendarSyncState.findOne as jest.Mock).mockResolvedValue(null);

      const result = await getOutlookSyncStatus(syncUserId);

      expect(result).toEqual({ connected: false, feedUrl: null });
    });

    it('returns connected with the feed URL when active', async () => {
      (modelsMock.CalendarSyncState.findOne as jest.Mock).mockResolvedValue(fakeOutlookSyncState());

      const result = await getOutlookSyncStatus(syncUserId);

      expect(result.connected).toBe(true);
      expect(result.feedUrl).toContain(feedToken);
    });
  });

  describe('connectOutlookCalendar', () => {
    it('generates a feed token and creates a sync state when none exists', async () => {
      (outlookCalendar.generateOutlookFeedToken as jest.Mock).mockReturnValue(feedToken);
      (modelsMock.CalendarSyncState.findOne as jest.Mock).mockResolvedValue(null);
      (modelsMock.CalendarSyncState.create as jest.Mock).mockResolvedValue(fakeOutlookSyncState());

      const result = await connectOutlookCalendar(syncUserId);

      expect(modelsMock.CalendarSyncState.create).toHaveBeenCalledWith(
        expect.objectContaining({ userId: syncUserId, provider: 'outlook', outlookFeedToken: feedToken }),
      );
      expect(result.connected).toBe(true);
      expect(result.feedUrl).toContain(feedToken);
    });

    it('reuses the existing feed token on reconnect', async () => {
      const state = fakeOutlookSyncState({ isActive: false });
      (modelsMock.CalendarSyncState.findOne as jest.Mock).mockResolvedValue(state);

      const result = await connectOutlookCalendar(syncUserId);

      expect(outlookCalendar.generateOutlookFeedToken).not.toHaveBeenCalled();
      expect(state.isActive).toBe(true);
      expect(state.save).toHaveBeenCalled();
      expect(result.connected).toBe(true);
    });
  });

  describe('disconnectOutlookCalendar', () => {
    it('deletes the sync state', async () => {
      await disconnectOutlookCalendar(syncUserId);

      expect(modelsMock.CalendarSyncState.destroy).toHaveBeenCalledWith({
        where: { userId: syncUserId, provider: 'outlook' },
      });
    });
  });

  describe('Outlook ICS feed paywall (B10)', () => {
    it('returns a valid empty calendar for a blocked household', async () => {
      (modelsMock.CalendarSyncState.findOne as jest.Mock).mockResolvedValue({ userId: 'user-1' });
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId: 'hh-1' });
      (isEntitledBatch as jest.Mock).mockResolvedValueOnce(new Set());
      const ics = await getOutlookFeedIcs('tok');
      expect(ics).toBe(emptyCalendarIcs());
      expect(ics).toContain('BEGIN:VCALENDAR');
      expect(ics).not.toContain('BEGIN:VEVENT');
    });
  });

  describe('getOutlookFeedIcs', () => {
    it('throws when no active state matches the token', async () => {
      (modelsMock.CalendarSyncState.findOne as jest.Mock).mockResolvedValue(null);

      await expect(getOutlookFeedIcs(feedToken)).rejects.toThrow('Calendar feed not found');
    });

    it('renders the household ICS for the token owner', async () => {
      (modelsMock.CalendarSyncState.findOne as jest.Mock).mockResolvedValue(fakeOutlookSyncState({ userId: syncUserId }));
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId, userId: syncUserId });
      (modelsMock.CalendarEvent.findAll as jest.Mock).mockResolvedValue([fakeEvent()]);

      const ics = await getOutlookFeedIcs(feedToken);

      expect(ics).toContain('BEGIN:VCALENDAR');
      expect(ics).toContain('Family dinner');
    });
  });
});

describe('Apple Calendar sync', () => {
  const syncUserId = userId;
  const appleId = 'user@icloud.com';
  const calendarUrl = 'https://p01-caldav.icloud.com/1234/calendars/home/';

  function fakeAppleSyncState(overrides: any = {}) {
    return {
      id: 'sync-apple-1',
      userId: syncUserId,
      provider: 'apple',
      appleId,
      applePassword: 'app-specific-password',
      caldavCalendarHomeUrl: calendarUrl,
      lastSyncedAt: null,
      isActive: true,
      save: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  describe('getAppleSyncStatus', () => {
    it('returns disconnected when no sync state exists', async () => {
      (modelsMock.CalendarSyncState.findOne as jest.Mock).mockResolvedValue(null);

      const result = await getAppleSyncStatus(syncUserId);

      expect(result).toEqual({ connected: false, appleId: null, lastSyncedAt: null });
    });

    it('returns connected with the Apple ID when active', async () => {
      (modelsMock.CalendarSyncState.findOne as jest.Mock).mockResolvedValue(fakeAppleSyncState());

      const result = await getAppleSyncStatus(syncUserId);

      expect(result.connected).toBe(true);
      expect(result.appleId).toBe(appleId);
    });
  });

  describe('connectAppleCalendar', () => {
    it('validates credentials, resolves the calendar, and creates a sync state', async () => {
      (appleCalendar.discoverPrimaryCalendar as jest.Mock).mockResolvedValue({ calendarUrl });
      (modelsMock.CalendarSyncState.findOne as jest.Mock)
        .mockResolvedValueOnce(null) // no existing state
        .mockResolvedValue(fakeAppleSyncState()); // used by the background sync call
      (modelsMock.CalendarSyncState.create as jest.Mock).mockResolvedValue(fakeAppleSyncState());
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId, userId: syncUserId });
      (appleCalendar.listAppleEvents as jest.Mock).mockResolvedValue({ objects: [] });
      (modelsMock.CalendarEvent.findAll as jest.Mock).mockResolvedValue([]);

      const result = await connectAppleCalendar(syncUserId, {
        appleId,
        appSpecificPassword: 'app-specific-password',
      });

      expect(appleCalendar.discoverPrimaryCalendar).toHaveBeenCalledWith(appleId, 'app-specific-password');
      expect(modelsMock.CalendarSyncState.create).toHaveBeenCalledWith(
        expect.objectContaining({ userId: syncUserId, provider: 'apple', appleId, caldavCalendarHomeUrl: calendarUrl }),
      );
      expect(result.connected).toBe(true);
    });

    it('propagates a credential/discovery failure without creating a sync state', async () => {
      (appleCalendar.discoverPrimaryCalendar as jest.Mock).mockRejectedValue(new Error('bad password'));

      await expect(
        connectAppleCalendar(syncUserId, { appleId, appSpecificPassword: 'wrong' }),
      ).rejects.toThrow('bad password');
      expect(modelsMock.CalendarSyncState.create).not.toHaveBeenCalled();
    });
  });

  describe('disconnectAppleCalendar', () => {
    it('deletes the sync state', async () => {
      await disconnectAppleCalendar(syncUserId);

      expect(modelsMock.CalendarSyncState.destroy).toHaveBeenCalledWith({
        where: { userId: syncUserId, provider: 'apple' },
      });
    });
  });

  describe('syncAppleUserCalendar', () => {
    it('does nothing when there is no active sync state', async () => {
      (modelsMock.CalendarSyncState.findOne as jest.Mock).mockResolvedValue(null);

      await syncAppleUserCalendar(syncUserId);

      expect(appleCalendar.listAppleEvents).not.toHaveBeenCalled();
    });

    it('creates a local event for a new Apple event', async () => {
      const state = fakeAppleSyncState();
      (modelsMock.CalendarSyncState.findOne as jest.Mock).mockResolvedValue(state);
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId, userId: syncUserId });
      (appleCalendar.listAppleEvents as jest.Mock).mockResolvedValue({
        objects: [{
          href: `${calendarUrl}event-1.ics`,
          etag: '"abc123"',
          uid: 'event-1',
          title: 'Dentist',
          description: null,
          startIso: '2026-08-10T09:00:00.000Z',
          endIso: '2026-08-10T09:30:00.000Z',
          recurrenceFreq: null,
        }],
      });
      (modelsMock.CalendarEvent.findOne as jest.Mock).mockResolvedValue(null);
      (modelsMock.CalendarEvent.create as jest.Mock).mockResolvedValue(fakeEvent());
      (modelsMock.CalendarEvent.findAll as jest.Mock).mockResolvedValue([]);

      await syncAppleUserCalendar(syncUserId);

      expect(modelsMock.CalendarEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Dentist',
          externalProvider: 'apple',
          externalEventId: `${calendarUrl}event-1.ics`,
          createdBy: syncUserId,
        }),
      );
      expect(state.lastSyncedAt).toBeInstanceOf(Date);
      expect(state.save).toHaveBeenCalled();
    });

    it('updates an existing local event when the Apple object already has one', async () => {
      const state = fakeAppleSyncState();
      const localEvent = fakeEvent({ externalProvider: 'apple', externalEventId: `${calendarUrl}event-2.ics` });
      (modelsMock.CalendarSyncState.findOne as jest.Mock).mockResolvedValue(state);
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId, userId: syncUserId });
      (appleCalendar.listAppleEvents as jest.Mock).mockResolvedValue({
        objects: [{
          href: `${calendarUrl}event-2.ics`,
          etag: '"def456"',
          uid: 'event-2',
          title: 'Updated title',
          description: null,
          startIso: '2026-08-11T09:00:00.000Z',
          endIso: '2026-08-11T09:30:00.000Z',
          recurrenceFreq: null,
        }],
      });
      (modelsMock.CalendarEvent.findOne as jest.Mock).mockResolvedValue(localEvent);
      (modelsMock.CalendarEvent.findAll as jest.Mock).mockResolvedValue([]);

      await syncAppleUserCalendar(syncUserId);

      expect(localEvent.title).toBe('Updated title');
      expect(localEvent.save).toHaveBeenCalled();
    });
  });
});
