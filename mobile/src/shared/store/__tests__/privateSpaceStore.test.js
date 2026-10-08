import { webcrypto, pbkdf2Sync } from 'node:crypto';

if (!globalThis.crypto?.subtle) globalThis.crypto = webcrypto;

const SecureStore = require('expo-secure-store');
const { generateAccountKeyPair } = require('../../crypto/accountKey');
const { createBackup } = require('../../crypto/keyBackup');
const { createPrivateSpaceStore } = require('../privateSpaceStore');

const fakeKdf = async (secret, salt, params) => new Uint8Array(pbkdf2Sync(secret, Buffer.from(salt), 10, params.length, 'sha256'));
const USER = 'u1';

/** In-memory SecureStore so keys saved by one step are found by the next. */
function memorySecureStore() {
  const m = new Map();
  SecureStore.getItemAsync.mockImplementation(async (k) => (m.has(k) ? m.get(k) : null));
  SecureStore.setItemAsync.mockImplementation(async (k, v) => { m.set(k, v); });
  SecureStore.deleteItemAsync.mockImplementation(async (k) => { m.delete(k); });
  return m;
}

function fakeApi(overrides = {}) {
  return {
    getAccountKey: jest.fn(async () => ({ publicKey: null, holdsKey: false, hasBackup: false })),
    createAccountKey: jest.fn(async () => ({})),
    putBackup: jest.fn(async () => ({})),
    startRestore: jest.fn(async () => ({})),
    restoreParams: jest.fn(),
    restore: jest.fn(),
    ...overrides,
  };
}

const make = (api) => createPrivateSpaceStore({ api, kdf: fakeKdf, getUserId: () => USER });

beforeEach(() => {
  jest.clearAllMocks();
  memorySecureStore();
});

describe('private space status', () => {
  it('none: no account key anywhere yet', async () => {
    const store = make(fakeApi());
    await store.getState().refresh();
    expect(store.getState().status).toBe('none');
  });

  it('here: this phone holds the key', async () => {
    const api = fakeApi();
    const store = make(api);
    await store.getState().setUp({ backup: 'none' });
    api.getAccountKey.mockResolvedValue({ publicKey: store.getState().publicKey, holdsKey: true, hasBackup: false });
    await store.getState().refresh();
    expect(store.getState().status).toBe('here');
  });

  it('elsewhere: the key exists but lives on another phone', async () => {
    const api = fakeApi({ getAccountKey: jest.fn(async () => ({ publicKey: 'PUB', holdsKey: false, hasBackup: true })) });
    const store = make(api);
    await store.getState().refresh();
    expect(store.getState()).toEqual(expect.objectContaining({ status: 'elsewhere', hasBackup: true }));
  });

  it('a phone the server says is not the holder drops any stale local key', async () => {
    const api = fakeApi();
    const store = make(api);
    await store.getState().setUp({ backup: 'none' });
    api.getAccountKey.mockResolvedValue({ publicKey: store.getState().publicKey, holdsKey: false, hasBackup: false });
    await store.getState().refresh();
    expect(store.getState().status).toBe('elsewhere');
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith(`account_key_${USER}`);
  });
});

describe('setting up', () => {
  it('creates the key, registers the public key, keeps the private key on this phone and uploads the backup', async () => {
    const api = fakeApi();
    const store = make(api);
    await store.getState().setUp({ backup: 'password', secret: 'Biscuit' });
    const { publicKey } = store.getState();
    expect(api.createAccountKey).toHaveBeenCalledWith({ publicKey });
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(`account_key_${USER}`, expect.any(String), expect.anything());
    expect(api.putBackup).toHaveBeenCalledWith(expect.objectContaining({ kind: 'password', salt: expect.any(String), authKey: expect.any(String), blob: expect.any(String) }));
    expect(JSON.stringify(api.putBackup.mock.calls)).not.toContain('Biscuit');
    expect(store.getState().status).toBe('here');
  });

  it('with a recovery code, returns the code to show once', async () => {
    const api = fakeApi();
    const store = make(api);
    const { recoveryCode } = await store.getState().setUp({ backup: 'recovery_code' });
    expect(recoveryCode).toMatch(/^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){5}$/);
    expect(api.putBackup).toHaveBeenCalledWith(expect.objectContaining({ kind: 'recovery_code' }));
  });

  it('"No backup" uploads nothing', async () => {
    const api = fakeApi();
    await make(api).getState().setUp({ backup: 'none' });
    expect(api.putBackup).not.toHaveBeenCalled();
  });

  it('does not keep a local key if the server refuses the public key', async () => {
    const api = fakeApi({ createAccountKey: jest.fn(async () => { throw Object.assign(new Error('exists'), { response: { status: 409 } }); }) });
    const store = make(api);
    await expect(store.getState().setUp({ backup: 'none' })).rejects.toThrow();
    expect(await SecureStore.getItemAsync(`account_key_${USER}`)).toBeNull();
  });
});

describe('restoring from backup', () => {
  async function serverWithBackup(secret) {
    const account = await generateAccountKeyPair();
    const backup = await createBackup({ secret, kind: 'password', accountKey: account, kdf: fakeKdf });
    const api = fakeApi({
      getAccountKey: jest.fn(async () => ({ publicKey: account.publicKey, holdsKey: false, hasBackup: true })),
      restoreParams: jest.fn(async () => ({ salt: backup.salt, kdf: backup.kdf, kind: 'password', attemptsLeft: 10, restoreToken: 'tok' })),
      restore: jest.fn(async ({ authKey }) => {
        if (authKey !== backup.authKey) throw Object.assign(new Error('wrong'), { response: { status: 401, data: { code: 'WRONG_BACKUP_SECRET', attemptsLeft: 9 } } });
        return { blob: backup.blob };
      }),
    });
    return { account, api };
  }

  it('email code then the right password brings the key to this phone', async () => {
    const { account, api } = await serverWithBackup('Biscuit');
    const store = make(api);
    await store.getState().refresh();
    await store.getState().startRestore();
    expect(api.startRestore).toHaveBeenCalled();
    await store.getState().submitEmailCode('123456');
    expect(store.getState().restore).toEqual(expect.objectContaining({ step: 'secret', kind: 'password', attemptsLeft: 10 }));
    await store.getState().submitSecret('Biscuit');
    expect(store.getState().status).toBe('here');
    expect(store.getState().publicKey).toBe(account.publicKey);
  });

  it('a wrong password shows the tries left and keeps the restore open', async () => {
    const { api } = await serverWithBackup('Biscuit');
    const store = make(api);
    await store.getState().refresh();
    await store.getState().startRestore();
    await store.getState().submitEmailCode('123456');
    await store.getState().submitSecret('biscuit');
    expect(store.getState().restore).toEqual(expect.objectContaining({ step: 'secret', attemptsLeft: 9, error: 'Wrong password' }));
    expect(store.getState().status).toBe('elsewhere');
  });

  it('the erased backup ends the restore with a clear message', async () => {
    const { api } = await serverWithBackup('Biscuit');
    api.restore.mockRejectedValueOnce(Object.assign(new Error('gone'), { response: { status: 410, data: { code: 'BACKUP_ERASED' } } }));
    const store = make(api);
    await store.getState().refresh();
    await store.getState().startRestore();
    await store.getState().submitEmailCode('123456');
    await store.getState().submitSecret('nope');
    expect(store.getState().restore).toEqual(expect.objectContaining({ step: 'erased' }));
  });
});

describe('signed out after the key moved', () => {
  it('forget() deletes the local key and resets the state', async () => {
    const api = fakeApi();
    const store = make(api);
    await store.getState().setUp({ backup: 'none' });
    await store.getState().forget();
    expect(await SecureStore.getItemAsync(`account_key_${USER}`)).toBeNull();
    expect(store.getState().status).toBe('unknown');
  });
});
