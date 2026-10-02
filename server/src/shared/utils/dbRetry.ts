export function isDeadlock(err: unknown): boolean {
  const e = err as { code?: string; parent?: { code?: string }; original?: { code?: string } } | null;
  return [e?.code, e?.parent?.code, e?.original?.code].includes('ER_LOCK_DEADLOCK');
}

/** Re-runs a whole transaction when MySQL picks it as a deadlock victim. */
export async function withDeadlockRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isDeadlock(err) || attempt >= retries) throw err;
      await new Promise((r) => setTimeout(r, 25 * (attempt + 1) + Math.floor(Math.random() * 25)));
    }
  }
}
