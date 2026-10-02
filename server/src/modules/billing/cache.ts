import redis from '../../config/redis';
import type { BillingMode } from './types';

export const CATALOG_BUST_CHANNEL = 'billing:catalog:bust';

export function entitlementKey(mode: BillingMode, householdId: string): string {
  return `billing:ent:${mode}:${householdId}`;
}

export async function cacheGetJson<T>(key: string): Promise<T | null> {
  if (redis.status !== 'ready') return null;
  try {
    const raw = await redis.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export async function cacheSetJson(key: string, value: unknown, ttlSec: number): Promise<void> {
  if (redis.status !== 'ready') return;
  try {
    await redis.set(key, JSON.stringify(value), 'EX', ttlSec);
  } catch {
    /* fail open */
  }
}

export async function cacheDel(...keys: string[]): Promise<void> {
  if (redis.status !== 'ready' || keys.length === 0) return;
  try {
    await redis.del(...keys);
  } catch {
    /* fail open */
  }
}

export async function publishMessage(channel: string, message: string): Promise<boolean> {
  if (redis.status !== 'ready') return false;
  try {
    await redis.publish(channel, message);
    return true;
  } catch {
    return false;
  }
}
