import { randomBytes, randomInt } from 'crypto';
import { Op, literal } from 'sequelize';
import redis from '../../config/redis';
import { KeyBackup, KeyRestoreCode, User, sequelize } from '../../database/models';
import { AppError, NotFoundError, ValidationError } from '../../shared/utils/errors';
import logger from '../../shared/utils/logger';
import { getEmail, getKeyVault, getKeyVaultFor } from '../../services';
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

/** Codes and restore tokens are stored as key vault MACs (44 chars of base64). Older rows held a plain SHA-256 hex digest. */
const isLegacyDigest = (stored: string | null): boolean => !stored || /^[0-9a-f]{64}$/.test(stored);

/** True only for a stored vault MAC that matches; legacy or missing values never match. */
async function macMatches(secret: string, stored: string | null, userId: string): Promise<boolean> {
  if (isLegacyDigest(stored)) return false;
  return getKeyVault().verifyMac(secret, stored as string, vaultCtx(userId));
}

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
  const vaultProvider = getKeyVault().name;
  await sequelize.transaction(async (transaction) => {
    await KeyBackup.upsert(
      {
        userId,
        kind: body.kind,
        salt: body.salt,
        kdf: body.kdf,
        vaultProvider,
        verifier,
        storedBlob,
        attemptsLeft: BACKUP_ATTEMPTS,
        createdAt: new Date(),
      },
      { transaction },
    );
    // A restore in progress was started against the old backup: it ends here.
    await KeyRestoreCode.destroy({ where: { userId }, transaction });
  });
}

export async function deleteBackup(userId: string, deviceId: string | null): Promise<void> {
  await assertKeyHolder(userId, deviceId);
  await sequelize.transaction(async (transaction) => {
    await KeyBackup.destroy({ where: { userId }, transaction });
    await KeyRestoreCode.destroy({ where: { userId }, transaction });
  });
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
    userId, deviceId, codeHash: await getKeyVault().mac(code, vaultCtx(userId)), expiresAt, attemptsLeft: EMAIL_CODE_ATTEMPTS,
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
  if (spent !== 1 || !(await macMatches(emailCode, row.codeHash, userId))) throw invalid();

  const restoreToken = randomBytes(32).toString('base64url');
  await KeyRestoreCode.update(
    {
      codeHash: null,
      restoreTokenHash: await getKeyVault().mac(restoreToken, vaultCtx(userId)),
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
): Promise<{ blob: string; rewrap?: true }> {
  if (!deviceId) throw new ValidationError('A registered device is required');
  await assertNotKeyHolder(userId, deviceId);

  const backup = await KeyBackup.findByPk(userId);
  if (!backup) throw new NotFoundError('Backup');
  const invalidSession = () => new AppError(400, 'Invalid or expired restore session', 'INVALID_RESTORE_TOKEN');
  const session = await KeyRestoreCode.findOne({
    where: { userId, deviceId, restoreTokenHash: { [Op.ne]: null }, restoreTokenExpiresAt: { [Op.gt]: new Date() } },
  });
  if (!session || !(await macMatches(restoreToken, session.restoreTokenHash, userId))) throw invalidSession();
  // The backup is opened with the vault that made it. If that one is not configured, nothing is spent.
  if (!getKeyVaultFor(backup.vaultProvider)) throw vaultUnavailable();

  // Spend the guess first and under a row lock, so parallel requests cannot all see "10 left".
  // The row that is checked below is the one read under that lock, never one loaded before it.
  const spent = await sequelize.transaction(async (transaction) => {
    const locked = await KeyBackup.findByPk(userId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!locked || locked.attemptsLeft <= 0) return null;
    locked.attemptsLeft -= 1;
    await locked.save({ transaction });
    return { left: locked.attemptsLeft, verifier: locked.verifier, storedBlob: locked.storedBlob, vaultProvider: locked.vaultProvider };
  });
  if (spent === null) {
    await erase(userId);
    await notifyErased(userId);
    throw erasedError();
  }
  const { left } = spent;

  let valid: boolean;
  let blob = '';
  const backupVault = getKeyVaultFor(spent.vaultProvider);
  try {
    // The backup was replaced by one from a vault that is not configured, between the check above and the lock.
    if (!backupVault) throw vaultUnavailable();
    valid = await backupVault.verifyMac(authKey, spent.verifier, vaultCtx(userId));
    if (valid) blob = await backupVault.decrypt(spent.storedBlob, vaultCtx(userId));
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
    // A backup change (or erase) since the guess deletes the restore session: then this proof is for a backup that is gone.
    const stillLive = await KeyRestoreCode.findOne({ where: { id: session.id }, transaction, lock: transaction.LOCK.UPDATE });
    if (!stillLive) throw invalidSession();
    await KeyBackup.update({ attemptsLeft: BACKUP_ATTEMPTS }, { where: { userId }, transaction });
    await KeyRestoreCode.destroy({ where: { userId }, transaction });
    return moveKeyTo(userId, deviceId, transaction);
  });
  await revokePreviousHolders(userId, previous);
  // Opened with an older vault: the phone re-uploads the backup with the password it just typed, so it is protected by the current one.
  return backupVault.name === getKeyVault().name ? { blob } : { blob, rewrap: true };
}

function vaultUnavailable(): AppError {
  return new AppError(503, 'Backups are temporarily unavailable', 'KEY_VAULT_UNAVAILABLE');
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
