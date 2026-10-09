jest.mock('../../../shared/utils/expoPush', () => ({ sendExpoPush: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../../database/models', () => ({
  NotificationHistory: { create: jest.fn(), count: jest.fn() },
  NotificationPreference: { findOne: jest.fn() },
  DeviceToken: { findAll: jest.fn() },
}));

import { sendToUser } from '../service';
import { NotificationHistory, NotificationPreference, DeviceToken } from '../../../database/models';
import { sendExpoPush } from '../../../shared/utils/expoPush';

const userId = 'u1';
const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  jest.clearAllMocks();
  (DeviceToken.findAll as jest.Mock).mockResolvedValue([{ token: 'ExponentPushToken[a]' }]);
  (NotificationPreference.findOne as jest.Mock).mockResolvedValue(null);
  (NotificationHistory.count as jest.Mock).mockResolvedValue(3);
});

describe('sendToUser', () => {
  it('records history and pushes with the unread count as the badge', async () => {
    await sendToUser(userId, 'feed', 'New post', 'Asha posted', { type: 'feed', postId: 'p1' });
    await flush();
    expect(NotificationHistory.create).toHaveBeenCalledTimes(1);
    expect(sendExpoPush).toHaveBeenCalledWith(
      ['ExponentPushToken[a]'], 'New post', 'Asha posted', { type: 'feed', postId: 'p1' }, { badge: 3 },
    );
  });

  it('skipHistory pushes without writing a history row', async () => {
    await sendToUser(userId, 'chat', 'Asha', 'hi', { type: 'chat', conversationId: 'c1' }, { skipHistory: true });
    await flush();
    expect(NotificationHistory.create).not.toHaveBeenCalled();
    expect(sendExpoPush).toHaveBeenCalledTimes(1);
  });

  describe('excludeDeviceIds', () => {
    const tokens = [
      { token: 'ExponentPushToken[a]', deviceId: 'd1' },
      { token: 'ExponentPushToken[b]', deviceId: 'd2' },
      { token: 'ExponentPushToken[c]', deviceId: null },
    ];

    it('pushes only to tokens of other devices, keeping tokens with no device', async () => {
      (DeviceToken.findAll as jest.Mock).mockResolvedValue(tokens);
      await sendToUser(userId, 'chat', 'Asha', 'hi', {}, { skipHistory: true, excludeDeviceIds: ['d1'] });
      await flush();
      expect(sendExpoPush).toHaveBeenCalledWith(
        ['ExponentPushToken[b]', 'ExponentPushToken[c]'], 'Asha', 'hi', {}, { badge: 3 },
      );
    });

    it('does not push when every token is excluded', async () => {
      (DeviceToken.findAll as jest.Mock).mockResolvedValue(tokens.slice(0, 1));
      await sendToUser(userId, 'chat', 'Asha', 'hi', {}, { skipHistory: true, excludeDeviceIds: ['d1'] });
      await flush();
      expect(sendExpoPush).not.toHaveBeenCalled();
    });
  });

  it.each([
    ['chat', 'chatMessage'],
    ['task_completed', 'taskCompleted'],
    ['member_joined', 'memberJoined'],
  ])('a user who turned off %s pushes gets history only', async (type, field) => {
    (NotificationPreference.findOne as jest.Mock).mockResolvedValue({ [field]: false });
    await sendToUser(userId, type, 'Title', 'Body');
    await flush();
    expect(sendExpoPush).not.toHaveBeenCalled();
  });
});
