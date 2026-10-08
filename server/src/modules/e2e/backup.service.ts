import { randomBytes, randomInt } from 'crypto';
import { Op, literal } from 'sequelize';
import redis from '../../config/redis';
import { KeyBackup, KeyRestoreCode, User, sequelize } from '../../database/models';
import { AppError, NotFoundError, ValidationError } from '../../shared/utils/errors';
import { hashOtpCode } from '../../shared/utils/otp';
import logger from '../../shared/utils/logger';
import { getEmail, getKeyVault } from '../../services';
import { assertKeyHolder, assertNotKeyHolder, moveKeyTo, revokePreviousHolders } from './holder';
import type { BackupStatusResponse, PutBackupBody, RestoreParamsResponse } from './types';

export const BACKUP_ATTEMPTS = 10;
export const EMAIL_CODE_ATTEMPTS = 5;
const CODE_TTL_MS = 10 * 60 * 1000;
const TOKEN_TTL_MS = 10 * 60 * 1000;
export const START_LIMIT_PER_USER = 3;
export const START_LIMIT_PER_IP = 10;
const START_WINDOW_SECONDS = 3600;

const vaultCtx = (userId: string) => ({ userId });

/** Counts in Redis; if Redis is down this throws, so the limit fails closed. */
async function withinLimit(key: string, limit: number): Promise<boolean> {
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, START_WINDOW_SECONDS);
  return count <= limit;
}

export async function getBackup(userId: string): Promise<BackupStatusResponse> {
  const backup = await KeyBackup.findByPk(userId);
  if (!backup) throw new NotFoundError('Backup');
  return { kind: backup.kind, createdAt: backup.createdAt.toISOString(), attemptsLeft: backup.attemptsLeft };
}

export async function putBackup(userId: string, deviceId: string | null, body: PutBackupBody): Promise<void> {
  await assertKeyHolder(userId, deviceId);
  // Neither what the phone proved with nor the encrypted blob is stored as received: only the vault's output.
  const verifier = await getKeyVault().mac(body.authKey, vaultCtx(userId));
  const storedBlob = await getKeyVault().encrypt(body.blob, vaultCtx(userId));
  await KeyBackup.upsert({
    userId,
    kind: body.kind,
    salt: body.salt,
    kdf: body.kdf,
    verifier,
    storedBlob,
    attemptsLeft: BACKUP_ATTEMPTS,
    createdAt: new Date(),
  });
}

export async function deleteBackup(userId: string, deviceId: string | null): Promise<void> {
  await assertKeyHolder(userId, deviceId);
  await KeyBackup.destroy({ where: { userId } });
}

export async function startRestore(userId: string, deviceId: string | null, ip: string): Promise<{ expiresAt: string }> {
  if (!deviceId) throw new ValidationError('A registered device is required');
  await assertNotKeyHolder(userId, deviceId);
  if (!(await KeyBackup.findByPk(userId))) throw new NotFoundError('Backup');

  const allowed = (await withinLimit(`e2e:restore-start:user:${userId}`, START_LIMIT_PER_USER))
    && (await withinLimit(`e2e:restore-start:ip:${ip}`, START_LIMIT_PER_IP));
  if (!allowed) throw new AppError(429, 'Too many restore requests. Try again in an hour.', 'RATE_LIMITED');

  const user = await User.findByPk(userId);
  if (!user) throw new NotFoundError('User');

  const code = randomInt(100000, 1000000).toString();
  const expiresAt = new Date(Date.now() + CODE_TTL_MS);
  // One live code per user: asking again replaces the earlier one.
  await KeyRestoreCode.destroy({ where: { userId } });
  await KeyRestoreCode.create({
    userId, deviceId, codeHash: hashOtpCode(code), expiresAt, attemptsLeft: EMAIL_CODE_ATTEMPTS,
  });

  if (getEmail().name === 'log' && process.env.NODE_ENV !== 'production') {
    console.warn(`[DEV] Backup restore code for ${user.email}: ${code}`);
  }
  await getEmail().send({
    to: user.email,
    subject: 'Your Rootaroo restore code',
    text: `Your code to restore your private space is ${code}. It expires in 10 minutes. If this was not you, ignore this email: nothing can be restored without your backup password.`,
  });
  return { expiresAt: expiresAt.toISOString() };
}

export async function restoreParams(userId: string, deviceId: string | null, emailCode: string): Promise<RestoreParamsResponse> {
  if (!deviceId) throw new ValidationError('A registered device is required');
  await assertNotKeyHolder(userId, deviceId);
  const invalid = () => new AppError(400, 'Invalid or expired code', 'INVALID_CODE');

  const backup = await KeyBackup.findByPk(userId);
  if (!backup) throw new NotFoundError('Backup');
  const row = await KeyRestoreCode.findOne({
    where: { userId, deviceId, codeHash: { [Op.ne]: null }, expiresAt: { [Op.gt]: new Date() } },
  });
  if (!row) throw invalid();

  // Spend the try before comparing, atomically, so parallel guesses cannot exceed the cap.
  const [spent] = await KeyRestoreCode.update(
    { attemptsLeft: literal('attempts_left - 1') as unknown as number },
    { where: { id: row.id, attemptsLeft: { [Op.gt]: 0 } } },
  );
  if (spent !== 1 || row.codeHash !== hashOtpCode(emailCode)) throw invalid();

  const restoreToken = randomBytes(32).toString('base64url');
  await KeyRestoreCode.update(
    {
      codeHash: null,
      restoreTokenHash: hashOtpCode(restoreToken),
      restoreTokenExpiresAt: new Date(Date.now() + TOKEN_TTL_MS),
    },
    { where: { id: row.id } },
  );
  return { salt: backup.salt, kdf: backup.kdf, kind: backup.kind, attemptsLeft: backup.attemptsLeft, restoreToken };
}

export async function restore(
  userId: string,
  deviceId: string | null,
  restoreToken: string,
  authKey: string,
): Promise<{ blob: string }> {
  if (!deviceId) throw new ValidationError('A registered device is required');
  await assertNotKeyHolder(userId, deviceId);

  const backup = await KeyBackup.findByPk(userId);
  if (!backup) throw new NotFoundError('Backup');
  const session = await KeyRestoreCode.findOne({
    where: {
      userId, deviceId, restoreTokenHash: hashOtpCode(restoreToken), restoreTokenExpiresAt: { [Op.gt]: new Date() },
    },
  });
  if (!session) throw new AppError(400, 'Invalid or expired restore session', 'INVALID_RESTORE_TOKEN');

  // Spend the guess first and under a row lock, so parallel requests cannot all see "10 left".
  const left = await sequelize.transaction(async (transaction) => {
    const locked = await KeyBackup.findByPk(userId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!locked || locked.attemptsLeft <= 0) return null;
    locked.attemptsLeft -= 1;
    await locked.save({ transaction });
    return locked.attemptsLeft;
  });
  if (left === null) {
    await erase(userId);
    await notifyErased(userId);
    throw erasedError();
  }

  let valid: boolean;
  let blob = '';
  try {
    valid = await getKeyVault().verifyMac(authKey, backup.verifier, vaultCtx(userId));
    if (valid) blob = await getKeyVault().decrypt(backup.storedBlob, vaultCtx(userId));
  } catch (err) {
    // The vault being unavailable is not a wrong guess: give the try back and fail closed.
    await KeyBackup.update({ attemptsLeft: literal('attempts_left + 1') as unknown as number }, { where: { userId } });
    throw err;
  }

  if (!valid) {
    if (left <= 0) {
      await erase(userId);
      await notifyErased(userId);
      throw erasedError();
    }
    throw new AppError(401, 'Wrong backup password', 'WRONG_BACKUP_SECRET', { attemptsLeft: left });
  }

  const previous = await sequelize.transaction(async (transaction) => {
    await KeyBackup.update({ attemptsLeft: BACKUP_ATTEMPTS }, { where: { userId }, transaction });
    await KeyRestoreCode.destroy({ where: { userId }, transaction });
    return moveKeyTo(userId, deviceId, transaction);
  });
  await revokePreviousHolders(userId, previous);
  return { blob };
}

function erasedError(): AppError {
  return new AppError(410, 'Too many wrong guesses: this backup has been erased', 'BACKUP_ERASED');
}

async function erase(userId: string): Promise<void> {
  await KeyBackup.destroy({ where: { userId } });
  await KeyRestoreCode.destroy({ where: { userId } });
}

async function notifyErased(userId: string): Promise<void> {
  try {
    const user = await User.findByPk(userId);
    if (!user) return;
    await getEmail().send({
      to: user.email,
      subject: 'Your Rootaroo backup was erased',
      text: 'Someone entered the wrong backup password too many times, so your backup was erased for good. Your private space is unchanged on the phone that holds it: open Rootaroo there and create a new backup in Settings.',
    });
  } catch (err) {
    logger.error(`[E2E] Could not send the backup-erased email: ${(err as Error).message}`);
  }
}
