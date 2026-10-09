jest.mock('../../../database/models', () => ({
  AccountKey: { findByPk: jest.fn() },
  Device: { findOne: jest.fn(), findAll: jest.fn(), update: jest.fn() },
  KeyBackup: { findByPk: jest.fn(), upsert: jest.fn(), destroy: jest.fn(), update: jest.fn() },
  KeyRestoreCode: { findOne: jest.fn(), create: jest.fn(), update: jest.fn(), destroy: jest.fn() },
  User: { findByPk: jest.fn() },
  sequelize: { transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn({ LOCK: { UPDATE: 'UPDATE' } })) },
}));
jest.mock('../../../config/redis', () => ({ __esModule: true, default: { incr: jest.fn(), expire: jest.fn() } }));
jest.mock('../../device/service', () => ({ revokeDevice: jest.fn() }));

import redis from '../../../config/redis';
import { Device, KeyBackup, KeyRestoreCode, User, sequelize } from '../../../database/models';
import { revokeDevice } from '../../device/service';
import { __setServicesForTests } from '../../../services';
import { hashOtpCode } from '../../../shared/utils/otp';
import { createHash } from 'crypto';
import {
  getBackup, putBackup, deleteBackup, startRestore, restoreParams, restore,
} from '../backup.service';

const m = {
  deviceFind: Device.findOne as jest.Mock,
  deviceAll: Device.findAll as jest.Mock,
  deviceUpdate: Device.update as jest.Mock,
  bFind: KeyBackup.findByPk as jest.Mock,
  bUpsert: KeyBackup.upsert as jest.Mock,
  bDestroy: KeyBackup.destroy as jest.Mock,
  bUpdate: KeyBackup.update as jest.Mock,
  cFind: KeyRestoreCode.findOne as jest.Mock,
  cCreate: KeyRestoreCode.create as jest.Mock,
  cUpdate: KeyRestoreCode.update as jest.Mock,
  cDestroy: KeyRestoreCode.destroy as jest.Mock,
  user: User.findByPk as jest.Mock,
  incr: redis.incr as jest.Mock,
};

const OLD = 'dev-old';
const NEW = 'dev-new';
const AUTH_KEY = Buffer.alloc(32, 1).toString('base64');
const BLOB = Buffer.alloc(40, 2).toString('base64');
const sent: Array<{ to: string; subject: string; text: string }> = [];
const vault = {
  name: 'fake',
  mac: jest.fn(async (d: string) => (d === AUTH_KEY ? `mac(${d.length})` : `vault-mac(${d})`)),
  verifyMac: jest.fn(),
  encrypt: jest.fn(async (d: string) => `enc(${d.length})`),
  decrypt: jest.fn(async () => BLOB),
};

const holderIs = (deviceId: string) =>
  m.deviceFind.mockImplementation(async ({ where }: { where: { id: string } }) => (where.id === deviceId ? { id: deviceId } : null));

function backupRow(overrides: Record<string, unknown> = {}) {
  const row = {
    userId: 'u1', kind: 'password', vaultProvider: 'fake', salt: 'salt', kdf: { algorithm: 'argon2id' }, verifier: 'mac(44)', storedBlob: 'enc(56)',
    attemptsLeft: 10, createdAt: new Date('2026-10-01T00:00:00Z'), save: jest.fn(), ...overrides,
  };
  return row;
}

beforeEach(() => {
  jest.clearAllMocks();
  sent.length = 0;
  __setServicesForTests({ email: { name: 'fake', send: async (msg: never) => { sent.push(msg); } }, keyVault: vault });
  holderIs(OLD);
  m.deviceAll.mockResolvedValue([]);
  m.deviceUpdate.mockResolvedValue([1]);
  m.user.mockResolvedValue({ id: 'u1', email: 'asha@example.test' });
  m.incr.mockResolvedValue(1);
  m.cUpdate.mockResolvedValue([1]);
  vault.verifyMac.mockReset();
  vault.verifyMac.mockResolvedValue(true);
});

describe('putBackup / deleteBackup', () => {
  const body = { kind: 'password' as const, salt: 'salt', kdf: { algorithm: 'argon2id' as const, memoryKiB: 19456, iterations: 2, parallelism: 1, length: 64 }, authKey: AUTH_KEY, blob: BLOB };

  it('only the key holder can set or remove it', async () => {
    await expect(putBackup('u1', NEW, body)).rejects.toMatchObject({ statusCode: 403 });
    await expect(deleteBackup('u1', NEW)).rejects.toMatchObject({ statusCode: 403 });
    expect(m.bUpsert).not.toHaveBeenCalled();
    expect(m.bDestroy).not.toHaveBeenCalled();
  });

  it('stores the vault output, never the proof or blob as sent, with 10 tries', async () => {
    await putBackup('u1', OLD, body);
    expect(vault.mac).toHaveBeenCalledWith(AUTH_KEY, { userId: 'u1' });
    expect(vault.encrypt).toHaveBeenCalledWith(BLOB, { userId: 'u1' });
    const row = m.bUpsert.mock.calls[0][0];
    expect(row).toEqual(expect.objectContaining({ userId: 'u1', verifier: `mac(${AUTH_KEY.length})`, storedBlob: `enc(${BLOB.length})`, attemptsLeft: 10, vaultProvider: 'fake' }));
    expect(JSON.stringify(row)).not.toContain(AUTH_KEY);
    expect(JSON.stringify(row)).not.toContain(BLOB);
  });

  it('a changed backup ends any restore in progress, in the same transaction', async () => {
    await putBackup('u1', OLD, body);
    expect(sequelize.transaction).toHaveBeenCalled();
    expect(m.bUpsert).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ transaction: expect.anything() }));
    expect(m.cDestroy).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'u1' }, transaction: expect.anything() }));
  });

  it('a vault failure stores nothing', async () => {
    vault.mac.mockRejectedValueOnce(new Error('kms down'));
    await expect(putBackup('u1', OLD, body)).rejects.toThrow('kms down');
    expect(m.bUpsert).not.toHaveBeenCalled();
  });

  it('removes the backup', async () => {
    await deleteBackup('u1', OLD);
    expect(m.bDestroy).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'u1' } }));
  });
});

describe('getBackup', () => {
  it('returns no secrets, 404 when there is none', async () => {
    m.bFind.mockResolvedValue(backupRow({ attemptsLeft: 7 }));
    expect(await getBackup('u1')).toEqual({ kind: 'password', createdAt: '2026-10-01T00:00:00.000Z', attemptsLeft: 7 });
    m.bFind.mockResolvedValue(null);
    await expect(getBackup('u1')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('startRestore', () => {
  beforeEach(() => holderIs(OLD));

  it('is for a phone that does not hold the key, and needs a backup', async () => {
    m.bFind.mockResolvedValue(backupRow());
    await expect(startRestore('u1', OLD, '1.1.1.1')).rejects.toMatchObject({ statusCode: 403 });
    m.bFind.mockResolvedValue(null);
    await expect(startRestore('u1', NEW, '1.1.1.1')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('emails a 6-digit code and stores only the key vault mac of it, not a plain hash', async () => {
    m.bFind.mockResolvedValue(backupRow());
    await startRestore('u1', NEW, '1.1.1.1');
    expect(sent).toHaveLength(1);
    const code = sent[0].text.match(/\b(\d{6})\b/)![1];
    expect(vault.mac).toHaveBeenCalledWith(code, { userId: 'u1' });
    expect(m.cCreate).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', deviceId: NEW, codeHash: `vault-mac(${code})`, attemptsLeft: 5 }));
    expect(m.cCreate.mock.calls[0][0].codeHash).not.toBe(hashOtpCode(code));
    expect(JSON.stringify(m.cCreate.mock.calls)).not.toContain(`"${code}"`);
  });

  it('allows 3 an hour per user, then 429', async () => {
    m.bFind.mockResolvedValue(backupRow());
    m.incr.mockImplementation(async (key: string) => (key.includes(':user:') ? 4 : 1));
    await expect(startRestore('u1', NEW, '1.1.1.1')).rejects.toMatchObject({ statusCode: 429 });
    expect(sent).toHaveLength(0);
    expect(m.cCreate).not.toHaveBeenCalled();
  });

  it('is also limited per IP', async () => {
    m.bFind.mockResolvedValue(backupRow());
    m.incr.mockImplementation(async (key: string) => (key.includes(':ip:') ? 11 : 1));
    await expect(startRestore('u1', NEW, '1.1.1.1')).rejects.toMatchObject({ statusCode: 429 });
  });

  it('fails closed if the counter store is down', async () => {
    m.bFind.mockResolvedValue(backupRow());
    m.incr.mockRejectedValue(new Error('redis down'));
    await expect(startRestore('u1', NEW, '1.1.1.1')).rejects.toThrow('redis down');
    expect(sent).toHaveLength(0);
  });
});

describe('restoreParams (email code)', () => {
  const live = (overrides: Record<string, unknown> = {}) => ({ id: 'c1', codeHash: 'vault-mac(123456)', ...overrides });
  beforeEach(() => {
    vault.verifyMac.mockImplementation(async (data: string, mac: string) => mac === `vault-mac(${data})`);
  });

  it('a wrong code is checked with the vault, spends a try and is refused', async () => {
    m.bFind.mockResolvedValue(backupRow());
    m.cFind.mockResolvedValue(live());
    await expect(restoreParams('u1', NEW, '000000')).rejects.toMatchObject({ statusCode: 400 });
    expect(vault.verifyMac).toHaveBeenCalledWith('000000', 'vault-mac(123456)', { userId: 'u1' });
    expect(m.cUpdate).toHaveBeenCalledTimes(1);
  });

  it('a row written before keyed codes (a plain sha-256 hex) is invalid, even for the right code', async () => {
    m.bFind.mockResolvedValue(backupRow());
    m.cFind.mockResolvedValue(live({ codeHash: hashOtpCode('123456') }));
    await expect(restoreParams('u1', NEW, '123456')).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_CODE' });
    expect(vault.verifyMac).not.toHaveBeenCalled();
  });

  it('once the 5 tries are spent even the right code is refused', async () => {
    m.bFind.mockResolvedValue(backupRow());
    m.cFind.mockResolvedValue(live());
    m.cUpdate.mockResolvedValue([0]);
    await expect(restoreParams('u1', NEW, '123456')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('the right code returns the parameters and a token stored as a vault mac, and spends the code', async () => {
    m.bFind.mockResolvedValue(backupRow());
    m.cFind.mockResolvedValue(live());
    const out = await restoreParams('u1', NEW, '123456');
    expect(out).toEqual(expect.objectContaining({ salt: 'salt', kind: 'password', attemptsLeft: 10, restoreToken: expect.any(String) }));
    const spend = m.cUpdate.mock.calls[1][0];
    expect(spend.codeHash).toBeNull();
    expect(spend.restoreTokenHash).toBe(`vault-mac(${out.restoreToken})`);
    expect(spend.restoreTokenHash).not.toBe(hashOtpCode(out.restoreToken));
  });

  it('no live code row is a 400, and a key holder is refused', async () => {
    m.bFind.mockResolvedValue(backupRow());
    m.cFind.mockResolvedValue(null);
    await expect(restoreParams('u1', NEW, '123456')).rejects.toMatchObject({ statusCode: 400 });
    await expect(restoreParams('u1', OLD, '123456')).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('restore (password proof)', () => {
  /** The locked backup row the transaction decrements. */
  let locked: ReturnType<typeof backupRow>;

  beforeEach(() => {
    locked = backupRow();
    m.bFind.mockImplementation(async (_id: string, opts?: unknown) => (opts ? locked : backupRow({ attemptsLeft: locked.attemptsLeft, vaultProvider: locked.vaultProvider })));
    m.cFind.mockResolvedValue({ id: 'c1', restoreTokenHash: 'vault-mac(tok)' });
    vault.verifyMac.mockImplementation(async (data: string, mac: string) => (data === AUTH_KEY ? true : mac === `vault-mac(${data})`));
  });

  it('needs a backup (404 once erased) and a valid restore token (400)', async () => {
    m.cFind.mockResolvedValue(null);
    await expect(restore('u1', NEW, 'tok', AUTH_KEY)).rejects.toMatchObject({ statusCode: 400 });
    m.bFind.mockResolvedValue(null);
    await expect(restore('u1', NEW, 'tok', AUTH_KEY)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('checks the token against its stored vault mac', async () => {
    await restore('u1', NEW, 'tok', AUTH_KEY);
    expect(m.cFind).toHaveBeenCalledWith({ where: expect.objectContaining({ userId: 'u1', deviceId: NEW }) });
    expect(vault.verifyMac).toHaveBeenCalledWith('tok', 'vault-mac(tok)', { userId: 'u1' });
  });

  it('a wrong token, or one stored as a plain hash before keyed tokens, is refused', async () => {
    await expect(restore('u1', NEW, 'other', AUTH_KEY)).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_RESTORE_TOKEN' });
    m.cFind.mockResolvedValue({ id: 'c1', restoreTokenHash: createHash('sha256').update('tok').digest('hex') });
    await expect(restore('u1', NEW, 'tok', AUTH_KEY)).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_RESTORE_TOKEN' });
    expect(locked.attemptsLeft).toBe(10);
  });

  it('verifies against the backup row it locked, not one loaded earlier', async () => {
    locked = backupRow({ verifier: 'locked-verifier', storedBlob: 'locked-blob' });
    m.bFind.mockImplementation(async (_id: string, opts?: unknown) => (opts ? locked : backupRow({ verifier: 'stale-verifier', storedBlob: 'stale-blob' })));
    await restore('u1', NEW, 'tok', AUTH_KEY);
    expect(m.bFind).toHaveBeenCalledWith('u1', expect.objectContaining({ lock: 'UPDATE', transaction: expect.anything() }));
    expect(vault.verifyMac).toHaveBeenCalledWith(AUTH_KEY, 'locked-verifier', { userId: 'u1' });
    expect(vault.verifyMac).not.toHaveBeenCalledWith(AUTH_KEY, 'stale-verifier', expect.anything());
    expect(vault.decrypt).toHaveBeenCalledWith('locked-blob', { userId: 'u1' });
  });

  it('a backup replaced while the vault was checking ends the restore (restore session gone)', async () => {
    m.cFind.mockResolvedValueOnce({ id: 'c1', restoreTokenHash: 'vault-mac(tok)' }).mockResolvedValueOnce(null);
    await expect(restore('u1', NEW, 'tok', AUTH_KEY)).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_RESTORE_TOKEN' });
    expect(m.deviceUpdate).not.toHaveBeenCalled();
    expect(revokeDevice).not.toHaveBeenCalled();
  });

  it('a wrong password counts down and reports the tries left', async () => {
    vault.verifyMac.mockImplementation(async (d: string) => d === 'tok');
    await expect(restore('u1', NEW, 'tok', AUTH_KEY)).rejects.toMatchObject({ statusCode: 401, details: { attemptsLeft: 9 } });
    expect(locked.attemptsLeft).toBe(9);
    expect(m.bDestroy).not.toHaveBeenCalled();
    expect(revokeDevice).not.toHaveBeenCalled();
  });

  it('the last wrong guess erases the backup, emails the user and answers 410', async () => {
    locked = backupRow({ attemptsLeft: 1 });
    vault.verifyMac.mockImplementation(async (d: string) => d === 'tok');
    await expect(restore('u1', NEW, 'tok', AUTH_KEY)).rejects.toMatchObject({ statusCode: 410 });
    expect(m.bDestroy).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'u1' } }));
    expect(sent.map((s) => s.subject).join()).toMatch(/erased/i);
    expect(vault.decrypt).not.toHaveBeenCalled();
  });

  it('a backup already at zero is erased without consulting the vault', async () => {
    locked = backupRow({ attemptsLeft: 0 });
    await expect(restore('u1', NEW, 'tok', AUTH_KEY)).rejects.toMatchObject({ statusCode: 410 });
    expect(vault.verifyMac).not.toHaveBeenCalledWith(AUTH_KEY, expect.anything(), expect.anything());
    expect(m.bDestroy).toHaveBeenCalled();
  });

  it('the right password on the last try still succeeds', async () => {
    locked = backupRow({ attemptsLeft: 1 });
    await expect(restore('u1', NEW, 'tok', AUTH_KEY)).resolves.toEqual({ blob: BLOB });
    expect(m.bDestroy).not.toHaveBeenCalled();
  });

  it('success resets the tries, returns the blob, moves the key here and signs the old holder out', async () => {
    m.deviceAll.mockResolvedValue([{ id: OLD }]);
    const out = await restore('u1', NEW, 'tok', AUTH_KEY);
    expect(out).toEqual({ blob: BLOB });
    expect(vault.verifyMac).toHaveBeenCalledWith(AUTH_KEY, 'mac(44)', { userId: 'u1' });
    expect(vault.decrypt).toHaveBeenCalledWith('enc(56)', { userId: 'u1' });
    expect(m.bUpdate).toHaveBeenCalledWith({ attemptsLeft: 10 }, expect.objectContaining({ where: { userId: 'u1' } }));
    expect(m.deviceUpdate).toHaveBeenCalledWith({ holdsAccountKey: true }, expect.anything());
    expect(m.cDestroy).toHaveBeenCalled();
    expect(revokeDevice).toHaveBeenCalledWith('u1', OLD, { keepRefreshTokens: true });
  });

  describe('per-backup provider', () => {
    const legacy = {
      name: 'local',
      mac: jest.fn(), verifyMac: jest.fn(async () => true), encrypt: jest.fn(), decrypt: jest.fn(async () => BLOB),
    };
    beforeEach(() => {
      legacy.verifyMac.mockClear();
      legacy.decrypt.mockClear();
      locked = backupRow({ vaultProvider: 'local' });
    });

    it('verifies and decrypts with the provider recorded on the row, and asks the phone to re-upload', async () => {
      __setServicesForTests({ legacyKeyVault: legacy });
      const out = await restore('u1', NEW, 'tok', AUTH_KEY);
      expect(out).toEqual({ blob: BLOB, rewrap: true });
      expect(legacy.verifyMac).toHaveBeenCalledWith(AUTH_KEY, 'mac(44)', { userId: 'u1' });
      expect(legacy.decrypt).toHaveBeenCalledWith('enc(56)', { userId: 'u1' });
      expect(vault.verifyMac).not.toHaveBeenCalledWith(AUTH_KEY, expect.anything(), expect.anything());
    });

    it('a backup made by the current provider does not ask for a re-upload', async () => {
      __setServicesForTests({ legacyKeyVault: legacy });
      locked = backupRow();
      expect(await restore('u1', NEW, 'tok', AUTH_KEY)).toEqual({ blob: BLOB });
      expect(legacy.verifyMac).not.toHaveBeenCalled();
    });

    it('a provider that is not configured is 503 and no try is spent', async () => {
      __setServicesForTests({ legacyKeyVault: null });
      await expect(restore('u1', NEW, 'tok', AUTH_KEY)).rejects.toMatchObject({
        statusCode: 503, code: 'KEY_VAULT_UNAVAILABLE', message: 'Backups are temporarily unavailable',
      });
      expect(locked.save).not.toHaveBeenCalled();
      expect(m.bUpdate).not.toHaveBeenCalled();
      expect(m.deviceUpdate).not.toHaveBeenCalled();
    });
  });

  it('a key vault error fails closed (raw error, so 500) and gives the try back', async () => {
    vault.verifyMac.mockImplementation(async (d: string) => { if (d === 'tok') return true; throw new Error('throttled'); });
    await expect(restore('u1', NEW, 'tok', AUTH_KEY)).rejects.toThrow('throttled');
    expect(m.bUpdate).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(m.bUpdate.mock.calls[0][0])).toContain('attempts_left + 1');
    expect(m.deviceUpdate).not.toHaveBeenCalled();
    expect(revokeDevice).not.toHaveBeenCalled();
  });

  it('a decrypt error also gives the try back and moves nothing', async () => {
    vault.decrypt.mockRejectedValueOnce(new Error('kms down'));
    await expect(restore('u1', NEW, 'tok', AUTH_KEY)).rejects.toThrow('kms down');
    expect(m.deviceUpdate).not.toHaveBeenCalled();
  });

  it('a key holder cannot restore', async () => {
    await expect(restore('u1', OLD, 'tok', AUTH_KEY)).rejects.toMatchObject({ statusCode: 403 });
  });
});
