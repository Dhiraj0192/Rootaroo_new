import cron from 'node-cron';
import { CalendarSyncState, HouseholdMember } from '../database/models';
import { syncUserCalendar, syncAppleUserCalendar } from '../modules/calendar/service';
import { isEntitledBatch } from '../modules/billing/entitlement';
import logger from '../shared/utils/logger';

export async function runCalendarSync(): Promise<number> {
  const states = await CalendarSyncState.findAll({ where: { isActive: true, provider: ['google', 'apple'] }, attributes: ['userId', 'provider'] });
  if (states.length === 0) return 0;
  const memberships = await HouseholdMember.findAll({ where: { userId: [...new Set(states.map((s) => s.userId))] }, attributes: ['userId', 'householdId'] });
  const householdOf = new Map(memberships.map((m) => [m.userId, m.householdId]));
  const allowed = await isEntitledBatch([...householdOf.values()]);
  let synced = 0;
  for (const state of states) {
    const householdId = householdOf.get(state.userId);
    if (!householdId || !allowed.has(householdId)) continue;
    try {
      if (state.provider === 'google') await syncUserCalendar(state.userId);
      else if (state.provider === 'apple') await syncAppleUserCalendar(state.userId);
      synced++;
    } catch (err) {
      logger.error(`[Calendar Sync] Failed for user ${state.userId} (${state.provider}):`, err);
    }
  }
  return synced;
}

export function startCalendarSyncJob(): void {
  cron.schedule('*/15 * * * *', async () => {
    try {
      const synced = await runCalendarSync();
      if (synced > 0) logger.info(`[Calendar Sync] Synced ${synced} connected Calendar(s)`);
    } catch (err) {
      logger.error('[Calendar Sync] Failed:', err);
    }
  });
  logger.info('[Calendar Sync] Cron job registered — runs every 15 minutes');
}
