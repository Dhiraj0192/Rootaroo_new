import { Request } from 'express';
import type { DeviceInfo } from '../../modules/device/types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLATFORMS = ['ios', 'android', 'web'] as const;

function header(req: Request, name: string): string | null {
  const v = req.headers[name];
  return typeof v === 'string' ? v : null;
}

function text(value: string | null, max: number): string | null {
  const t = value?.trim().slice(0, max).trim();
  return t || null;
}

/** Client-supplied, so everything is validated or capped before it reaches the DB. */
export function readDeviceInfo(req: Request): DeviceInfo {
  const key = header(req, 'x-device-id')?.trim() ?? null;
  const platform = header(req, 'x-platform')?.trim().toLowerCase() ?? null;
  return {
    deviceKey: key && UUID.test(key) ? key : null,
    name: text(header(req, 'x-device-name'), 100),
    platform: PLATFORMS.find((p) => p === platform) ?? null,
    appVersion: text(header(req, 'x-app-version'), 32),
  };
}
