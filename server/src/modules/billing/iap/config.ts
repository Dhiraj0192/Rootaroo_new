import logger from '../../../shared/utils/logger';
import { BillingUnavailableError } from '../errors';

export interface AppleIapConfig {
  keyId: string;
  issuerId: string;
  privateKey: string;
  bundleId: string;
  /** Required for Production-environment verification (the library refuses to verify Production without it). */
  appAppleId: number | null;
}

export interface GoogleIapConfig {
  serviceAccountJson: string;
  packageName: string;
  rtdnAudience: string;
  rtdnServiceAccountEmail: string;
}

export interface IapConfig {
  apple: AppleIapConfig | null;
  google: GoogleIapConfig | null;
  /** OCSP revocation checks for Apple chains. On only in production (needs outbound HTTP to Apple). */
  appleOnlineChecks: boolean;
  warnings: string[];
}

export class IapConfigError extends Error {}

export const DEFAULT_BUNDLE_ID = 'com.rootaroo.app';

/** A `\n`-escaped PEM (the usual way to put a multi-line key in one env var) is turned back into real newlines. */
export function normalizePem(v: string): string {
  return v.includes('\\n') ? v.replace(/\\n/g, '\n') : v;
}

export function loadIapConfig(src: NodeJS.ProcessEnv): IapConfig {
  const errors: string[] = [];
  const warnings: string[] = [];
  const isProd = (src.NODE_ENV || 'development') === 'production';

  const aKey = src.APPLE_IAP_KEY_ID || '';
  const aIssuer = src.APPLE_IAP_ISSUER_ID || '';
  const aPrivate = src.APPLE_IAP_PRIVATE_KEY || '';
  const bundleId = src.APPLE_BUNDLE_ID || DEFAULT_BUNDLE_ID;
  const appIdRaw = src.APPLE_APP_APPLE_ID || '';
  let appAppleId: number | null = null;
  if (appIdRaw) {
    appAppleId = Number(appIdRaw);
    if (!Number.isInteger(appAppleId) || appAppleId <= 0) errors.push('APPLE_APP_APPLE_ID must be a positive integer');
  }
  const appleAny = Boolean(aKey || aIssuer || aPrivate || appIdRaw);
  let apple: AppleIapConfig | null = null;
  if (appleAny) {
    if (!aKey || !aIssuer || !aPrivate) errors.push('APPLE_IAP_KEY_ID, APPLE_IAP_ISSUER_ID and APPLE_IAP_PRIVATE_KEY must be set together');
    else if (!normalizePem(aPrivate).includes('BEGIN PRIVATE KEY')) errors.push('APPLE_IAP_PRIVATE_KEY must be a PKCS#8 PEM (the .p8 contents)');
    else {
      apple = { keyId: aKey, issuerId: aIssuer, privateKey: normalizePem(aPrivate), bundleId, appAppleId };
      if (isProd && !appAppleId) errors.push('APPLE_APP_APPLE_ID is required in production (Production notifications cannot be verified without it)');
    }
  } else {
    warnings.push('Apple IAP is not configured: the Apple webhook and verify endpoint answer 503');
  }

  const gSa = src.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON || '';
  const gPkg = src.GOOGLE_PLAY_PACKAGE_NAME || '';
  const gAud = src.GOOGLE_PLAY_RTDN_AUDIENCE || '';
  const gEmail = src.GOOGLE_PLAY_RTDN_SA_EMAIL || '';
  const googleAny = Boolean(gSa || gAud || gEmail);
  let google: GoogleIapConfig | null = null;
  if (googleAny) {
    if (!gSa || !gAud || !gEmail) errors.push('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON, GOOGLE_PLAY_RTDN_AUDIENCE and GOOGLE_PLAY_RTDN_SA_EMAIL must be set together');
    else {
      try {
        const parsed = JSON.parse(gSa) as { client_email?: string; private_key?: string };
        if (!parsed.client_email || !parsed.private_key) errors.push('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON must contain client_email and private_key');
        else google = { serviceAccountJson: gSa, packageName: gPkg || DEFAULT_BUNDLE_ID, rtdnAudience: gAud, rtdnServiceAccountEmail: gEmail };
      } catch {
        errors.push('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON is not valid JSON');
      }
    }
  } else {
    warnings.push('Google Play billing is not configured: the Google webhook and verify endpoint answer 503');
  }

  if (errors.length > 0) throw new IapConfigError(errors.join('; '));
  return { apple, google, appleOnlineChecks: isProd, warnings };
}

let cached: IapConfig | null = null;

export function getIapConfig(): IapConfig {
  if (!cached) cached = loadIapConfig(process.env);
  return cached;
}

export function requireAppleConfig(): AppleIapConfig {
  const c = getIapConfig().apple;
  if (!c) throw new BillingUnavailableError('Apple purchases are not available right now');
  return c;
}

export function requireGoogleConfig(): GoogleIapConfig {
  const c = getIapConfig().google;
  if (!c) throw new BillingUnavailableError('Google Play purchases are not available right now');
  return c;
}

/** Called from assertBillingConfigAtStartup. Throws IapConfigError on a half-set or malformed configuration. */
export function assertIapConfig(): void {
  const cfg = getIapConfig();
  for (const w of cfg.warnings) logger.warn(`[Billing] ${w}`);
  logger.info(`[Billing] iap apple=${cfg.apple ? 'on' : 'off'} google=${cfg.google ? 'on' : 'off'}`);
}

export function __setIapConfigForTests(cfg: IapConfig | null): void {
  cached = cfg;
}
