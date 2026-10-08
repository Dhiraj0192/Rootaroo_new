import type { WeatherResponse } from '../modules/weather/types';

export interface EmailProvider {
  name: string;
  send(msg: { to: string; subject: string; text: string }): Promise<void>;
}

export interface SmsProvider {
  name: string;
  send(to: string, body: string): Promise<void>;
}

export interface PushProvider {
  name: string;
  send(
    tokens: string[],
    title: string,
    body: string,
    data?: Record<string, string>,
    opts?: { badge?: number },
  ): Promise<void>;
  checkReceipts(now?: number): Promise<{ checked: number; removedTokens: number }>;
}

export interface StorageProvider {
  name: string;
  uploadBuffer(
    buffer: Buffer,
    folder: string,
    contentType?: string,
    extension?: string,
  ): Promise<{ key: string }>;
  deleteObject(key: string): Promise<void>;
  downloadObjectBuffer(key: string): Promise<Buffer>;
  getSignedUrl(key: string | null | undefined): Promise<string | null>;
}

export interface WeatherProvider {
  name: string;
  current(lat: number, lon: number): Promise<WeatherResponse>;
}

export interface ErrorReporter {
  name: string;
  capture(err: unknown, context?: Record<string, unknown>): void;
}

export interface KeyVaultContext {
  userId: string;
}

/** Keys that never leave the vault: lets the server check and store secrets it must not be able to read or guess offline. */
export interface KeyVaultProvider {
  name: string;
  mac(data: string, ctx: KeyVaultContext): Promise<string>;
  verifyMac(data: string, mac: string, ctx: KeyVaultContext): Promise<boolean>;
  encrypt(plaintext: string, ctx: KeyVaultContext): Promise<string>;
  decrypt(b64: string, ctx: KeyVaultContext): Promise<string>;
}

export interface ServicesConfig {
  email: 'resend' | 'log';
  sms: 'twilio' | 'log' | 'disabled';
  push: 'expo' | 'log';
  storage: 's3';
  weather: 'open-meteo';
  monitoring: 'sentry' | 'console';
  keyVault: 'local' | 'aws-kms';
}

export interface Services {
  email: EmailProvider;
  sms: SmsProvider;
  push: PushProvider;
  storage: StorageProvider;
  weather: WeatherProvider;
  errors: ErrorReporter;
  keyVault: KeyVaultProvider;
  /** The local vault, kept only while the current provider is aws-kms and the local secret is still set: lets older backups be opened and re-protected. */
  legacyKeyVault?: KeyVaultProvider | null;
}
