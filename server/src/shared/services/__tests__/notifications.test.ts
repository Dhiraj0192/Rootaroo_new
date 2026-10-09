import { notifyHousehold } from '../notifications';
import { sendToUser } from '../../../modules/notification/service';
import { HouseholdMember } from '../../../database/models';

jest.mock('../../../modules/notification/service', () => ({ sendToUser: jest.fn() }));
jest.mock('../../../database/models', () => ({ HouseholdMember: { findAll: jest.fn() } }));
jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

describe('notifyHousehold', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (HouseholdMember.findAll as jest.Mock).mockResolvedValue([{ userId: 'u1' }, { userId: 'u2' }]);
  });

  it('swallows send failures by default', async () => {
    (sendToUser as jest.Mock).mockRejectedValue(new Error('push down'));
    await expect(notifyHousehold('h1', 'calendar', 't', 'b')).resolves.toBeUndefined();
  });

  it('rejects on a send failure when throwOnError is set', async () => {
    (sendToUser as jest.Mock).mockRejectedValue(new Error('push down'));
    await expect(
      notifyHousehold('h1', 'calendar', 't', 'b', undefined, undefined, { throwOnError: true }),
    ).rejects.toThrow('push down');
  });

  it('with throwOnError, does not reject when some members were reached (a retry would push them twice)', async () => {
    (sendToUser as jest.Mock).mockRejectedValueOnce(new Error('one phone down')).mockResolvedValueOnce(undefined);
    await expect(
      notifyHousehold('h1', 'calendar', 't', 'b', undefined, undefined, { throwOnError: true }),
    ).resolves.toBeUndefined();
    expect(sendToUser).toHaveBeenCalledTimes(2);
  });

  it('rejects when the member lookup fails and throwOnError is set', async () => {
    (HouseholdMember.findAll as jest.Mock).mockRejectedValue(new Error('db down'));
    await expect(
      notifyHousehold('h1', 'calendar', 't', 'b', undefined, undefined, { throwOnError: true }),
    ).rejects.toThrow('db down');
  });

  it('still notifies every other member on success with throwOnError', async () => {
    (sendToUser as jest.Mock).mockResolvedValue(undefined);
    await notifyHousehold('h1', 'calendar', 't', 'b', undefined, 'u2', { throwOnError: true });
    expect(sendToUser).toHaveBeenCalledTimes(1);
    expect(sendToUser).toHaveBeenCalledWith('u1', 'calendar', 't', 'b', undefined, undefined);
  });
});
