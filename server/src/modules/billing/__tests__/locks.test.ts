const redisMock = { status: 'ready', set: jest.fn(), eval: jest.fn().mockResolvedValue(1) };
jest.mock('../../../config/redis', () => ({ __esModule: true, default: redisMock }));

const conn = { query: jest.fn() };
const cm = { getConnection: jest.fn().mockResolvedValue(conn), releaseConnection: jest.fn().mockResolvedValue(undefined) };
jest.mock('../../../config/database', () => ({ __esModule: true, default: { connectionManager: cm, options: { pool: { max: 4 } } } }));

import { withLock, mysqlLockName } from '../locks';
import { LockBusyError } from '../errors';

function mysqlReturns(...values: number[]) {
  const queue = [...values];
  conn.query.mockImplementation((sql: string, _p: unknown[], cb: (e: Error | null, r: unknown) => void) => {
    if (sql.startsWith('SELECT GET_LOCK')) cb(null, [{ ok: queue.shift() ?? 1 }]);
    else cb(null, [{ ok: 1 }]);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  redisMock.status = 'ready';
});

describe('withLock (Redis path)', () => {
  it('acquires with SET NX PX, runs fn, then releases with its own token', async () => {
    redisMock.set.mockResolvedValue('OK');
    const result = await withLock('billing:test', 5000, async () => 42);
    expect(result).toBe(42);
    const [key, token, px, ttl, nx] = redisMock.set.mock.calls[0];
    expect([key, px, ttl, nx]).toEqual(['lock:billing:test', 'PX', 5000, 'NX']);
    expect(redisMock.eval).toHaveBeenCalledWith(expect.stringContaining("redis.call('get'"), 1, 'lock:billing:test', token);
  });

  it('throws LockBusyError immediately when held and waitMs is 0', async () => {
    redisMock.set.mockResolvedValue(null);
    await expect(withLock('billing:test', 5000, async () => 1)).rejects.toBeInstanceOf(LockBusyError);
  });

  it('retries until the lock frees up within waitMs', async () => {
    redisMock.set.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce('OK');
    await expect(withLock('billing:test', 5000, async () => 'ok', { waitMs: 1000, retryEveryMs: 5 })).resolves.toBe('ok');
    expect(redisMock.set).toHaveBeenCalledTimes(3);
  });

  it('releases even when fn throws', async () => {
    redisMock.set.mockResolvedValue('OK');
    await expect(withLock('billing:test', 5000, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(redisMock.eval).toHaveBeenCalled();
  });
});

describe('withLock (MySQL fallback, Review Focus 5)', () => {
  it('falls back to MySQL when Redis is not ready', async () => {
    redisMock.status = 'reconnecting';
    mysqlReturns(1);
    await expect(withLock('billing:x', 5000, async () => 'db')).resolves.toBe('db');
    expect(conn.query.mock.calls.map((c) => c[0])).toEqual(['SELECT GET_LOCK(?, ?) AS ok', 'SELECT RELEASE_LOCK(?) AS ok']);
    expect(cm.releaseConnection).toHaveBeenCalledWith(conn);
  });

  it('falls back to MySQL when a Redis command throws', async () => {
    redisMock.set.mockRejectedValue(new Error('ECONNRESET'));
    mysqlReturns(1);
    await expect(withLock('billing:x', 5000, async () => 'db')).resolves.toBe('db');
  });

  it('throws LockBusyError when GET_LOCK returns 0', async () => {
    redisMock.status = 'end';
    mysqlReturns(0);
    await expect(withLock('billing:x', 5000, async () => 1)).rejects.toBeInstanceOf(LockBusyError);
    expect(cm.releaseConnection).toHaveBeenCalled();
  });
});

describe('mysqlLockName', () => {
  it('keeps short names and hashes long ones to <= 64 chars', () => {
    expect(mysqlLockName('billing:sub:sub_123')).toBe('billing:sub:sub_123');
    const long = mysqlLockName(`billing:checkout:${'a'.repeat(60)}:test`);
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long.startsWith('billing:')).toBe(true);
  });
});

describe('withLock heartbeat and MySQL slots (finding 12)', () => {
  it('extends a Redis lock that outlives its TTL, only while the token is still ours', async () => {
    redisMock.set.mockResolvedValue('OK');
    await withLock('billing:slow', 90, async () => { await new Promise((r) => setTimeout(r, 250)); });
    const extend = redisMock.eval.mock.calls.filter((c) => String(c[0]).includes('pexpire'));
    expect(extend.length).toBeGreaterThanOrEqual(2);
    expect(extend[0].slice(1)).toEqual([1, 'lock:billing:slow', redisMock.set.mock.calls[0][1], 90]);
    const callsAtEnd = redisMock.eval.mock.calls.length;
    await new Promise((r) => setTimeout(r, 150));
    expect(redisMock.eval.mock.calls.length).toBe(callsAtEnd); // heartbeat stopped after release
  });

  it('caps concurrent MySQL lock holders below the pool size so nested locks cannot starve queries', async () => {
    redisMock.status = 'end';
    mysqlReturns(1, 1, 1, 1);
    const release: Array<() => void> = [];
    const hold = () => new Promise<void>((r) => { release.push(r); });
    const a = withLock('billing:a', 1000, hold);
    const b = withLock('billing:b', 1000, hold);
    await new Promise((r) => setTimeout(r, 20));
    expect(cm.getConnection).toHaveBeenCalledTimes(2); // pool max 4 -> 2 slots
    await expect(withLock('billing:c', 1000, async () => 1)).rejects.toBeInstanceOf(LockBusyError);
    expect(cm.getConnection).toHaveBeenCalledTimes(2);
    release.forEach((r) => r());
    await Promise.all([a, b]);
    mysqlReturns(1);
    await expect(withLock('billing:d', 1000, async () => 'free')).resolves.toBe('free');
  });
});
