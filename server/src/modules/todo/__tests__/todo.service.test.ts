jest.mock('../../billing/socketGate', () => ({ emitToHousehold: jest.fn().mockResolvedValue(undefined) }));
import {
  createItem,
  getItems,
  updateItem,
  deleteItem,
  toggleComplete,
  getSummary,
} from '../service';
import * as models from '../../../database/models';

const userId = '550e8400-e29b-41d4-a716-446655440001';
const householdId = '770e8400-e29b-41d4-a716-446655440003';
const itemId = 'aa0e8400-e29b-41d4-a716-446655440006';

jest.mock('../../../database/models', () => ({
  TodoItem: {
    create: jest.fn(),
    findAll: jest.fn(),
    findOne: jest.fn(),
    findByPk: jest.fn(),
    count: jest.fn(),
  },
  User: {},
  HouseholdMember: { findOne: jest.fn() },
}));

function fakeItem(overrides: any = {}) {
  return {
    id: itemId,
    householdId,
    title: 'Buy milk',
    dueDate: new Date('2026-07-25'),
    dueTime: null,
    assignedTo: null,
    createdBy: null,
    isCompleted: false,
    completedAt: null,
    createdAt: new Date('2026-07-10'),
    updatedAt: new Date('2026-07-10'),
    deletedAt: null,
    get: jest.fn((key: string) => {
      if (key === 'assignee') return null;
      return undefined;
    }),
    save: jest.fn().mockResolvedValue(true),
    destroy: jest.fn(),
    ...overrides,
  };
}

const modelsMock = models as jest.Mocked<typeof models>;
beforeEach(() => { jest.clearAllMocks(); });

describe('Todo Service', () => {
  describe('createItem', () => {
    it('creates a todo item', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId });
      (modelsMock.TodoItem.create as jest.Mock).mockResolvedValue(fakeItem());
      (modelsMock.TodoItem.findByPk as jest.Mock).mockResolvedValue(fakeItem());

      const result = await createItem(userId, { title: 'Buy milk' });

      expect(result.title).toBe('Buy milk');
      expect(result.isCompleted).toBe(false);
    });

    it('stores the due time and returns it as HH:MM', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId });
      (modelsMock.TodoItem.create as jest.Mock).mockResolvedValue(fakeItem());
      (modelsMock.TodoItem.findByPk as jest.Mock).mockResolvedValue(fakeItem({ dueTime: '08:30:00' }));

      const result = await createItem(userId, { title: 'Buy milk', dueDate: '2026-07-25', dueTime: '08:30' });

      expect((modelsMock.TodoItem.create as jest.Mock).mock.calls[0][0].dueTime).toBe('08:30');
      expect(result.dueTime).toBe('08:30');
    });

    it('returns null dueTime when none is set', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId });
      (modelsMock.TodoItem.create as jest.Mock).mockResolvedValue(fakeItem());
      (modelsMock.TodoItem.findByPk as jest.Mock).mockResolvedValue(fakeItem());

      const result = await createItem(userId, { title: 'Buy milk' });

      expect((modelsMock.TodoItem.create as jest.Mock).mock.calls[0][0].dueTime).toBeNull();
      expect(result.dueTime).toBeNull();
    });

    it('records the creator and returns them as createdBy', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId });
      (modelsMock.TodoItem.create as jest.Mock).mockResolvedValue(fakeItem());
      const creator = { id: userId, displayName: 'Asha Rai', avatarUrl: null, avatarEmoji: null };
      (modelsMock.TodoItem.findByPk as jest.Mock).mockResolvedValue(
        fakeItem({ createdBy: userId, get: jest.fn((key: string) => (key === 'creator' ? creator : null)) }),
      );

      const result = await createItem(userId, { title: 'Buy milk' });

      expect((modelsMock.TodoItem.create as jest.Mock).mock.calls[0][0].createdBy).toBe(userId);
      expect(result.createdBy).toEqual(creator);
    });

    it('returns null createdBy for to-dos with no recorded creator', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId });
      (modelsMock.TodoItem.findAll as jest.Mock).mockResolvedValue([fakeItem()]);

      const result = await getItems(userId);

      expect(result.pending[0].createdBy).toBeNull();
    });

    it('throws if no household', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue(null);
      await expect(createItem(userId, { title: 'Test' })).rejects.toThrow('belong to a household');
    });
  });

  describe('getItems', () => {
    it('returns grouped todos', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId });
      (modelsMock.TodoItem.findAll as jest.Mock).mockResolvedValue([
        fakeItem({ title: 'Pending' }),
        fakeItem({ title: 'Done', isCompleted: true, completedAt: new Date() }),
      ]);

      const result = await getItems(userId);

      expect(result.pending).toHaveLength(1);
      expect(result.completed).toHaveLength(1);
    });
  });

  describe('updateItem', () => {
    it('updates title', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId });
      const item = fakeItem();
      (modelsMock.TodoItem.findOne as jest.Mock).mockResolvedValue(item);

      await updateItem(itemId, userId, 'admin', { title: 'Updated' });
      expect(item.title).toBe('Updated');
      expect(item.save).toHaveBeenCalled();
    });

    it('sets and clears the due time', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId });
      const item = fakeItem();
      (modelsMock.TodoItem.findOne as jest.Mock).mockResolvedValue(item);

      await updateItem(itemId, userId, 'admin', { dueTime: '16:30' });
      expect(item.dueTime).toBe('16:30');

      await updateItem(itemId, userId, 'admin', { dueTime: null });
      expect(item.dueTime).toBeNull();
    });

    it('leaves the due time alone when not sent', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId });
      const item = fakeItem({ dueTime: '09:00:00' });
      (modelsMock.TodoItem.findOne as jest.Mock).mockResolvedValue(item);

      await updateItem(itemId, userId, 'admin', { title: 'Renamed' });
      expect(item.dueTime).toBe('09:00:00');
    });

    it('lets the creator edit', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId });
      const item = fakeItem({ assignedTo: 'someone-else', createdBy: userId });
      (modelsMock.TodoItem.findOne as jest.Mock).mockResolvedValue(item);

      await updateItem(itemId, userId, 'member', { title: 'Renamed' });
      expect(item.title).toBe('Renamed');
    });

    it('refuses the assignee when they did not create it', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId });
      const item = fakeItem({ assignedTo: userId, createdBy: 'someone-else' });
      (modelsMock.TodoItem.findOne as jest.Mock).mockResolvedValue(item);

      await expect(updateItem(itemId, userId, 'member', { title: 'X' })).rejects.toThrow('creator');
      expect(item.save).not.toHaveBeenCalled();
    });

    it('refuses edits to a completed to-do, even for an admin', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId });
      const item = fakeItem({ isCompleted: true, completedAt: new Date(), createdBy: userId });
      (modelsMock.TodoItem.findOne as jest.Mock).mockResolvedValue(item);

      await expect(updateItem(itemId, userId, 'admin', { title: 'X' })).rejects.toThrow('Completed');
      expect(item.save).not.toHaveBeenCalled();
    });
  });

  describe('deleteItem', () => {
    it('deletes', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId });
      const item = fakeItem();
      (modelsMock.TodoItem.findOne as jest.Mock).mockResolvedValue(item);

      await deleteItem(itemId, userId, 'admin');
      expect(item.destroy).toHaveBeenCalled();
    });

    it('lets the creator delete a to-do assigned to someone else', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId });
      const item = fakeItem({ assignedTo: 'someone-else', createdBy: userId });
      (modelsMock.TodoItem.findOne as jest.Mock).mockResolvedValue(item);

      await deleteItem(itemId, userId, 'member');
      expect(item.destroy).toHaveBeenCalled();
    });

    it('refuses the assignee when they did not create it', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId });
      const item = fakeItem({ assignedTo: userId, createdBy: 'someone-else' });
      (modelsMock.TodoItem.findOne as jest.Mock).mockResolvedValue(item);

      await expect(deleteItem(itemId, userId, 'member')).rejects.toThrow('creator');
      expect(item.destroy).not.toHaveBeenCalled();
    });

    it('refuses other members on an unassigned to-do', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId });
      const item = fakeItem({ assignedTo: null, createdBy: 'someone-else' });
      (modelsMock.TodoItem.findOne as jest.Mock).mockResolvedValue(item);

      await expect(deleteItem(itemId, userId, 'member')).rejects.toThrow('creator');
      expect(item.destroy).not.toHaveBeenCalled();
    });

    it('refuses non-admins on older to-dos with no recorded creator', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId });
      const item = fakeItem({ assignedTo: null, createdBy: null });
      (modelsMock.TodoItem.findOne as jest.Mock).mockResolvedValue(item);

      await expect(deleteItem(itemId, userId, 'member')).rejects.toThrow('creator');
    });
  });

  describe('toggleComplete', () => {
    it('marks complete then incomplete', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId });
      const item = fakeItem();
      (modelsMock.TodoItem.findOne as jest.Mock).mockResolvedValue(item);

      await toggleComplete(itemId, userId, 'admin');
      expect(item.isCompleted).toBe(true);
      expect(item.completedAt).toBeTruthy();
    });
  });

  describe('getSummary', () => {
    it('returns counts', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId });
      // Call order matches getSummaryForHousehold's Promise.all: pending, completedToday.
      (modelsMock.TodoItem.count as jest.Mock)
        .mockResolvedValueOnce(2) // pending
        .mockResolvedValueOnce(1); // completedToday

      const result = await getSummary(userId);

      expect(result.pending).toBe(2);
      expect(result.completedToday).toBe(1);
    });
  });
});
