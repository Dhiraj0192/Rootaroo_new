jest.mock('expo-crypto', () => ({ randomUUID: jest.fn(() => '3f2a7c1e-8b4d-4e2f-9a6b-1c2d3e4f5a6b') }));
jest.mock('expo-constants', () => ({ __esModule: true, default: { deviceName: "Asha's iPhone", expoConfig: { version: '1.4.0' } } }));

const SecureStore = require('expo-secure-store');
const Crypto = require('expo-crypto');
const { loadDeviceId, deviceHeaders, DEVICE_ID_KEY, __resetDeviceInfoForTests } = require('../deviceInfo');

beforeEach(() => {
  jest.clearAllMocks();
  __resetDeviceInfoForTests();
});

describe('deviceInfo', () => {
  it('creates a device id once and keeps it in secure storage', async () => {
    SecureStore.getItemAsync.mockResolvedValueOnce(null);
    const id = await loadDeviceId();
    expect(id).toBe('3f2a7c1e-8b4d-4e2f-9a6b-1c2d3e4f5a6b');
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(DEVICE_ID_KEY, id);
  });

  it('reuses the stored id', async () => {
    SecureStore.getItemAsync.mockResolvedValueOnce('11111111-2222-4333-8444-555555555555');
    expect(await loadDeviceId()).toBe('11111111-2222-4333-8444-555555555555');
    expect(Crypto.randomUUID).not.toHaveBeenCalled();
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
  });

  it('only reads storage once', async () => {
    SecureStore.getItemAsync.mockResolvedValue('11111111-2222-4333-8444-555555555555');
    await loadDeviceId();
    await loadDeviceId();
    expect(SecureStore.getItemAsync).toHaveBeenCalledTimes(1);
  });

  it('builds the headers the server reads', async () => {
    SecureStore.getItemAsync.mockResolvedValueOnce('11111111-2222-4333-8444-555555555555');
    await loadDeviceId();
    expect(deviceHeaders()).toEqual({
      'X-Device-Id': '11111111-2222-4333-8444-555555555555',
      'X-Device-Name': "Asha's iPhone",
      'X-App-Version': '1.4.0',
    });
  });

  it('sends no device id before it has loaded', () => {
    expect(deviceHeaders()['X-Device-Id']).toBeUndefined();
  });
});
