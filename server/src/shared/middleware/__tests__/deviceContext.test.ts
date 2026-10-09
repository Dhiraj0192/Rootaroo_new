import { readDeviceInfo } from '../deviceContext';

const req = (headers: Record<string, string>) => ({ headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])) });

describe('readDeviceInfo', () => {
  it('reads the device headers the app sends', () => {
    expect(readDeviceInfo(req({
      'X-Device-Id': '3f2a7c1e-8b4d-4e2f-9a6b-1c2d3e4f5a6b',
      'X-Device-Name': "Asha's iPhone",
      'X-Platform': 'ios',
      'X-App-Version': '1.4.0',
    }) as never)).toEqual({
      deviceKey: '3f2a7c1e-8b4d-4e2f-9a6b-1c2d3e4f5a6b', name: "Asha's iPhone", platform: 'ios', appVersion: '1.4.0',
    });
  });

  it('drops a device id that is not a UUID', () => {
    expect(readDeviceInfo(req({ 'X-Device-Id': 'not-a-uuid; drop table' }) as never).deviceKey).toBeNull();
  });

  it('drops an unknown platform', () => {
    expect(readDeviceInfo(req({ 'X-Platform': 'symbian' }) as never).platform).toBeNull();
  });

  it('trims and caps free-text headers', () => {
    const info = readDeviceInfo(req({ 'X-Device-Name': `  ${'n'.repeat(150)}  `, 'X-App-Version': 'v'.repeat(50) }) as never);
    expect(info.name).toHaveLength(100);
    expect(info.appVersion).toHaveLength(32);
  });

  it('returns nulls when the app sends nothing (older builds)', () => {
    expect(readDeviceInfo(req({}) as never)).toEqual({ deviceKey: null, name: null, platform: null, appVersion: null });
  });
});
