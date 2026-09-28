import { dashboardApi } from '../api/dashboard';
import { householdApi } from '../api/household';
import { eventApi } from '../api/event';
import { useFeedStore } from '../store/feedStore';
import { sharedRequest } from './screenCache';

// Home's requests, keyed exactly as DashboardScreen asks for them — the
// screen picks up these in-flight promises instead of starting over.
export const homeRequests = {
  dashboard: () => sharedRequest('dashboard', dashboardApi.get, 20000),
  events: () => sharedRequest('events', () => eventApi.list(), 20000),
  members: (householdId) =>
    sharedRequest(`members:${householdId}`, () => householdApi.getMembers(householdId)),
  household: (householdId) =>
    sharedRequest(`household:${householdId}`, () => householdApi.getHousehold(householdId)),
};

/**
 * Started from restoreSession, while the (minimum 3s) splash is still up,
 * so Home's data is already on its way — or back — when Home mounts.
 */
export function prefetchHome(householdId) {
  homeRequests.dashboard().catch(() => {});
  homeRequests.events().catch(() => {});
  if (householdId) {
    homeRequests.members(householdId).catch(() => {});
    homeRequests.household(householdId).catch(() => {});
  }
  useFeedStore.getState().fetchFeed();
}
