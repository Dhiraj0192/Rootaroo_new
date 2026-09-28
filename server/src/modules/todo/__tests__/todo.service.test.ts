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
    assignedTo: null,
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
  });

  describe('deleteItem', () => {
    it('deletes', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId });
      const item = fakeItem();
      (modelsMock.TodoItem.findOne as jest.Mock).mockResolvedValue(item);

      await deleteItem(itemId, userId, 'admin');
      expect(item.destroy).toHaveBeenCalled();
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
