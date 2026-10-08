jest.mock('../../billing/socketGate', () => ({ emitToHousehold: jest.fn().mockResolvedValue(undefined) }));
import {
  createItem,
  getItems,
  updateItem,
  deleteItem,
  toggleBought,
  archiveItem,
  getSummary,
} from '../service';
import * as models from '../../../database/models';

const userId = '550e8400-e29b-41d4-a716-446655440001';
const householdId = '770e8400-e29b-41d4-a716-446655440003';
const itemId = '990e8400-e29b-41d4-a716-446655440005';

jest.mock('../../../database/models', () => ({
  GroceryItem: {
    create: jest.fn(),
    findAll: jest.fn(),
    findOne: jest.fn(),
    findByPk: jest.fn(),
    count: jest.fn(),
  },
  User: {},
  HouseholdMember: {
    findOne: jest.fn(),
  },
}));

function fakeItem(overrides: any = {}) {
  return {
    id: itemId,
    householdId,
    name: 'Milk',
    quantity: '1 gallon',
    note: null,
    assignedTo: null,
    isBought: false,
    boughtBy: null,
    boughtAt: null,
    archivedAt: null,
    createdAt: new Date('2026-07-10'),
    updatedAt: new Date('2026-07-10'),
    deletedAt: null,
    get: jest.fn((key: string) => {
      if (key === 'assignee') return null;
      if (key === 'buyer') return null;
      return undefined;
    }),
    save: jest.fn().mockResolvedValue(true),
    destroy: jest.fn(),
    ...overrides,
  };
}

const modelsMock = models as jest.Mocked<typeof models>;

beforeEach(() => { jest.clearAllMocks(); });

describe('Grocery Service', () => {
  describe('createItem', () => {
    it('creates a grocery item', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId });
      (modelsMock.GroceryItem.create as jest.Mock).mockResolvedValue(fakeItem());
      (modelsMock.GroceryItem.findByPk as jest.Mock).mockResolvedValue(fakeItem());

      const result = await createItem(userId, { name: 'Milk' });

      expect(result.name).toBe('Milk');
      expect(result.isBought).toBe(false);
      expect(modelsMock.GroceryItem.create).toHaveBeenCalled();
    });

    it('throws if no household', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue(null);
      await expect(createItem(userId, { name: 'Milk' })).rejects.toThrow(
        'You must belong to a household',
      );
    });
  });

  describe('getItems', () => {
    it('returns grouped groceries', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId });
      (modelsMock.GroceryItem.findAll as jest.Mock).mockResolvedValue([
        fakeItem({ name: 'Pending item' }),
        fakeItem({ name: 'Bought item', isBought: true, boughtBy: userId, boughtAt: new Date() }),
        fakeItem({ name: 'Archived item', isBought: true, archivedAt: new Date() }),
      ]);

      const result = await getItems(userId);

      expect(result.pending).toHaveLength(1);
      expect(result.bought).toHaveLength(1);
      expect(result.archived).toHaveLength(1);
    });
  });

  describe('updateItem', () => {
    it('updates item fields', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId });
      const item = fakeItem();
      (modelsMock.GroceryItem.findOne as jest.Mock).mockResolvedValue(item);

      await updateItem(itemId, userId, 'admin', { name: 'Oat Milk' });

      expect(item.name).toBe('Oat Milk');
      expect(item.save).toHaveBeenCalled();
    });
  });

  describe('deleteItem', () => {
    it('deletes an item', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId });
      const item = fakeItem();
      (modelsMock.GroceryItem.findOne as jest.Mock).mockResolvedValue(item);

      await deleteItem(itemId, userId, 'admin');

      expect(item.destroy).toHaveBeenCalled();
    });
  });

  describe('toggleBought', () => {
    it('marks item as bought', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId });
      const item = fakeItem({ get: (key: string) => {
        if (key === 'assignee') return null;
        if (key === 'buyer') return null;
        return undefined;
      }});
      (modelsMock.GroceryItem.findOne as jest.Mock).mockResolvedValue(item);

      await toggleBought(itemId, userId, 'admin');

      expect(item.isBought).toBe(true);
      expect(item.boughtBy).toBe(userId);
    });

    it('un-marks item as not bought', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId });
      const item = fakeItem({ isBought: true, boughtBy: userId, boughtAt: new Date(), get: (_key: string) => null });
      (modelsMock.GroceryItem.findOne as jest.Mock).mockResolvedValue(item);

      await toggleBought(itemId, userId, 'admin');

      expect(item.isBought).toBe(false);
      expect(item.boughtBy).toBeNull();
    });
  });

  describe('archiveItem', () => {
    it('sets archivedAt', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId });
      const item = fakeItem({ isBought: true });
      (modelsMock.GroceryItem.findOne as jest.Mock).mockResolvedValue(item);

      await archiveItem(itemId, userId, 'admin');

      expect(item.archivedAt).toBeTruthy();
    });
  });

  describe('getSummary', () => {
    it('returns pending and bought-today counts', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId });
      // Call order matches getSummaryForHousehold's Promise.all: pending, boughtToday.
      (modelsMock.GroceryItem.count as jest.Mock)
        .mockResolvedValueOnce(2) // pending
        .mockResolvedValueOnce(1); // boughtToday

      const result = await getSummary(userId);

      expect(result.pending).toBe(2);
      expect(result.boughtToday).toBe(1);
    });
  });
});
