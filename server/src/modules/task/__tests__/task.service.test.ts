jest.mock('../../billing/socketGate', () => ({ emitToHousehold: jest.fn().mockResolvedValue(undefined) }));
import {
  createTask,
  getTasks,
  getTaskById,
  updateTask,
  deleteTask,
  completeTask,
  reopenTask,
  getTaskSummary,
} from '../service';
import * as models from '../../../database/models';
import { Op } from 'sequelize';

const userId = '550e8400-e29b-41d4-a716-446655440001';
const otherUserId = '660e8400-e29b-41d4-a716-446655440002';
const householdId = '770e8400-e29b-41d4-a716-446655440003';
const taskId = '880e8400-e29b-41d4-a716-446655440004';

jest.mock('../../../database/models', () => ({
  Task: {
    create: jest.fn(),
    findAll: jest.fn(),
    findOne: jest.fn(),
    findByPk: jest.fn(),
    count: jest.fn(),
  },
  TaskAssignee: {
    create: jest.fn(),
    findAll: jest.fn(),
    bulkCreate: jest.fn(),
  },
  User: {},
  HouseholdMember: {
    findOne: jest.fn(),
  },
}));

const mockUser = {
  id: userId,
  displayName: 'Test User',
  avatarUrl: null,
  avatarEmoji: null,
  email: 'test@example.com',
};

function fakeTask(overrides: any = {}) {
  return {
    id: taskId,
    householdId,
    createdBy: userId,
    title: 'Test task',
    description: 'A task description',
    dueDate: new Date('2026-07-20'),
    status: 'pending',
    recurrence: 'none',
    recurrenceEndDate: null,
    completedAt: null,
    completedBy: null,
    createdAt: new Date('2026-07-10'),
    updatedAt: new Date('2026-07-10'),
    deletedAt: null,
    get: jest.fn((key: string) => {
      if (key === 'creator') return mockUser;
      if (key === 'completer') return null;
      if (key === 'assignees') return [];
      return undefined;
    }),
    save: jest.fn().mockResolvedValue(true),
    destroy: jest.fn(),
    ...overrides,
  };
}

const modelsMock = models as jest.Mocked<typeof models>;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('Task Service', () => {
  describe('createTask', () => {
    it('creates a task with title and returns it', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId });
      (modelsMock.Task.create as jest.Mock).mockResolvedValue(fakeTask());
      (modelsMock.Task.findByPk as jest.Mock).mockResolvedValue(fakeTask());

      const result = await createTask(userId, { title: 'Test task' });

      expect(result.title).toBe('Test task');
      expect(result.status).toBe('pending');
      expect(modelsMock.Task.create).toHaveBeenCalled();
    });

    it('throws ForbiddenError if user has no household', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue(null);
      await expect(createTask(userId, { title: 'Test' })).rejects.toThrow(
        'You must belong to a household',
      );
    });
  });

  describe('getTasks', () => {
    it('returns flat list of tasks', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId });
      (modelsMock.Task.findAll as jest.Mock).mockResolvedValue([fakeTask()]);

      const result = await getTasks(userId, {});

      expect(Array.isArray(result)).toBe(true);
      expect((result as any[]).length).toBe(1);
    });

    it('returns grouped tasks when group=status', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId });
      const overdueTask = fakeTask({
        dueDate: new Date('2025-01-01'),
        status: 'pending',
      });
      const completedTask = fakeTask({
        status: 'completed',
        completedAt: new Date(),
        completedBy: userId,
      });
      (modelsMock.Task.findAll as jest.Mock).mockResolvedValue([overdueTask, completedTask]);

      const result = await getTasks(userId, { group: 'status' });

      expect(result).toHaveProperty('pending');
      expect(result).toHaveProperty('overdue');
      expect(result).toHaveProperty('completedToday');
    });

    it('only queries open tasks plus tasks completed today when group=status', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId });
      (modelsMock.Task.findAll as jest.Mock).mockResolvedValue([]);

      await getTasks(userId, { group: 'status' });

      const where = (modelsMock.Task.findAll as jest.Mock).mock.calls[0][0].where;
      const orClauses = where[Op.or];
      expect(where.householdId).toBe(householdId);
      expect(orClauses).toHaveLength(2);
      expect(orClauses[0]).toEqual({ status: { [Op.ne]: 'completed' } });
      expect(orClauses[1].completedAt).toHaveProperty([Op.gte]);
      expect(orClauses[1].completedAt).toHaveProperty([Op.lte]);
    });
  });

  describe('getTaskById', () => {
    it('returns a task by ID', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId });
      (modelsMock.Task.findOne as jest.Mock).mockResolvedValue(fakeTask());

      const result = await getTaskById(taskId, userId);

      expect(result.title).toBe('Test task');
      expect(modelsMock.Task.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: taskId, householdId } }),
      );
    });

    it('throws NotFoundError for missing task', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId });
      (modelsMock.Task.findOne as jest.Mock).mockResolvedValue(null);

      await expect(getTaskById(taskId, userId)).rejects.toThrow('Task not found');
    });
  });

  describe('updateTask', () => {
    it('allows creator to update task', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId });
      const task = fakeTask();
      (modelsMock.Task.findOne as jest.Mock).mockResolvedValue(task);

      await updateTask(taskId, userId, 'member', { title: 'Updated title' });

      expect(task.title).toBe('Updated title');
      expect(task.save).toHaveBeenCalled();
    });

    it('forbids non-creator, non-admin from updating', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId });
      (modelsMock.Task.findOne as jest.Mock).mockResolvedValue(fakeTask());

      await expect(
        updateTask(taskId, otherUserId, 'member', { title: 'Hacked' }),
      ).rejects.toThrow('Only the creator or an admin can edit this task');
    });
  });

  describe('deleteTask', () => {
    it('allows creator to delete task', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId });
      const task = fakeTask();
      (modelsMock.Task.findOne as jest.Mock).mockResolvedValue(task);

      await deleteTask(taskId, userId, 'member');

      expect(task.destroy).toHaveBeenCalled();
    });

    it('allows admin to delete any task', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId });
      const task = fakeTask({ createdBy: otherUserId });
      (modelsMock.Task.findOne as jest.Mock).mockResolvedValue(task);

      await deleteTask(taskId, otherUserId, 'admin');

      expect(task.destroy).toHaveBeenCalled();
    });

    it('prevents non-creator, non-admin from deleting', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId });
      const task = fakeTask({ createdBy: otherUserId });
      task.destroy = jest.fn();
      (modelsMock.Task.findOne as jest.Mock).mockResolvedValue(task);

      await expect(deleteTask(taskId, 'stranger', 'member')).rejects.toThrow(
        'Only the creator or an admin can delete this task',
      );
      expect(task.destroy).not.toHaveBeenCalled();
    });
  });

  describe('completeTask / reopenTask', () => {
    it('completes a task with timestamp', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId });
      const task = fakeTask({
        get: jest.fn((key: string) => {
          if (key === 'creator') return mockUser;
          if (key === 'completer') return null;
          if (key === 'assignees') return [mockUser];
          return undefined;
        }),
      });
      (modelsMock.Task.findOne as jest.Mock).mockResolvedValue(task);

      const result = await completeTask(taskId, userId);

      expect(result.status).toBe('completed');
      expect(result.completedAt).toBeTruthy();
    });

    it('re-opens a completed task', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId });
      const task = fakeTask({ status: 'completed', completedAt: new Date(), completedBy: userId });
      (modelsMock.Task.findOne as jest.Mock).mockResolvedValue(task);

      const result = await reopenTask(taskId, userId, 'admin');

      expect(result.status).toBe('reopened');
      expect(result.completedAt).toBeNull();
    });

    it('creates a recurring task clone on completion', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId });
      const task = fakeTask({
        status: 'pending',
        recurrence: 'daily',
        dueDate: '2026-07-10',
        get: jest.fn((key: string) => {
          if (key === 'creator') return mockUser;
          if (key === 'completer') return null;
          if (key === 'assignees') return [mockUser];
          return undefined;
        }),
      });
      (modelsMock.Task.findOne as jest.Mock).mockResolvedValue(task);
      (modelsMock.Task.create as jest.Mock).mockResolvedValue(fakeTask({ id: 'new-task-id' }));
      (modelsMock.TaskAssignee.findAll as jest.Mock).mockResolvedValue([]);

      const result = await completeTask(taskId, userId);

      expect(result.status).toBe('completed');
      expect(modelsMock.Task.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('getTaskSummary', () => {
    it('returns pending/overdue/completed-today counts', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId });
      // Call order matches getTaskSummaryForHousehold's Promise.all: overdue, pending, completedToday.
      (modelsMock.Task.count as jest.Mock)
        .mockResolvedValueOnce(1) // overdue
        .mockResolvedValueOnce(1) // pending
        .mockResolvedValueOnce(1); // completedToday

      const result = await getTaskSummary(userId);

      expect(result.completedToday).toBe(1);
      expect(result.overdue).toBe(1);
      expect(result.pending).toBe(1);
    });
  });
});
