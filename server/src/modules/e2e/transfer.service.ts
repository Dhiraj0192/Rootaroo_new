import { Op } from 'sequelize';
import { AccountKey, KeyTransferSession, sequelize } from '../../database/models';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../shared/utils/errors';
import { getIO } from '../../shared/utils/socket';
import { assertKeyHolder, isKeyHolder, moveKeyTo, revokePreviousHolders } from './holder';
import type { TransferSessionResponse } from './types';

export const SESSION_TTL_MS = 5 * 60 * 1000;

/** Other users' and expired sessions look the same as missing ones. */
async function loadSession(userId: string, id: string): Promise<KeyTransferSession> {
  const session = await KeyTransferSession.findOne({ where: { id, userId } });
  if (!session || session.status === 'expired' || session.expiresAt.getTime() <= Date.now()) {
    throw new NotFoundError('Transfer session');
  }
  return session;
}

export async function createSession(
  userId: string,
  deviceId: string | null,
  ephemeralPublicKey: string,
): Promise<{ sessionId: string; expiresAt: string }> {
  if (!deviceId) throw new ValidationError('A registered device is required');
  if (!(await AccountKey.findByPk(userId))) throw new ConflictError('Set up your private space first');
  if (await isKeyHolder(userId, deviceId)) throw new ConflictError('This phone already holds your private space');

  // One open session per user: starting again cancels the earlier QR.
  await KeyTransferSession.update(
    { status: 'expired' },
    { where: { userId, status: { [Op.in]: ['open', 'sent'] } } },
  );
  const session = await KeyTransferSession.create({
    userId,
    newDeviceId: deviceId,
    newEphemeralPublicKey: ephemeralPublicKey,
    status: 'open',
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  });
  return { sessionId: session.id, expiresAt: session.expiresAt.toISOString() };
}

export async function getSession(userId: string, deviceId: string | null, id: string): Promise<TransferSessionResponse> {
  const s = await loadSession(userId, id);
  return {
    sessionId: s.id,
    status: s.status,
    expiresAt: s.expiresAt.toISOString(),
    newEphemeralPublicKey: s.newEphemeralPublicKey,
    oldEphemeralPublicKey: s.oldEphemeralPublicKey,
    // The sealed key is only useful to the new phone, so nobody else is handed it.
    payload: s.status === 'sent' && s.newDeviceId === deviceId ? s.payload : null,
  };
}

export async function sendPayload(
  userId: string,
  deviceId: string | null,
  id: string,
  body: { ephemeralPublicKey: string; sealed: string },
): Promise<void> {
  await assertKeyHolder(userId, deviceId);
  const session = await loadSession(userId, id);
  if (session.status !== 'open') throw new ConflictError('This transfer already has its payload');

  // Compare-and-set so two sends cannot both win.
  const [changed] = await KeyTransferSession.update(
    { payload: body.sealed, oldEphemeralPublicKey: body.ephemeralPublicKey, status: 'sent' },
    { where: { id, userId, status: 'open' } },
  );
  if (changed !== 1) throw new ConflictError('This transfer already has its payload');

  try {
    // Id only: the new phone fetches the sealed key itself, so it is not broadcast to every device of the user.
    getIO().to(`user:${userId}`).emit('key-transfer:payload', { sessionId: id });
  } catch {
    // Best effort: sockets are only live in the running server and the new phone also polls.
  }
}

export async function completeSession(userId: string, deviceId: string | null, id: string): Promise<void> {
  const session = await loadSession(userId, id);
  if (!deviceId || session.newDeviceId !== deviceId) {
    throw new ForbiddenError('Only the phone that started this transfer can finish it');
  }
  if (session.status === 'done') throw new ConflictError('This transfer is already complete');
  if (session.status !== 'sent') throw new ConflictError('The other phone has not sent your private space yet');

  const previous = await sequelize.transaction(async (transaction) => {
    // Lock + recheck so a double tap cannot run the move twice.
    const locked = await KeyTransferSession.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!locked || locked.status !== 'sent') throw new ConflictError('This transfer is already complete');
    const holders = await moveKeyTo(userId, deviceId, transaction);
    locked.status = 'done';
    locked.payload = null;
    await locked.save({ transaction });
    return holders;
  });
  await revokePreviousHolders(userId, previous);
}
