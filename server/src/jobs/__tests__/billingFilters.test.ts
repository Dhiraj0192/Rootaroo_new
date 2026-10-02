jest.mock('node-cron', () => ({ schedule: jest.fn() }));
jest.mock('../../modules/billing/entitlement', () => ({ isEntitledBatch: jest.fn() }));
jest.mock('../../modules/calendar/service', () => ({ syncUserCalendar: jest.fn(), syncAppleUserCalendar: jest.fn(), notifyUpcomingEvents: jest.fn() }));
jest.mock('../../database/models', () => ({
  sequelize: { fn: jest.fn((...a: unknown[]) => a), col: jest.fn((c: string) => c) },
  GroceryItem: { findAll: jest.fn(), update: jest.fn() },
  Task: { findAll: jest.fn() },
  CalendarSyncState: { findAll: jest.fn() },
  HouseholdMember: { findAll: jest.fn() },
}));

import * as models from '../../database/models';
import { isEntitledBatch } from '../../modules/billing/entitlement';
import { syncUserCalendar } from '../../modules/calendar/service';
import { runGroceryArchive } from '../grocery-archive';
import { runOverduePointsReduction } from '../overdue-points';
import { runCalendarSync } from '../calendar-sync';

beforeEach(() => jest.clearAllMocks());

describe('job filtering by entitlement', () => {
  it('grocery-archive only archives entitled households', async () => {
    (models.GroceryItem.findAll as jest.Mock).mockResolvedValue([{ householdId: 'ok' }, { householdId: 'blocked' }]);
    (isEntitledBatch as jest.Mock).mockResolvedValue(new Set(['ok']));
    (models.GroceryItem.update as jest.Mock).mockResolvedValue([3]);
    expect(await runGroceryArchive(new Date('2026-10-10'))).toBe(3);
    expect((models.GroceryItem.update as jest.Mock).mock.calls[0][1].where.householdId).toEqual(['ok']);
  });

  it('grocery-archive does nothing when no household is entitled', async () => {
    (models.GroceryItem.findAll as jest.Mock).mockResolvedValue([{ householdId: 'blocked' }]);
    (isEntitledBatch as jest.Mock).mockResolvedValue(new Set());
    expect(await runGroceryArchive()).toBe(0);
    expect(models.GroceryItem.update).not.toHaveBeenCalled();
  });

  it('overdue-points skips blocked households', async () => {
    const ok = { householdId: 'ok', points: 10, update: jest.fn() };
    const blocked = { householdId: 'blocked', points: 10, update: jest.fn() };
    (models.Task.findAll as jest.Mock).mockResolvedValue([ok, blocked]);
    (isEntitledBatch as jest.Mock).mockResolvedValue(new Set(['ok']));
    expect(await runOverduePointsReduction()).toBe(1);
    expect(ok.update).toHaveBeenCalledWith({ points: 5, pointsReduced: true });
    expect(blocked.update).not.toHaveBeenCalled();
  });

  it('calendar-sync skips users whose household is blocked', async () => {
    (models.CalendarSyncState.findAll as jest.Mock).mockResolvedValue([{ userId: 'u1', provider: 'google' }, { userId: 'u2', provider: 'google' }]);
    (models.HouseholdMember.findAll as jest.Mock).mockResolvedValue([{ userId: 'u1', householdId: 'ok' }, { userId: 'u2', householdId: 'blocked' }]);
    (isEntitledBatch as jest.Mock).mockResolvedValue(new Set(['ok']));
    expect(await runCalendarSync()).toBe(1);
    expect(syncUserCalendar).toHaveBeenCalledWith('u1');
    expect(syncUserCalendar).not.toHaveBeenCalledWith('u2');
  });
});
