import { UniqueConstraintError } from 'sequelize';
import { AccountKey, Device, KeyBackup, sequelize } from '../../database/models';
import { ConflictError, ValidationError } from '../../shared/utils/errors';
import { isKeyHolder } from './holder';
import type { AccountKeyResponse } from './types';

export async function getAccountKey(userId: string, deviceId: string | null): Promise<AccountKeyResponse> {
  const key = await AccountKey.findByPk(userId);
  if (!key) return { publicKey: null, holdsKey: false, hasBackup: false, keyVersion: null };
  const [holdsKey, backup] = await Promise.all([isKeyHolder(userId, deviceId), KeyBackup.findByPk(userId)]);
  return { publicKey: key.publicKey, holdsKey, hasBackup: !!backup, keyVersion: key.keyVersion };
}

/** First-time creation; the creating phone is the holder. */
export async function createAccountKey(userId: string, deviceId: string | null, publicKey: string): Promise<AccountKeyResponse> {
  if (!deviceId) throw new ValidationError('A registered device is required');
  if (await AccountKey.findByPk(userId)) throw new ConflictError('Your private space already exists');

  try {
    await sequelize.transaction(async (transaction) => {
      await AccountKey.create({ userId, publicKey }, { transaction });
      const [claimed] = await Device.update({ holdsAccountKey: true }, { where: { id: deviceId, userId, revokedAt: null }, transaction });
      if (claimed !== 1) throw new ValidationError('A registered device is required');
    });
  } catch (err) {
    // Two phones racing to create: the primary key lets only one through.
    if (err instanceof UniqueConstraintError) throw new ConflictError('Your private space already exists');
    throw err;
  }
  return { publicKey, holdsKey: true, hasBackup: false, keyVersion: 1 };
}
