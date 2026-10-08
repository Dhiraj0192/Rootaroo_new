jest.mock('expo-notifications', () => ({
  addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  getLastNotificationResponseAsync: jest.fn(async () => null),
  setBadgeCountAsync: jest.fn(async () => true),
  setNotificationHandler: jest.fn(),
}));

const Notifications = require('expo-notifications');
const {
  routeForNotification,
  handleNotificationResponse,
  flushPendingNotification,
  __resetNotificationRoutingForTests,
} = require('../notificationRouting');

const tab = (tabName, screen, params) => ({ name: 'MainTabs', params: { screen: tabName, params: { screen, params } } });
const ref = (ready = true) => ({ isReady: jest.fn(() => ready), navigate: jest.fn() });
const response = (data, id = 'n1') => ({ notification: { request: { identifier: id, content: { data } } } });

beforeEach(() => {
  jest.clearAllMocks();
  __resetNotificationRoutingForTests();
});

describe('routeForNotification', () => {
  it.each([
    [{ type: 'chat', conversationId: 'c1' }, tab('ChatStack', 'ChatScreen', { conversationId: 'c1' })],
    [{ type: 'feed', postId: 'p1' }, tab('MoreStack', 'PostDetail', { postId: 'p1' })],
    [{ type: 'task', taskId: 't1' }, tab('TasksStack', 'TaskDetail', { taskId: 't1' })],
    [{ type: 'task_completed', taskId: 't1' }, tab('TasksStack', 'TaskDetail', { taskId: 't1' })],
    [{ type: 'todo', todoId: 'd1' }, tab('MoreStack', 'TodoList', undefined)],
    [{ type: 'expense_reminder', expenseId: 'e1' }, tab('MoreStack', 'ExpenseDetail', { expenseId: 'e1' })],
    [{ type: 'check_in' }, tab('MoreStack', 'CheckIn', undefined)],
    [{ type: 'ping_request', pingRequestId: 'g1' }, tab('MoreStack', 'CheckIn', undefined)],
    [{ type: 'ping_response', pingRequestId: 'g1' }, tab('MoreStack', 'CheckIn', undefined)],
    [{ type: 'calendar', eventId: 'v1' }, tab('MoreStack', 'Calendar', undefined)],
    [{ type: 'member_joined' }, tab('MoreStack', 'HouseholdSettings', undefined)],
    [{ type: 'leave_request' }, tab('MoreStack', 'HouseholdSettings', undefined)],
    [{ type: 'household_deletion_scheduled' }, tab('MoreStack', 'HouseholdSettings', undefined)],
    [{ type: 'billing_payment_failed' }, tab('MoreStack', 'Subscription', undefined)],
  ])('%j opens the right screen', (data, expected) => {
    expect(routeForNotification(data)).toEqual(expected);
  });

  it('falls back to the notification list for unknown types or missing ids', () => {
    expect(routeForNotification({ type: 'something_new' })).toEqual({ name: 'Notifications' });
    expect(routeForNotification({ type: 'chat' })).toEqual({ name: 'Notifications' });
    expect(routeForNotification(undefined)).toEqual({ name: 'Notifications' });
  });
});

describe('handleNotificationResponse', () => {
  it('navigates straight away when navigation is ready', () => {
    const nav = ref(true);
    handleNotificationResponse(nav, response({ type: 'task', taskId: 't1' }));
    expect(nav.navigate).toHaveBeenCalledWith('MainTabs', tab('TasksStack', 'TaskDetail', { taskId: 't1' }).params);
  });

  it('waits for navigation to be ready (cold start), then navigates once', () => {
    const nav = ref(false);
    handleNotificationResponse(nav, response({ type: 'chat', conversationId: 'c1' }));
    expect(nav.navigate).not.toHaveBeenCalled();
    nav.isReady.mockReturnValue(true);
    flushPendingNotification(nav);
    flushPendingNotification(nav);
    expect(nav.navigate).toHaveBeenCalledTimes(1);
    expect(nav.navigate).toHaveBeenCalledWith('MainTabs', tab('ChatStack', 'ChatScreen', { conversationId: 'c1' }).params);
  });

  it('handles the same notification only once (listener and cold-start lookup can both report it)', () => {
    const nav = ref(true);
    handleNotificationResponse(nav, response({ type: 'calendar' }, 'same'));
    handleNotificationResponse(nav, response({ type: 'calendar' }, 'same'));
    expect(nav.navigate).toHaveBeenCalledTimes(1);
  });
});

describe('last-notification persistence', () => {
  const AsyncStorage = require('@react-native-async-storage/async-storage');
  const { handleColdStartResponse, LAST_NOTIFICATION_KEY } = require('../notificationRouting');

  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('stores the identifier of a handled tap', async () => {
    const stored = handleNotificationResponse(ref(true), response({ type: 'calendar' }, 'tap1'));
    await stored;
    expect(await AsyncStorage.getItem(LAST_NOTIFICATION_KEY)).toBe('tap1');
  });

  it('does not navigate for the tap already handled in a previous launch', async () => {
    await AsyncStorage.setItem(LAST_NOTIFICATION_KEY, 'old');
    const nav = ref(true);
    await handleColdStartResponse(nav, response({ type: 'calendar' }, 'old'));
    expect(nav.navigate).not.toHaveBeenCalled();
  });

  it('navigates and stores the id for a new tap', async () => {
    await AsyncStorage.setItem(LAST_NOTIFICATION_KEY, 'old');
    const nav = ref(true);
    await handleColdStartResponse(nav, response({ type: 'calendar' }, 'fresh'));
    expect(nav.navigate).toHaveBeenCalledTimes(1);
    expect(await AsyncStorage.getItem(LAST_NOTIFICATION_KEY)).toBe('fresh');
  });

  it('does nothing for a null response', async () => {
    const nav = ref(true);
    await handleColdStartResponse(nav, null);
    expect(nav.navigate).not.toHaveBeenCalled();
    expect(await AsyncStorage.getItem(LAST_NOTIFICATION_KEY)).toBeNull();
  });
});

describe('syncBadge', () => {
  it('sets the app badge to the server unread count', async () => {
    const { syncBadge } = require('../notificationRouting');
    const api = { getUnreadCount: jest.fn(async () => ({ count: 4 })) };
    await syncBadge(api);
    expect(Notifications.setBadgeCountAsync).toHaveBeenCalledWith(4);
  });

  it('never throws', async () => {
    const { syncBadge } = require('../notificationRouting');
    const api = { getUnreadCount: jest.fn(async () => { throw new Error('offline'); }) };
    await expect(syncBadge(api)).resolves.toBeUndefined();
  });
});
