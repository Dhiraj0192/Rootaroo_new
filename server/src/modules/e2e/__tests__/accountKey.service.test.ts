jest.mock('../../../database/models', () => ({
  AccountKey: { findByPk: jest.fn(), create: jest.fn() },
  Device: { findOne: jest.fn(), update: jest.fn() },
  KeyBackup: { findByPk: jest.fn() },
  sequelize: { transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn({ LOCK: { UPDATE: 'UPDATE' } })) },
}));

import { UniqueConstraintError } from 'sequelize';
import { AccountKey, Device, KeyBackup } from '../../../database/models';
import { getAccountKey, createAccountKey } from '../accountKey.service';

const create = AccountKey.create as jest.Mock;
const find = AccountKey.findByPk as jest.Mock;
const deviceUpdate = Device.update as jest.Mock;
const PK = 'a'.repeat(43) + '=';

beforeEach(() => {
  jest.clearAllMocks();
  deviceUpdate.mockResolvedValue([1]);
});

describe('createAccountKey', () => {
  it('creates the key once and makes the creating phone the holder', async () => {
    find.mockResolvedValue(null);
    const out = await createAccountKey('u1', 'dev1', PK);
    expect(create).toHaveBeenCalledWith({ userId: 'u1', publicKey: PK }, expect.anything());
    expect(deviceUpdate).toHaveBeenCalledWith({ holdsAccountKey: true }, expect.objectContaining({ where: expect.objectContaining({ id: 'dev1', userId: 'u1' }) }));
    expect(out).toEqual(expect.objectContaining({ publicKey: PK, holdsKey: true, hasBackup: false }));
  });

  it('a second create is a 409, including when two phones race', async () => {
    find.mockResolvedValue({ userId: 'u1' });
    await expect(createAccountKey('u1', 'dev1', PK)).rejects.toMatchObject({ statusCode: 409 });
    find.mockResolvedValue(null);
    create.mockRejectedValueOnce(new UniqueConstraintError({}));
    await expect(createAccountKey('u1', 'dev1', PK)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('needs a registered device', async () => {
    await expect(createAccountKey('u1', null, PK)).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('getAccountKey', () => {
  it('reports no key yet', async () => {
    find.mockResolvedValue(null);
    expect(await getAccountKey('u1', 'dev1')).toEqual({ publicKey: null, holdsKey: false, hasBackup: false, keyVersion: null });
  });

  it('reports whether this phone holds the key and whether a backup exists', async () => {
    find.mockResolvedValue({ publicKey: PK, keyVersion: 1 });
    (Device.findOne as jest.Mock).mockResolvedValue(null);
    (KeyBackup.findByPk as jest.Mock).mockResolvedValue({ userId: 'u1' });
    expect(await getAccountKey('u1', 'dev2')).toEqual({ publicKey: PK, holdsKey: false, hasBackup: true, keyVersion: 1 });
  });
});
