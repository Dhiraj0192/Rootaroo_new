jest.mock('../../../database/models', () => ({ DeviceToken: { destroy: jest.fn() } }));
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { hset: jest.fn(), hgetall: jest.fn(), hdel: jest.fn() },
}));

import { DeviceToken } from '../../../database/models';
import redis from '../../../config/redis';
import { sendExpoPush, checkPushReceipts, __setExpoModuleForTests, PUSH_TICKETS_KEY } from '../expoPush';

const send = jest.fn();
const getReceipts = jest.fn();
class FakeExpo {
  static isExpoPushToken(t: string) { return t.startsWith('ExponentPushToken'); }
  chunkPushNotifications(m: unknown[]) { return [m]; }
  chunkPushNotificationReceiptIds(ids: string[]) { return [ids]; }
  sendPushNotificationsAsync(chunk: unknown[]) { return send(chunk); }
  getPushNotificationReceiptsAsync(ids: string[]) { return getReceipts(ids); }
}

const A = 'ExponentPushToken[a]';
const B = 'ExponentPushToken[b]';
const NOW = 1_800_000_000_000;

beforeEach(() => {
  jest.clearAllMocks();
  __setExpoModuleForTests({ Expo: FakeExpo as never });
});
afterAll(() => __setExpoModuleForTests(null));

describe('sendExpoPush', () => {
  it('passes the badge through and skips tokens that are not Expo tokens', async () => {
    send.mockResolvedValue([{ status: 'ok', id: 't1' }]);
    await sendExpoPush([A, 'raw-fcm-token'], 'Hi', 'there', { type: 'feed' }, { badge: 4 });
    expect(send).toHaveBeenCalledWith([expect.objectContaining({ to: A, title: 'Hi', body: 'there', badge: 4, data: { type: 'feed' } })]);
  });

  it('remembers ok tickets so their receipts can be checked later', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    send.mockResolvedValue([{ status: 'ok', id: 't1' }, { status: 'ok', id: 't2' }]);
    await sendExpoPush([A, B], 'Hi', 'there');
    expect(redis.hset).toHaveBeenCalledWith(PUSH_TICKETS_KEY, 't1', JSON.stringify({ token: A, at: NOW }));
    expect(redis.hset).toHaveBeenCalledWith(PUSH_TICKETS_KEY, 't2', JSON.stringify({ token: B, at: NOW }));
    (Date.now as jest.Mock).mockRestore();
  });

  it('deletes a token straight away when the ticket says the device is gone', async () => {
    send.mockResolvedValue([
      { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
      { status: 'ok', id: 't2' },
    ]);
    await sendExpoPush([A, B], 'Hi', 'there');
    expect(DeviceToken.destroy).toHaveBeenCalledWith({ where: { token: A }, force: true });
    expect(DeviceToken.destroy).toHaveBeenCalledTimes(1);
  });

  it('never throws (push is best-effort)', async () => {
    send.mockRejectedValue(new Error('network'));
    await expect(sendExpoPush([A], 'Hi', 'there')).resolves.toBeUndefined();
  });
});

describe('checkPushReceipts', () => {
  it('deletes tokens whose receipt says DeviceNotRegistered and forgets checked tickets', async () => {
    (redis.hgetall as jest.Mock).mockResolvedValue({
      t1: JSON.stringify({ token: A, at: NOW - 20 * 60_000 }),
      t2: JSON.stringify({ token: B, at: NOW - 20 * 60_000 }),
    });
    getReceipts.mockResolvedValue({
      t1: { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
      t2: { status: 'ok' },
    });
    const result = await checkPushReceipts(NOW);
    expect(DeviceToken.destroy).toHaveBeenCalledWith({ where: { token: A }, force: true });
    expect(DeviceToken.destroy).toHaveBeenCalledTimes(1);
    expect(redis.hdel).toHaveBeenCalledWith(PUSH_TICKETS_KEY, 't1', 't2');
    expect(result).toEqual({ checked: 2, removedTokens: 1 });
  });

  it('keeps tickets whose receipt is not ready yet, and drops them after 24 hours', async () => {
    (redis.hgetall as jest.Mock).mockResolvedValue({
      fresh: JSON.stringify({ token: A, at: NOW - 20 * 60_000 }),
      stale: JSON.stringify({ token: B, at: NOW - 25 * 60 * 60_000 }),
    });
    getReceipts.mockResolvedValue({});
    await checkPushReceipts(NOW);
    expect(redis.hdel).toHaveBeenCalledWith(PUSH_TICKETS_KEY, 'stale');
    expect(DeviceToken.destroy).not.toHaveBeenCalled();
  });

  it('does nothing when there are no tickets', async () => {
    (redis.hgetall as jest.Mock).mockResolvedValue({});
    expect(await checkPushReceipts(NOW)).toEqual({ checked: 0, removedTokens: 0 });
    expect(getReceipts).not.toHaveBeenCalled();
  });
});
