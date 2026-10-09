import { Op, Transaction } from 'sequelize';
import { AccountKey, Device } from '../../database/models';
import { ForbiddenError, NotFoundError } from '../../shared/utils/errors';
import { revokeDevice } from '../device/service';
import logger from '../../shared/utils/logger';

export async function isKeyHolder(userId: string, deviceId: string | null): Promise<boolean> {
  if (!deviceId) return false;
  const device = await Device.findOne({ where: { id: deviceId, userId, holdsAccountKey: true, revokedAt: null } });
  return !!device;
}

export async function assertKeyHolder(userId: string, deviceId: string | null): Promise<void> {
  if (!(await isKeyHolder(userId, deviceId))) {
    throw new ForbiddenError('Only the phone holding your private space can do this');
  }
}

export async function assertNotKeyHolder(userId: string, deviceId: string | null): Promise<void> {
  if (await isKeyHolder(userId, deviceId)) {
    throw new ForbiddenError('This phone already holds your private space');
  }
}

/**
 * Makes `newDeviceId` the only key holder. Returns the devices that held it before,
 * to be signed out once the transaction has committed.
 */
export async function moveKeyTo(userId: string, newDeviceId: string, transaction: Transaction): Promise<string[]> {
  // Serialises two moves for the same user so exactly one device ends up holding the key.
  await AccountKey.findByPk(userId, { transaction, lock: transaction.LOCK.UPDATE });

  const previous = await Device.findAll({
    where: { userId, holdsAccountKey: true, id: { [Op.ne]: newDeviceId } },
    transaction,
  });
  await Device.update({ holdsAccountKey: false }, { where: { userId, id: { [Op.ne]: newDeviceId } }, transaction });
  const [claimed] = await Device.update(
    { holdsAccountKey: true },
    { where: { id: newDeviceId, userId, revokedAt: null }, transaction },
  );
  if (claimed !== 1) throw new ForbiddenError('This phone was signed out');
  return previous.map((d) => d.id);
}

/** Signs the old holders out (Redis marker, so their next request gets DEVICE_REVOKED). */
export async function revokePreviousHolders(userId: string, deviceIds: string[]): Promise<void> {
  for (const id of deviceIds) {
    try {
      // Refresh tokens stay until that phone's next refresh, which answers DEVICE_REVOKED and then removes them.
      await revokeDevice(userId, id, { keepRefreshTokens: true });
    } catch (err) {
      if (err instanceof NotFoundError) continue; // already signed out
      logger.error(`[E2E] Could not revoke previous key holder ${id}: ${(err as Error).message}`);
    }
  }
}
