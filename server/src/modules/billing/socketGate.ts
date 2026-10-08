import type { AuthenticatedSocket } from '../../shared/middleware/socketAuth';
import { getIO } from '../../shared/utils/socket';
import logger from '../../shared/utils/logger';
import { getEntitlement } from './entitlement';

export const SOCKET_ENTITLEMENT_TTL_MS = 60_000;

export async function isSocketEntitled(socket: AuthenticatedSocket, now: number = Date.now()): Promise<boolean> {
  const householdId = socket.data.householdId;
  if (!householdId) return false;
  const fresh = socket.data.billingCheckedAt !== undefined
    && socket.data.billingHouseholdId === householdId
    && now - socket.data.billingCheckedAt < SOCKET_ENTITLEMENT_TTL_MS;
  if (fresh) return socket.data.billingAllowed === true;
  try {
    socket.data.billingAllowed = (await getEntitlement(householdId)).allowed;
  } catch (err) {
    logger.warn(`[Billing] socket entitlement check failed for ${householdId}: ${(err as Error).message}`);
    socket.data.billingAllowed = socket.data.billingAllowed ?? false;
  }
  socket.data.billingCheckedAt = now;
  socket.data.billingHouseholdId = householdId;
  return socket.data.billingAllowed;
}

/** Server-side household-room emit that is skipped for blocked households (§7.2). */
export async function emitToHousehold(householdId: string, event: string, payload: unknown): Promise<void> {
  try {
    if (!(await getEntitlement(householdId)).allowed) return;
    getIO().to(`household:${householdId}`).emit(event, payload);
  } catch (err) {
    logger.warn(`[Billing] emitToHousehold(${event}) skipped: ${(err as Error).message}`);
  }
}
