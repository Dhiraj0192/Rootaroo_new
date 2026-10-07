import type { Expo as ExpoType, ExpoPushMessage } from 'expo-server-sdk';
import redis from '../../config/redis';
import { DeviceToken } from '../../database/models';
import logger from './logger';

export const PUSH_TICKETS_KEY = 'push:tickets';
const TICKET_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// expo-server-sdk ships ESM-only (no CJS build), while this project compiles
// to CommonJS. A plain `import()` here gets *compiled* to `require()` by
// TypeScript under `module: commonjs` (it downlevels dynamic import too),
// which fails at runtime since Node can't `require()` an ESM-only package.
// Wrapping it in `new Function(...)` hides it from TypeScript's static
// analysis, so it survives as a genuine runtime `import()` — Node's
// supported way to load ESM from CJS.
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const dynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<{ Expo: typeof ExpoType }>;

let modulePromise: Promise<{ Expo: typeof ExpoType }> | null = null;
let clientPromise: Promise<ExpoType> | null = null;

/** Test seam: swap the Expo module (null restores the real one). */
export function __setExpoModuleForTests(mod: { Expo: typeof ExpoType } | null): void {
  modulePromise = mod ? Promise.resolve(mod) : null;
  clientPromise = null;
}

function loadExpoModule() {
  if (!modulePromise) modulePromise = dynamicImport('expo-server-sdk');
  return modulePromise;
}

async function getExpoClient(): Promise<ExpoType> {
  if (!clientPromise) {
    clientPromise = loadExpoModule().then(({ Expo }) => new Expo());
  }
  return clientPromise;
}

export async function sendExpoPush(
  tokens: string[],
  title: string,
  body: string,
  data?: Record<string, string>,
  opts?: { badge?: number },
): Promise<void> {
  try {
    const { Expo } = await loadExpoModule();

    // Old device rows may still hold pre-migration raw FCM/APNs tokens —
    // Expo's API rejects those outright, so filter rather than let one bad
    // token fail an entire chunk. These age out naturally as each user's
    // token is re-registered (upserted) on next app launch.
    const validTokens = tokens.filter((t) => Expo.isExpoPushToken(t));
    if (validTokens.length === 0) return;

    const messages: ExpoPushMessage[] = validTokens.map((token) => ({
      to: token,
      title,
      body,
      data: data || {},
      ...(opts?.badge !== undefined ? { badge: opts.badge } : {}),
    }));

    const expo = await getExpoClient();
    const chunks = expo.chunkPushNotifications(messages);
    for (const chunk of chunks) {
      const tickets = await expo.sendPushNotificationsAsync(chunk);
      const errors: string[] = [];
      // Tickets come back in the same order as the chunk's messages.
      for (let i = 0; i < tickets.length; i++) {
        const ticket = tickets[i];
        const token = chunk[i].to as string;
        if (ticket.status === 'ok') {
          await redis.hset(PUSH_TICKETS_KEY, ticket.id, JSON.stringify({ token, at: Date.now() }));
        } else {
          errors.push(ticket.message);
          if (ticket.details?.error === 'DeviceNotRegistered') {
            await DeviceToken.destroy({ where: { token }, force: true });
          }
        }
      }
      if (errors.length > 0) {
        logger.warn(`[ExpoPush] ${errors.join('; ')}`);
      }
    }
  } catch (error) {
    logger.error('[ExpoPush] Send failed:', (error as Error).message);
    // Don't throw - push is best-effort
  }
}


/**
 * Reads Expo's delivery receipts for tickets saved by sendExpoPush and deletes
 * tokens Expo reports as DeviceNotRegistered. Receipts not ready yet are kept
 * for the next run; Expo only retains them ~24h, so older tickets are dropped.
 */
export async function checkPushReceipts(
  now: number = Date.now(),
): Promise<{ checked: number; removedTokens: number }> {
  const stored = await redis.hgetall(PUSH_TICKETS_KEY);
  const ids = Object.keys(stored);
  if (ids.length === 0) return { checked: 0, removedTokens: 0 };

  const tokenById = new Map<string, string>();
  const done = new Set<string>();
  for (const id of ids) {
    try {
      const { token, at } = JSON.parse(stored[id]) as { token: string; at: number };
      tokenById.set(id, token);
      if (now - at > TICKET_MAX_AGE_MS) done.add(id);
    } catch {
      done.add(id);
    }
  }

  let checked = 0;
  let removedTokens = 0;
  const expo = await getExpoClient();
  for (const chunk of expo.chunkPushNotificationReceiptIds(ids)) {
    const receipts = await expo.getPushNotificationReceiptsAsync(chunk);
    for (const [id, receipt] of Object.entries(receipts)) {
      checked += 1;
      done.add(id);
      if (receipt.status === 'error' && receipt.details?.error === 'DeviceNotRegistered') {
        const token = tokenById.get(id);
        if (token) {
          await DeviceToken.destroy({ where: { token }, force: true });
          removedTokens += 1;
        }
      }
    }
  }

  if (done.size > 0) await redis.hdel(PUSH_TICKETS_KEY, ...done);
  return { checked, removedTokens };
}
