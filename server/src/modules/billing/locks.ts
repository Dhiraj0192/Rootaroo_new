import crypto from 'crypto';
import redis from '../../config/redis';
import sequelize from '../../config/database';
import logger from '../../shared/utils/logger';
import { LockBusyError } from './errors';

export interface LockOptions { waitMs?: number; retryEveryMs?: number }

type RawConn = { query(sql: string, params: unknown[], cb: (err: Error | null, rows: unknown) => void): void };
type ConnManager = {
  getConnection(opts: { type: 'write' }): Promise<RawConn>;
  releaseConnection(conn: RawConn): Promise<void>;
};

const RELEASE_LUA = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function mysqlLockName(name: string): string {
  if (name.length <= 64) return name;
  return `billing:${crypto.createHash('sha1').update(name).digest('hex')}`;
}

function rawQuery(conn: RawConn, sql: string, params: unknown[]): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    conn.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows as Array<Record<string, unknown>>)));
  });
}

async function withMysqlLock<T>(name: string, fn: () => Promise<T>, waitMs: number): Promise<T> {
  const cm = sequelize.connectionManager as unknown as ConnManager;
  const conn = await cm.getConnection({ type: 'write' });
  const lockName = mysqlLockName(name);
  try {
    const rows = await rawQuery(conn, 'SELECT GET_LOCK(?, ?) AS ok', [lockName, Math.ceil(waitMs / 1000)]);
    if (Number(rows[0]?.ok) !== 1) throw new LockBusyError(name);
    try {
      return await fn();
    } finally {
      await rawQuery(conn, 'SELECT RELEASE_LOCK(?) AS ok', [lockName]).catch(() => undefined);
    }
  } finally {
    await cm.releaseConnection(conn);
  }
}

/**
 * Runs fn while holding a cluster-wide named lock. Redis SET NX PX when Redis is
 * ready, MySQL GET_LOCK otherwise (spec §3 locks.ts). Never hold a DB transaction
 * across fn's network calls: fn opens its own short transactions.
 */
export async function withLock<T>(name: string, ttlMs: number, fn: () => Promise<T>, opts: LockOptions = {}): Promise<T> {
  const waitMs = opts.waitMs ?? 0;
  const every = opts.retryEveryMs ?? 100;
  if (redis.status !== 'ready') return withMysqlLock(name, fn, waitMs);

  const key = `lock:${name}`;
  const token = crypto.randomUUID();
  const deadline = Date.now() + waitMs;
  let acquired = false;
  try {
    for (;;) {
      acquired = (await redis.set(key, token, 'PX', ttlMs, 'NX')) === 'OK';
      if (acquired || Date.now() >= deadline) break;
      await sleep(every);
    }
  } catch (err) {
    logger.warn(`[Billing] Redis lock error on ${name}, falling back to MySQL: ${(err as Error).message}`);
    return withMysqlLock(name, fn, waitMs);
  }
  if (!acquired) throw new LockBusyError(name);
  try {
    return await fn();
  } finally {
    await redis.eval(RELEASE_LUA, 1, key, token).catch(() => undefined);
  }
}
