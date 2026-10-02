const redisMock: any = { status: 'ready', get: jest.fn(), set: jest.fn(), del: jest.fn(), publish: jest.fn() };
jest.mock('../../../config/redis', () => ({ __esModule: true, default: redisMock }));

import { cacheGetJson, cacheSetJson, cacheDel, publishMessage, entitlementKey } from '../cache';

beforeEach(() => { jest.clearAllMocks(); redisMock.status = 'ready'; });

describe('billing cache', () => {
  it('round-trips JSON with a TTL', async () => {
    await cacheSetJson('k', { a: 1 }, 60);
    expect(redisMock.set).toHaveBeenCalledWith('k', '{"a":1}', 'EX', 60);
    redisMock.get.mockResolvedValue('{"a":1}');
    await expect(cacheGetJson('k')).resolves.toEqual({ a: 1 });
  });

  it('fails open when Redis is down or throws', async () => {
    redisMock.status = 'end';
    await expect(cacheGetJson('k')).resolves.toBeNull();
    await expect(cacheSetJson('k', 1, 60)).resolves.toBeUndefined();
    redisMock.status = 'ready';
    redisMock.get.mockRejectedValue(new Error('down'));
    await expect(cacheGetJson('k')).resolves.toBeNull();
    redisMock.del.mockRejectedValue(new Error('down'));
    await expect(cacheDel('k')).resolves.toBeUndefined();
    redisMock.publish.mockRejectedValue(new Error('down'));
    await expect(publishMessage('c', 'm')).resolves.toBe(false);
  });

  it('builds mode-keyed entitlement keys', () => {
    expect(entitlementKey('live', 'h1')).toBe('billing:ent:live:h1');
  });
});
