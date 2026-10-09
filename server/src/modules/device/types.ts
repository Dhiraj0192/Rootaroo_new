export type DevicePlatform = 'ios' | 'android' | 'web';

/** What the app tells us about itself on every request (see readDeviceInfo). */
export interface DeviceInfo {
  deviceKey: string | null;
  name: string | null;
  platform: DevicePlatform | null;
  appVersion: string | null;
}

export interface DeviceResponse {
  id: string;
  name: string;
  platform: DevicePlatform | null;
  appVersion: string | null;
  lastSeenAt: string;
  createdAt: string;
  current: boolean;
  /** This phone holds the account's private-space key. */
  holdsKey: boolean;
}
