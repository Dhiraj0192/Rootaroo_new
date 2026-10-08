jest.mock('../../billing/socketGate', () => ({ emitToHousehold: jest.fn().mockResolvedValue(undefined) }));
import { createCheckIn, listCheckIns, listMemberCheckIns } from '../service';
import * as models from '../../../database/models';

// ── Mocks ──

const mockUser = {
  id: '550e8400-e29b-41d4-a716-446655440001',
  displayName: 'Test User',
  avatarUrl: null,
};

const householdId = '770e8400-e29b-41d4-a716-446655440003';
const memberUserId = '660e8400-e29b-41d4-a716-446655440002';

jest.mock('../../../database/models', () => {
  const mockSequelize = {
    fn: jest.fn((name: string) => name),
    col: jest.fn((name: string) => name),
  };

  return {
    CheckIn: {
      create: jest.fn(),
      findByPk: jest.fn(),
      findAll: jest.fn(),
    },
    User: {
      findByPk: jest.fn(),
    },
    HouseholdMember: {
      findOne: jest.fn(),
    },
    sequelize: mockSequelize,
  };
});

jest.mock('../../../shared/services/notifications', () => ({
  notifyHousehold: jest.fn().mockResolvedValue(undefined),
  notifyUser: jest.fn().mockResolvedValue(undefined),
}));

// ── Test Setup ──

const mockCheckIn = {
  id: '11111111-1111-1111-1111-111111111111',
  householdId,
  userId: mockUser.id,
  latitude: 27.7172,
  longitude: 85.324,
  address: 'Kathmandu, Nepal',
  note: 'Reached safely!',
  checkedInAt: new Date('2026-08-02T19:29:29.000Z'),
  createdAt: new Date('2026-08-02T19:29:29.000Z'),
  get: jest.fn((key: string) => {
    if (key === 'user') return mockUser;
    return undefined;
  }),
};

const modelsMock = models as jest.Mocked<typeof models>;

beforeEach(() => {
  jest.clearAllMocks();
  (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({
    householdId,
    userId: mockUser.id,
  });
  (modelsMock.User.findByPk as jest.Mock).mockResolvedValue(mockUser);
});

// ── Tests ──

describe('createCheckIn', () => {
  it('creates a check-in with location and note', async () => {
    (modelsMock.CheckIn.create as jest.Mock).mockResolvedValue(mockCheckIn);
    (modelsMock.CheckIn.findByPk as jest.Mock).mockResolvedValue(mockCheckIn);

    const result = await createCheckIn(mockUser.id, {
      latitude: 27.7172,
      longitude: 85.324,
      address: 'Kathmandu, Nepal',
      note: 'Reached safely!',
    });

    expect(modelsMock.CheckIn.create).toHaveBeenCalledWith(
      expect.objectContaining({
        householdId,
        userId: mockUser.id,
        latitude: 27.7172,
        address: 'Kathmandu, Nepal',
      }),
    );
    expect(result.address).toBe('Kathmandu, Nepal');

    // Household gets the push, sender gets a push too (self check-ins push as well)
    const notifications = jest.requireMock('../../../shared/services/notifications') as {
      notifyHousehold: jest.Mock;
      notifyUser: jest.Mock;
    };
    expect(notifications.notifyHousehold).toHaveBeenCalledWith(
      householdId,
      'check_in',
      'Check-In',
      expect.stringContaining('checked in at Kathmandu, Nepal'),
      expect.objectContaining({ type: 'check_in', checkInId: mockCheckIn.id }),
      mockUser.id,
    );
    expect(notifications.notifyUser).toHaveBeenCalledWith(
      mockUser.id,
      'check_in',
      'Check-In',
      expect.stringContaining('You checked in'),
      expect.objectContaining({ type: 'check_in' }),
      { skipPush: false },
    );
  });

  it('creates a timestamp-only check-in when no location given (FR-168)', async () => {
    (modelsMock.CheckIn.create as jest.Mock).mockResolvedValue(mockCheckIn);
    (modelsMock.CheckIn.findByPk as jest.Mock).mockResolvedValue(mockCheckIn);

    const result = await createCheckIn(mockUser.id, { note: 'Just a ping' });

    expect(modelsMock.CheckIn.create).toHaveBeenCalledWith(
      expect.objectContaining({ latitude: null, longitude: null }),
    );
    expect(result).toBeDefined();
  });

  it('throws when the user is not in a household', async () => {
    (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue(null);

    await expect(createCheckIn(mockUser.id, {})).rejects.toThrow(
      'You must belong to a household to check in',
    );
  });
});

describe('listCheckIns', () => {
  it('paginates household check-ins newest-first', async () => {
    const rows = [mockCheckIn, { ...mockCheckIn, id: '22222222-2222-2222-2222-222222222222' }];
    (modelsMock.CheckIn.findAll as jest.Mock).mockResolvedValue(rows);

    const result = await listCheckIns(mockUser.id, { limit: 20 });

    expect(modelsMock.CheckIn.findAll).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { householdId },
        order: [['checkedInAt', 'DESC']],
      }),
    );
    expect(result.items.length).toBe(2);
    expect(result.nextCursor).toBeNull();
  });

  it('filters by member userId', async () => {
    (modelsMock.CheckIn.findAll as jest.Mock).mockResolvedValue([]);

    await listCheckIns(mockUser.id, { limit: 20, userId: memberUserId });

    expect(modelsMock.CheckIn.findAll).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { householdId, userId: memberUserId },
      }),
    );
  });
});

describe('listMemberCheckIns', () => {
  it('returns last 7 days of check-ins for a member (FR-165)', async () => {
    (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({
      householdId,
      userId: memberUserId,
    });
    (modelsMock.CheckIn.findAll as jest.Mock).mockResolvedValue([mockCheckIn]);

    const result = await listMemberCheckIns(mockUser.id, memberUserId, 7);

    expect(modelsMock.CheckIn.findAll).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          householdId,
          userId: memberUserId,
          checkedInAt: expect.any(Object),
        },
      }),
    );
    expect(result.length).toBe(1);
  });

  it('throws NotFound for a member not in the household', async () => {
    // First findOne = requester membership (passes), second = member lookup (fails)
    (modelsMock.HouseholdMember.findOne as jest.Mock)
      .mockResolvedValueOnce({ householdId, userId: mockUser.id })
      .mockResolvedValueOnce(null);

    await expect(listMemberCheckIns(mockUser.id, memberUserId, 7)).rejects.toThrow(
      'Household member',
    );
  });
});
