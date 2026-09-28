import { getDashboard, quickNotify } from '../service';
import * as models from '../../../database/models';
import * as taskService from '../../task/service';
import * as groceryService from '../../grocery/service';
import * as todoService from '../../todo/service';
import * as notificationService from '../../notification/service';
import { ForbiddenError } from '../../../shared/utils/errors';
import { Op } from 'sequelize';
import redis from '../../../config/redis';

const userId = '550e8400-e29b-41d4-a716-446655440001';
const householdId = '770e8400-e29b-41d4-a716-446655440003';
const otherUserId = '660e8400-e29b-41d4-a716-446655440002';

jest.mock('../../../database/models', () => ({
  HouseholdMember: {
    findOne: jest.fn(),
    count: jest.fn(),
    findAll: jest.fn(),
  },
  User: {
    findByPk: jest.fn(),
  },
  Task: { findAll: jest.fn() },
  TodoItem: { findAll: jest.fn() },
  GroceryItem: { findAll: jest.fn() },
  ChatMessage: { findAll: jest.fn() },
  PingRequest: { findAll: jest.fn() },
  CheckIn: { findAll: jest.fn() },
  FeedPost: { findAll: jest.fn() },
  CalendarEvent: { findAll: jest.fn() },
  Household: { findByPk: jest.fn(), update: jest.fn() },
}));

jest.mock('../../task/service', () => ({
  getTaskSummaryForHousehold: jest.fn(),
}));

jest.mock('../../grocery/service', () => ({
  getSummaryForHousehold: jest.fn(),
}));

jest.mock('../../todo/service', () => ({
  getSummaryForHousehold: jest.fn(),
}));

jest.mock('../../notification/service', () => ({
  getUnreadCount: jest.fn(),
  sendToUser: jest.fn(),
}));

jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    get: jest.fn().mockResolvedValue(null),
    setex: jest.fn().mockResolvedValue('OK'),
  },
}));

jest.mock('../../../shared/utils/logger');

const modelsMock = models as any;

beforeEach(() => {
  jest.clearAllMocks();
  // Engagement-days sources default to empty — only the chore-completion
  // tests below populate Task/TodoItem/GroceryItem explicitly.
  (modelsMock.ChatMessage.findAll as jest.Mock).mockResolvedValue([]);
  (modelsMock.PingRequest.findAll as jest.Mock).mockResolvedValue([]);
  (modelsMock.CheckIn.findAll as jest.Mock).mockResolvedValue([]);
  (modelsMock.FeedPost.findAll as jest.Mock).mockResolvedValue([]);
  (modelsMock.CalendarEvent.findAll as jest.Mock).mockResolvedValue([]);
  // Fixed UTC household so existing tests' `new Date()`-based fixtures keep
  // landing on the calendar day they expect regardless of the CI host's tz.
  (modelsMock.Household.findByPk as jest.Mock).mockResolvedValue({ timezone: 'UTC' });
  (modelsMock.Household.update as jest.Mock).mockResolvedValue([1]);
});

describe('Dashboard Service', () => {
  describe('getDashboard', () => {
    it('returns aggregated dashboard data with real activity/leaderboard/streak', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId });
      (modelsMock.HouseholdMember.findAll as jest.Mock).mockResolvedValue([
        { userId, user: { displayName: 'Alice', avatarUrl: null, avatarEmoji: null } },
        { userId: otherUserId, user: { displayName: 'Bob', avatarUrl: null, avatarEmoji: null } },
      ]);
      (taskService.getTaskSummaryForHousehold as jest.Mock).mockResolvedValue({ pending: 3, overdue: 1, completedToday: 2 });
      (groceryService.getSummaryForHousehold as jest.Mock).mockResolvedValue({ pending: 5, boughtToday: 0 });
      (todoService.getSummaryForHousehold as jest.Mock).mockResolvedValue({ pending: 2, completedToday: 1 });
      (notificationService.getUnreadCount as jest.Mock).mockResolvedValue(4);

      const now = new Date();
      (modelsMock.Task.findAll as jest.Mock).mockResolvedValue([
        { completedAt: now, completedBy: userId, points: 2 },
      ]);
      (modelsMock.TodoItem.findAll as jest.Mock).mockResolvedValue([
        { completedAt: now, assignedTo: otherUserId },
      ]);
      (modelsMock.GroceryItem.findAll as jest.Mock).mockResolvedValue([
        { boughtAt: now, boughtBy: userId },
      ]);

      const result = await getDashboard(userId);

      expect(result.tasks).toEqual({ pending: 3, overdue: 1, completedToday: 2 });
      expect(result.groceries).toEqual({ pending: 5 });
      expect(result.todos).toEqual({ pending: 2, completedToday: 1 });
      expect(result.notifications).toEqual({ unreadCount: 4 });
      expect(result.activity).toHaveLength(7);
      // Today is the last activity entry.
      expect(result.activity[6]).toMatchObject({
        tasksCompleted: 1,
        todosCompleted: 1,
        groceriesBought: 1,
      });
      // One completion day → streak >= 1.
      expect(result.streak.current).toBeGreaterThanOrEqual(1);
      expect(result.streak.best).toBeGreaterThanOrEqual(1);
      // Alice: 2 (task's own custom points) + 4 (grocery) = 6; Bob: 3 (todo).
      expect(result.leaderboard[0]).toMatchObject({ userId, points: 6 });
      expect(result.leaderboard[1]).toMatchObject({ userId: otherUserId, points: 3 });

      // Recent activity is real per-member events with names.
      expect(result.recentActivity).toHaveLength(3);
      expect(result.recentActivity.map((r) => r.kind).sort()).toEqual(['grocery', 'task', 'todo']);
      expect(result.recentActivity.map((r) => r.displayName).sort()).toEqual(['Alice', 'Alice', 'Bob']);
    });

    it('computes a streak across consecutive completion days', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId });
      (modelsMock.HouseholdMember.findAll as jest.Mock).mockResolvedValue([
        { userId, user: { displayName: 'Alice', avatarUrl: null, avatarEmoji: null } },
      ]);
      (taskService.getTaskSummaryForHousehold as jest.Mock).mockResolvedValue({ pending: 0, overdue: 0, completedToday: 2 });
      (groceryService.getSummaryForHousehold as jest.Mock).mockResolvedValue({ pending: 0, boughtToday: 0 });
      (todoService.getSummaryForHousehold as jest.Mock).mockResolvedValue({ pending: 0, completedToday: 0 });
      (notificationService.getUnreadCount as jest.Mock).mockResolvedValue(0);

      const today = new Date();
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      const threeDaysAgo = new Date(today);
      threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

      (modelsMock.Task.findAll as jest.Mock).mockResolvedValue([
        { completedAt: today, completedBy: userId, points: 1 },
        { completedAt: yesterday, completedBy: userId, points: 1 },
        { completedAt: threeDaysAgo, completedBy: userId, points: 1 },
      ]);
      (modelsMock.TodoItem.findAll as jest.Mock).mockResolvedValue([]);
      (modelsMock.GroceryItem.findAll as jest.Mock).mockResolvedValue([]);

      const result = await getDashboard(userId);

      // Gap 2 days ago breaks today+yesterday into a run of 2.
      expect(result.streak.current).toBe(2);
      expect(result.streak.best).toBe(2);
    });

    it('throws ForbiddenError when user has no household', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue(null);

      await expect(getDashboard(userId)).rejects.toThrow(ForbiddenError);
    });

    it('keeps the streak alive on a day with no chores but a check-in', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId });
      (modelsMock.HouseholdMember.findAll as jest.Mock).mockResolvedValue([
        { userId, user: { displayName: 'Alice', avatarUrl: null, avatarEmoji: null } },
      ]);
      (taskService.getTaskSummaryForHousehold as jest.Mock).mockResolvedValue({ pending: 0, overdue: 0, completedToday: 0 });
      (groceryService.getSummaryForHousehold as jest.Mock).mockResolvedValue({ pending: 0, boughtToday: 0 });
      (todoService.getSummaryForHousehold as jest.Mock).mockResolvedValue({ pending: 0, completedToday: 0 });
      (notificationService.getUnreadCount as jest.Mock).mockResolvedValue(0);

      // No task/todo/grocery completions at all today...
      (modelsMock.Task.findAll as jest.Mock).mockResolvedValue([]);
      (modelsMock.TodoItem.findAll as jest.Mock).mockResolvedValue([]);
      (modelsMock.GroceryItem.findAll as jest.Mock).mockResolvedValue([]);
      // ...but someone checked in today.
      (modelsMock.CheckIn.findAll as jest.Mock).mockResolvedValue([
        { checkedInAt: new Date() },
      ]);

      const result = await getDashboard(userId);

      expect(result.streak.current).toBeGreaterThanOrEqual(1);
      // The chores chart itself is unaffected — a check-in isn't a "chore".
      expect(result.activity[6]).toMatchObject({
        tasksCompleted: 0,
        todosCompleted: 0,
        groceriesBought: 0,
      });
      // ...but the day still reads as "engaged" — this is what the
      // dashboard's streak pills/copy should key off of, not the chore count.
      expect(result.activity[6].engaged).toBe(true);
    });

    it('does NOT keep the streak alive on a day with only chat messages', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId });
      (modelsMock.HouseholdMember.findAll as jest.Mock).mockResolvedValue([
        { userId, user: { displayName: 'Alice', avatarUrl: null, avatarEmoji: null } },
      ]);
      (taskService.getTaskSummaryForHousehold as jest.Mock).mockResolvedValue({ pending: 0, overdue: 0, completedToday: 0 });
      (groceryService.getSummaryForHousehold as jest.Mock).mockResolvedValue({ pending: 0, boughtToday: 0 });
      (todoService.getSummaryForHousehold as jest.Mock).mockResolvedValue({ pending: 0, completedToday: 0 });
      (notificationService.getUnreadCount as jest.Mock).mockResolvedValue(0);

      (modelsMock.Task.findAll as jest.Mock).mockResolvedValue([]);
      (modelsMock.TodoItem.findAll as jest.Mock).mockResolvedValue([]);
      (modelsMock.GroceryItem.findAll as jest.Mock).mockResolvedValue([]);

      const result = await getDashboard(userId);

      // Chat is deliberately not queried at all for streak purposes.
      expect(modelsMock.ChatMessage.findAll).not.toHaveBeenCalled();
      expect(result.activity[6].engaged).toBe(false);
      expect(result.streak.current).toBe(0);
    });

    it('credits feed posts, pings, check-ins, and calendar events as real contributions (points + recent activity), without touching the chores chart', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId });
      (modelsMock.HouseholdMember.findAll as jest.Mock).mockResolvedValue([
        { userId, user: { displayName: 'Alice', avatarUrl: null, avatarEmoji: null } },
        { userId: otherUserId, user: { displayName: 'Bhim', avatarUrl: null, avatarEmoji: null } },
      ]);
      (taskService.getTaskSummaryForHousehold as jest.Mock).mockResolvedValue({ pending: 0, overdue: 0, completedToday: 0 });
      (groceryService.getSummaryForHousehold as jest.Mock).mockResolvedValue({ pending: 0, boughtToday: 0 });
      (todoService.getSummaryForHousehold as jest.Mock).mockResolvedValue({ pending: 0, completedToday: 0 });
      (notificationService.getUnreadCount as jest.Mock).mockResolvedValue(0);

      (modelsMock.Task.findAll as jest.Mock).mockResolvedValue([]);
      (modelsMock.TodoItem.findAll as jest.Mock).mockResolvedValue([]);
      (modelsMock.GroceryItem.findAll as jest.Mock).mockResolvedValue([]);
      (modelsMock.FeedPost.findAll as jest.Mock).mockResolvedValue([
        { createdAt: new Date(), userId },
      ]);
      (modelsMock.PingRequest.findAll as jest.Mock).mockResolvedValue([
        { createdAt: new Date(), requesterId: otherUserId },
      ]);
      (modelsMock.CheckIn.findAll as jest.Mock).mockResolvedValue([
        { checkedInAt: new Date(), userId: otherUserId },
      ]);
      (modelsMock.CalendarEvent.findAll as jest.Mock).mockResolvedValue([
        { createdAt: new Date(), createdBy: userId },
      ]);

      const result = await getDashboard(userId);

      // Chores chart is untouched — none of these are "chores".
      expect(result.activity[6]).toMatchObject({
        tasksCompleted: 0,
        todosCompleted: 0,
        groceriesBought: 0,
      });

      // Alice: 1 feed post (2) + 1 calendar event (3) = 5 points. Bhim: 1 ping (1) + 1 check-in (2) = 3 points.
      const alice = result.leaderboard.find((l) => l.userId === userId);
      const bhim = result.leaderboard.find((l) => l.userId === otherUserId);
      expect(alice?.points).toBe(5);
      expect(bhim?.points).toBe(3);

      const kinds = result.recentActivity.map((a) => a.kind).sort();
      expect(kinds).toEqual(['calendar', 'checkin', 'feed', 'ping']);
    });

    it('buckets a completion into the household-local day, not the server/UTC day', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId });
      (modelsMock.HouseholdMember.findAll as jest.Mock).mockResolvedValue([
        { userId, user: { displayName: 'Alice', avatarUrl: null, avatarEmoji: null } },
      ]);
      (taskService.getTaskSummaryForHousehold as jest.Mock).mockResolvedValue({ pending: 0, overdue: 0, completedToday: 0 });
      (groceryService.getSummaryForHousehold as jest.Mock).mockResolvedValue({ pending: 0, boughtToday: 0 });
      (todoService.getSummaryForHousehold as jest.Mock).mockResolvedValue({ pending: 0, completedToday: 0 });
      (notificationService.getUnreadCount as jest.Mock).mockResolvedValue(0);

      // Household is in Los Angeles.
      (modelsMock.Household.findByPk as jest.Mock).mockResolvedValue({
        timezone: 'America/Los_Angeles',
      });

      // "Now" is 2026-08-20T02:00:00Z — already Aug 20 in UTC, but still
      // 2026-08-19 19:00 in Los Angeles (UTC-7, PDT in August).
      const now = new Date('2026-08-20T02:00:00.000Z');
      jest.useFakeTimers().setSystemTime(now);

      try {
        // The task was completed at that same instant — household-local "today".
        (modelsMock.Task.findAll as jest.Mock).mockResolvedValue([
          { completedAt: now, completedBy: userId, points: 1 },
        ]);
        (modelsMock.TodoItem.findAll as jest.Mock).mockResolvedValue([]);
        (modelsMock.GroceryItem.findAll as jest.Mock).mockResolvedValue([]);

        const result = await getDashboard(userId);

        // Household-local today (Aug 19, LA time) is the last activity entry
        // and shows the completion — naive UTC bucketing would have filed it
        // under Aug 20 and left "today" looking empty.
        expect(result.activity[6].date).toBe('2026-08-19');
        expect(result.activity[6].tasksCompleted).toBe(1);
        expect(result.activity[6].engaged).toBe(true);
        expect(result.streak.current).toBeGreaterThanOrEqual(1);
      } finally {
        jest.useRealTimers();
      }
    });

    it('self-heals the household timezone from the client-supplied header', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId });
      (modelsMock.HouseholdMember.findAll as jest.Mock).mockResolvedValue([
        { userId, user: { displayName: 'Alice', avatarUrl: null, avatarEmoji: null } },
      ]);
      (taskService.getTaskSummaryForHousehold as jest.Mock).mockResolvedValue({ pending: 0, overdue: 0, completedToday: 0 });
      (groceryService.getSummaryForHousehold as jest.Mock).mockResolvedValue({ pending: 0, boughtToday: 0 });
      (todoService.getSummaryForHousehold as jest.Mock).mockResolvedValue({ pending: 0, completedToday: 0 });
      (notificationService.getUnreadCount as jest.Mock).mockResolvedValue(0);
      // Stored timezone is still the UTC default — a legacy household.
      (modelsMock.Household.findByPk as jest.Mock).mockResolvedValue({ timezone: 'UTC' });
      (modelsMock.Task.findAll as jest.Mock).mockResolvedValue([]);
      (modelsMock.TodoItem.findAll as jest.Mock).mockResolvedValue([]);
      (modelsMock.GroceryItem.findAll as jest.Mock).mockResolvedValue([]);

      await getDashboard(userId, 'America/Los_Angeles');

      expect(modelsMock.Household.update).toHaveBeenCalledWith(
        { timezone: 'America/Los_Angeles' },
        { where: { id: householdId } },
      );
    });

    it('ignores a bogus X-Timezone header instead of throwing', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId });
      (modelsMock.HouseholdMember.findAll as jest.Mock).mockResolvedValue([
        { userId, user: { displayName: 'Alice', avatarUrl: null, avatarEmoji: null } },
      ]);
      (taskService.getTaskSummaryForHousehold as jest.Mock).mockResolvedValue({ pending: 0, overdue: 0, completedToday: 0 });
      (groceryService.getSummaryForHousehold as jest.Mock).mockResolvedValue({ pending: 0, boughtToday: 0 });
      (todoService.getSummaryForHousehold as jest.Mock).mockResolvedValue({ pending: 0, completedToday: 0 });
      (notificationService.getUnreadCount as jest.Mock).mockResolvedValue(0);
      (modelsMock.Household.findByPk as jest.Mock).mockResolvedValue({ timezone: 'UTC' });
      (modelsMock.Task.findAll as jest.Mock).mockResolvedValue([]);
      (modelsMock.TodoItem.findAll as jest.Mock).mockResolvedValue([]);
      (modelsMock.GroceryItem.findAll as jest.Mock).mockResolvedValue([]);

      await expect(getDashboard(userId, 'not/a-real-zone')).resolves.toBeDefined();
      expect(modelsMock.Household.update).not.toHaveBeenCalled();
    });
  });

  describe('dashboard cache', () => {
    function stubFreshComputation() {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId });
      (modelsMock.HouseholdMember.findAll as jest.Mock).mockResolvedValue([
        { userId, user: { displayName: 'Alice', avatarUrl: null, avatarEmoji: null } },
      ]);
      (taskService.getTaskSummaryForHousehold as jest.Mock).mockResolvedValue({ pending: 1, overdue: 0, completedToday: 0 });
      (groceryService.getSummaryForHousehold as jest.Mock).mockResolvedValue({ pending: 2, boughtToday: 0 });
      (todoService.getSummaryForHousehold as jest.Mock).mockResolvedValue({ pending: 3, completedToday: 0 });
      (notificationService.getUnreadCount as jest.Mock).mockResolvedValue(0);
      (modelsMock.Task.findAll as jest.Mock).mockResolvedValue([]);
      (modelsMock.TodoItem.findAll as jest.Mock).mockResolvedValue([]);
      (modelsMock.GroceryItem.findAll as jest.Mock).mockResolvedValue([]);
    }

    it('computes fresh and writes through to Redis on a cache miss', async () => {
      (redis.get as jest.Mock).mockResolvedValue(null);
      stubFreshComputation();

      const result = await getDashboard(userId);

      expect(result.tasks).toEqual({ pending: 1, overdue: 0, completedToday: 0 });
      expect(taskService.getTaskSummaryForHousehold).toHaveBeenCalledWith(householdId);
      expect(redis.setex).toHaveBeenCalledWith(
        `dashboard:${householdId}`,
        expect.any(Number),
        expect.any(String),
      );
    });

    it('skips recomputation on a cache hit, but still refreshes the per-user unread count', async () => {
      const cached = {
        tasks: { pending: 9, overdue: 9, completedToday: 9 },
        groceries: { pending: 9 },
        todos: { pending: 9, completedToday: 9 },
        expenseTotals: { totalExpenses: 0, totalAmount: 0 },
        netBalances: [{ userId, displayName: 'Alice', avatarUrl: null, avatarEmoji: null, paidTotal: 0, shareTotal: 0, netBalance: 42 }],
        activity: [],
        streak: { current: 0, best: 0 },
        leaderboard: [],
        recentActivity: [],
      };
      (redis.get as jest.Mock).mockResolvedValue(JSON.stringify(cached));
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId });
      (notificationService.getUnreadCount as jest.Mock).mockResolvedValue(7);

      const result = await getDashboard(userId);

      expect(result.tasks).toEqual({ pending: 9, overdue: 9, completedToday: 9 });
      expect(result.notifications).toEqual({ unreadCount: 7 });
      expect(result.expenses.myBalance).toBe(42);
      expect(taskService.getTaskSummaryForHousehold).not.toHaveBeenCalled();
      expect(redis.setex).not.toHaveBeenCalled();
    });

    it('falls back to a fresh computation if Redis read fails', async () => {
      (redis.get as jest.Mock).mockRejectedValue(new Error('connection refused'));
      stubFreshComputation();

      const result = await getDashboard(userId);

      expect(result.tasks).toEqual({ pending: 1, overdue: 0, completedToday: 0 });
      expect(taskService.getTaskSummaryForHousehold).toHaveBeenCalled();
    });
  });

  describe('quickNotify', () => {
    it('sends notification to selected members', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId });
      (modelsMock.HouseholdMember.count as jest.Mock).mockResolvedValue(1);
      (modelsMock.User.findByPk as jest.Mock).mockResolvedValue({ displayName: 'Sender' });
      (notificationService.sendToUser as jest.Mock).mockResolvedValue(undefined);

      await quickNotify(userId, 'checked in', [otherUserId]);

      expect(modelsMock.HouseholdMember.count).toHaveBeenCalledWith({
        where: { householdId, userId: { [Op.in]: [otherUserId] } },
      });
      expect(notificationService.sendToUser).toHaveBeenCalledWith(
        otherUserId,
        'check_in',
        'Sender checked in',
        'Quick update from Sender',
        { type: 'check_in' },
      );
    });

    it('throws ForbiddenError for invalid member', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId });
      (modelsMock.HouseholdMember.count as jest.Mock).mockResolvedValue(0);

      await expect(quickNotify(userId, 'checked in', [otherUserId])).rejects.toThrow(
        ForbiddenError,
      );
    });

    it('uses a custom message as the notification body', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId });
      (modelsMock.HouseholdMember.count as jest.Mock).mockResolvedValue(1);
      (modelsMock.User.findByPk as jest.Mock).mockResolvedValue({ displayName: 'Sender' });
      (notificationService.sendToUser as jest.Mock).mockResolvedValue(undefined);

      await quickNotify(userId, 'safe', [otherUserId], 'Picked up the kids!');

      expect(notificationService.sendToUser).toHaveBeenCalledWith(
        otherUserId,
        'check_in',
        'Sender safe',
        'Picked up the kids!',
        { type: 'check_in' },
      );
    });
  });
});