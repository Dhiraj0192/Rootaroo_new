import { useEffect } from 'react';
import * as Notifications from 'expo-notifications';

// type -> [tab, screen, required id param (or null)]
const ROUTES = {
  chat: ['ChatStack', 'ChatScreen', 'conversationId'],
  feed: ['MoreStack', 'PostDetail', 'postId'],
  task: ['TasksStack', 'TaskDetail', 'taskId'],
  task_completed: ['TasksStack', 'TaskDetail', 'taskId'],
  todo: ['MoreStack', 'TodoList', null],
  expense_reminder: ['MoreStack', 'ExpenseDetail', 'expenseId'],
  check_in: ['MoreStack', 'CheckIn', null],
  ping_request: ['MoreStack', 'CheckIn', null],
  ping_response: ['MoreStack', 'CheckIn', null],
  calendar: ['MoreStack', 'Calendar', null],
  member_joined: ['MoreStack', 'HouseholdSettings', null],
  leave_request: ['MoreStack', 'HouseholdSettings', null],
  leave_response: ['MoreStack', 'HouseholdSettings', null],
  household_deletion_scheduled: ['MoreStack', 'HouseholdSettings', null],
  household_deletion_cancelled: ['MoreStack', 'HouseholdSettings', null],
};

const FALLBACK = { name: 'Notifications' };

const handledIds = new Set();
let pendingRoute = null;

function resolveRoute(type) {
  if (typeof type !== 'string') return null;
  if (type.startsWith('billing_')) return ['MoreStack', 'Subscription', null];
  return ROUTES[type] || null;
}

export function routeForNotification(data) {
  if (!data) return FALLBACK;
  const match = resolveRoute(data.type);
  if (!match) return FALLBACK;
  const [tab, screen, idKey] = match;

  let params;
  if (idKey) {
    const value = data[idKey];
    if (!value) return FALLBACK;
    params = { [idKey]: value };
  }

  return { name: 'MainTabs', params: { screen: tab, params: { screen, params } } };
}

export function handleNotificationResponse(navRef, response) {
  const request = response?.notification?.request;
  const id = request?.identifier;
  // Opening the app is the whole point of a signed-out nudge.
  if (request?.content?.data?.type === 'signed_out_nudge') return;
  if (id) {
    if (handledIds.has(id)) return;
    handledIds.add(id);
  }

  const route = routeForNotification(request?.content?.data);
  if (navRef?.isReady?.()) {
    navRef.navigate(route.name, route.params);
  } else {
    pendingRoute = route;
  }
}

export function flushPendingNotification(navRef) {
  if (!pendingRoute || !navRef?.isReady?.()) return;
  const route = pendingRoute;
  pendingRoute = null;
  navRef.navigate(route.name, route.params);
}

// Default api is required lazily so tests can import this module without the API client's native deps.
export async function syncBadge(api = require('./api/notification').notificationApi) {
  try {
    const result = await api.getUnreadCount();
    const count = typeof result === 'number' ? result : Number(result?.count) || 0;
    await Notifications.setBadgeCountAsync(count);
  } catch {
    // Badge is cosmetic — never fail the caller over it.
  }
}

export function __resetNotificationRoutingForTests() {
  handledIds.clear();
  pendingRoute = null;
}

export function useNotificationRouting(navRef) {
  useEffect(() => {
    Notifications.getLastNotificationResponseAsync()
      .then((response) => {
        if (response) handleNotificationResponse(navRef, response);
      })
      .catch(() => {});

    const sub = Notifications.addNotificationResponseReceivedListener((response) =>
      handleNotificationResponse(navRef, response),
    );
    return () => sub.remove();
  }, [navRef]);
}
