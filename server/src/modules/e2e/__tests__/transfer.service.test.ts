jest.mock('../../../database/models', () => ({
  AccountKey: { findByPk: jest.fn(), create: jest.fn() },
  Device: { findOne: jest.fn(), findAll: jest.fn(), update: jest.fn() },
  KeyTransferSession: { findOne: jest.fn(), findByPk: jest.fn(), create: jest.fn(), update: jest.fn() },
  sequelize: { transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn({ LOCK: { UPDATE: 'UPDATE' } })) },
}));
jest.mock('../../device/service', () => ({ revokeDevice: jest.fn() }));
jest.mock('../../../shared/utils/socket', () => ({ getIO: jest.fn() }));

import { AccountKey, Device, KeyTransferSession } from '../../../database/models';
import { revokeDevice } from '../../device/service';
import { getIO } from '../../../shared/utils/socket';
import { NotFoundError } from '../../../shared/utils/errors';
import { createSession, getSession, sendPayload, completeSession } from '../transfer.service';

const mocks = {
  key: AccountKey.findByPk as jest.Mock,
  deviceFind: Device.findOne as jest.Mock,
  deviceAll: Device.findAll as jest.Mock,
  deviceUpdate: Device.update as jest.Mock,
  sFind: KeyTransferSession.findOne as jest.Mock,
  sByPk: KeyTransferSession.findByPk as jest.Mock,
  sCreate: KeyTransferSession.create as jest.Mock,
  sUpdate: KeyTransferSession.update as jest.Mock,
};

const OLD = 'dev-old';
const NEW = 'dev-new';
const PK = 'a'.repeat(43) + '=';

function session(overrides: Record<string, unknown> = {}) {
  return {
    id: 's1', userId: 'u1', newDeviceId: NEW, newEphemeralPublicKey: PK, oldEphemeralPublicKey: null, payload: null,
    status: 'open', expiresAt: new Date(Date.now() + 60_000), save: jest.fn(), ...overrides,
  };
}

/** The holder check asks Device.findOne for a holding, non-revoked device. */
const holderIs = (deviceId: string) =>
  mocks.deviceFind.mockImplementation(async ({ where }: { where: { id: string } }) => (where.id === deviceId ? { id: deviceId } : null));

beforeEach(() => {
  jest.clearAllMocks();
  mocks.key.mockResolvedValue({ userId: 'u1' });
  mocks.deviceAll.mockResolvedValue([]);
  mocks.deviceUpdate.mockResolvedValue([1]);
  mocks.sUpdate.mockResolvedValue([1]);
  (getIO as jest.Mock).mockReturnValue({ to: jest.fn().mockReturnValue({ emit: jest.fn() }) });
});

describe('createSession', () => {
  it('needs an account key first', async () => {
    mocks.key.mockResolvedValue(null);
    await expect(createSession('u1', NEW, PK)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('refuses a phone that already holds the key', async () => {
    holderIs(NEW);
    await expect(createSession('u1', NEW, PK)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('opens a 5 minute session and cancels the earlier open ones', async () => {
    holderIs(OLD);
    mocks.sCreate.mockImplementation(async (v: { expiresAt: Date }) => ({ id: 's1', ...v }));
    const out = await createSession('u1', NEW, PK);
    expect(mocks.sUpdate).toHaveBeenCalledWith({ status: 'expired' }, expect.anything());
    const ttl = new Date(out.expiresAt).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(4 * 60_000);
    expect(ttl).toBeLessThanOrEqual(5 * 60_000);
    expect(mocks.sCreate).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', newDeviceId: NEW, newEphemeralPublicKey: PK }));
  });
});

describe('getSession', () => {
  it("another user's or an expired session is 404", async () => {
    mocks.sFind.mockResolvedValue(null);
    await expect(getSession('u2', OLD, 's1')).rejects.toBeInstanceOf(NotFoundError);
    expect(mocks.sFind).toHaveBeenCalledWith({ where: { id: 's1', userId: 'u2' } });
    mocks.sFind.mockResolvedValue(session({ expiresAt: new Date(Date.now() - 1) }));
    await expect(getSession('u1', OLD, 's1')).rejects.toBeInstanceOf(NotFoundError);
    mocks.sFind.mockResolvedValue(session({ status: 'expired' }));
    await expect(getSession('u1', OLD, 's1')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('only the new phone is handed the sealed payload', async () => {
    mocks.sFind.mockResolvedValue(session({ status: 'sent', payload: 'sealed' }));
    expect((await getSession('u1', NEW, 's1')).payload).toBe('sealed');
    expect((await getSession('u1', OLD, 's1')).payload).toBeNull();
  });
});

describe('sendPayload', () => {
  const body = { ephemeralPublicKey: PK, sealed: 'c2VhbGVk' };

  it('only the key holder may send', async () => {
    holderIs(OLD);
    await expect(sendPayload('u1', NEW, 's1', body)).rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.sUpdate).not.toHaveBeenCalled();
  });

  it('stores the payload, tells the user room, and refuses a second payload', async () => {
    holderIs(OLD);
    mocks.sFind.mockResolvedValue(session());
    await sendPayload('u1', OLD, 's1', body);
    expect(mocks.sUpdate).toHaveBeenCalledWith(
      { payload: 'c2VhbGVk', oldEphemeralPublicKey: PK, status: 'sent' },
      { where: { id: 's1', userId: 'u1', status: 'open' } },
    );
    const io = (getIO as jest.Mock).mock.results[0].value;
    expect(io.to).toHaveBeenCalledWith('user:u1');
    expect(io.to.mock.results[0].value.emit).toHaveBeenCalledWith('key-transfer:payload', { sessionId: 's1' });

    mocks.sFind.mockResolvedValue(session({ status: 'sent' }));
    await expect(sendPayload('u1', OLD, 's1', body)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('a lost race on the compare-and-set is a 409', async () => {
    holderIs(OLD);
    mocks.sFind.mockResolvedValue(session());
    mocks.sUpdate.mockResolvedValue([0]);
    await expect(sendPayload('u1', OLD, 's1', body)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('works without a live socket', async () => {
    holderIs(OLD);
    mocks.sFind.mockResolvedValue(session());
    (getIO as jest.Mock).mockImplementation(() => { throw new Error('not initialised'); });
    await expect(sendPayload('u1', OLD, 's1', body)).resolves.toBeUndefined();
  });

  it('an expired session is 404', async () => {
    holderIs(OLD);
    mocks.sFind.mockResolvedValue(session({ expiresAt: new Date(Date.now() - 1) }));
    await expect(sendPayload('u1', OLD, 's1', body)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('completeSession', () => {
  it('only the session\'s new phone can complete', async () => {
    mocks.sFind.mockResolvedValue(session({ status: 'sent' }));
    await expect(completeSession('u1', OLD, 's1')).rejects.toMatchObject({ statusCode: 403 });
    await expect(completeSession('u1', null, 's1')).rejects.toMatchObject({ statusCode: 403 });
  });

  it('needs the payload to have arrived', async () => {
    mocks.sFind.mockResolvedValue(session({ status: 'open' }));
    await expect(completeSession('u1', NEW, 's1')).rejects.toMatchObject({ statusCode: 409 });
  });

  it('moves the key to the new phone, ends the session, and signs the old holder out', async () => {
    const locked = session({ status: 'sent', payload: 'sealed' });
    mocks.sFind.mockResolvedValue(session({ status: 'sent' }));
    mocks.sByPk.mockResolvedValue(locked);
    mocks.deviceAll.mockResolvedValue([{ id: OLD }]);
    await completeSession('u1', NEW, 's1');

    expect(mocks.deviceUpdate).toHaveBeenCalledWith({ holdsAccountKey: false }, expect.anything());
    expect(mocks.deviceUpdate).toHaveBeenCalledWith({ holdsAccountKey: true }, expect.objectContaining({ where: expect.objectContaining({ id: NEW, userId: 'u1' }) }));
    expect(locked.status).toBe('done');
    expect(locked.payload).toBeNull();
    expect(locked.save).toHaveBeenCalled();
    expect(revokeDevice).toHaveBeenCalledWith('u1', OLD, { keepRefreshTokens: true });
  });

  it('a second complete (done) is a 409 and revokes nothing', async () => {
    mocks.sFind.mockResolvedValue(session({ status: 'done' }));
    await expect(completeSession('u1', NEW, 's1')).rejects.toMatchObject({ statusCode: 409 });
    expect(revokeDevice).not.toHaveBeenCalled();
  });

  it('a concurrent complete that loses the lock is a 409', async () => {
    mocks.sFind.mockResolvedValue(session({ status: 'sent' }));
    mocks.sByPk.mockResolvedValue(session({ status: 'done' }));
    await expect(completeSession('u1', NEW, 's1')).rejects.toMatchObject({ statusCode: 409 });
    expect(revokeDevice).not.toHaveBeenCalled();
  });

  it('a phone that was signed out meanwhile cannot take the key', async () => {
    mocks.sFind.mockResolvedValue(session({ status: 'sent' }));
    mocks.sByPk.mockResolvedValue(session({ status: 'sent' }));
    mocks.deviceUpdate.mockResolvedValueOnce([0]).mockResolvedValueOnce([0]);
    await expect(completeSession('u1', NEW, 's1')).rejects.toMatchObject({ statusCode: 403 });
    expect(revokeDevice).not.toHaveBeenCalled();
  });

  it('an old holder already signed out does not fail the completion', async () => {
    mocks.sFind.mockResolvedValue(session({ status: 'sent' }));
    mocks.sByPk.mockResolvedValue(session({ status: 'sent' }));
    mocks.deviceAll.mockResolvedValue([{ id: OLD }]);
    (revokeDevice as jest.Mock).mockRejectedValue(new NotFoundError('Device'));
    await expect(completeSession('u1', NEW, 's1')).resolves.toBeUndefined();
  });
});
