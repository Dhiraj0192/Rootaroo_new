import dotenv from 'dotenv';

dotenv.config();

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),

  db: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    name: process.env.DB_NAME || 'rootaroo_dev',
  },

  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    // Optional — local dev Redis has no auth; managed providers (e.g.
    // Railway) require one. undefined (not '') so ioredis skips AUTH
    // entirely when unset, rather than sending an empty-string password.
    password: process.env.REDIS_PASSWORD || undefined,
  },

  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET || 'dev-access-secret',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret',
    accessExpiry: process.env.JWT_ACCESS_EXPIRY || '15m',
    refreshExpiry: process.env.JWT_REFRESH_EXPIRY || '30d',
  },

  // Dedicated key for encrypting Google Calendar OAuth tokens at rest
  // (CalendarSyncState.accessToken/refreshToken) — kept separate from
  // JWT_ACCESS_SECRET so rotating one doesn't require rotating the other.
  calendarTokenKek: process.env.CALENDAR_TOKEN_KEK || 'dev-calendar-token-kek',

  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    callbackUrl: process.env.GOOGLE_CALLBACK_URL || '',
  },

  // Public origin this server is reachable at — needed to build the
  // absolute Outlook ICS feed subscription URL (webcal), since that URL is
  // handed to Microsoft's servers, not just used internally.
  serverBaseUrl: process.env.SERVER_BASE_URL || `http://localhost:${process.env.PORT || '3000'}`,

  apple: {
    bundleId: process.env.APPLE_BUNDLE_ID || 'com.rootaroo.app',
  },

  // Twilio (phone OTP delivery — login/signup with phone number). Left
  // blank falls back to logging the code in development (see
  // modules/auth/service.ts's issuePhoneOtp), same pattern as SMTP/FCM.
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID || '',
    authToken: process.env.TWILIO_AUTH_TOKEN || '',
    fromNumber: process.env.TWILIO_PHONE_NUMBER || '',
  },

  s3: {
    // No fallback default here — an empty/unset S3_ENDPOINT must mean "use
    // real AWS S3" (config/s3.ts treats a falsy endpoint as "let the SDK
    // resolve it"), not silently redirect to a local MinIO instance that
    // won't exist in production. Local dev sets S3_ENDPOINT explicitly in
    // its own .env instead of relying on a code-level default.
    endpoint: process.env.S3_ENDPOINT || '',
    accessKeyId: process.env.S3_ACCESS_KEY_ID || 'minioadmin',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || 'minioadmin',
    bucket: process.env.S3_BUCKET || 'rootaroo-dev',
    region: process.env.S3_REGION || 'us-east-1',
    useSsl: process.env.S3_USE_SSL === 'true',
  },

  // CloudFront CDN in front of the S3 bucket. When all three are set, media
  // links are CloudFront-signed URLs served from edge locations near the
  // user instead of S3-presigned URLs that always go to the bucket's region.
  // Unset (local dev, MinIO) falls back to plain S3 presigning. The private
  // key is a PEM; newlines may be stored escaped as "\n" in the env var.
  cloudfront: {
    domain: process.env.CLOUDFRONT_DOMAIN || '',
    keyPairId: process.env.CLOUDFRONT_KEY_PAIR_ID || '',
    privateKey: (process.env.CLOUDFRONT_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  },

  // Resend (transactional email — verification codes, password resets,
  // admin alerts). Gmail SMTP was replaced here: its port 587 is
  // unreachable from Railway's network (connections just time out), and
  // Resend is an HTTPS API, not subject to the same outbound-port
  // restriction. Left blank falls back to logging the code in
  // development, same pattern as Twilio/FCM.
  resend: {
    apiKey: process.env.RESEND_API_KEY || '',
  },
  emailFrom: process.env.EMAIL_FROM || 'noreply@rootaroo.com',

  // Rootaroo's own support inbox — receives leave/delete household action
  // request alerts (shared/utils/mailer.ts's sendAdminAlertEmail).
  adminEmail: process.env.ADMIN_EMAIL || '',
  // Static secret guarding the admin-only household action request review
  // API (shared/middleware/adminApiKey.ts) — a separate credential from the
  // per-user JWT, since these endpoints are reviewed by Rootaroo staff, not
  // household members.
  adminApiKey: process.env.ADMIN_API_KEY || '',

  sentryDsn: process.env.SENTRY_DSN || '',
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:3000').split(','),
  logLevel: process.env.LOG_LEVEL || 'debug',
  uploadDir: process.env.UPLOAD_DIR || './uploads',
};

// The JWT/S3 fallbacks above exist purely for local dev convenience. In
// production they must never be reachable — a well-known 'dev-access-secret'
// or 'minioadmin' credential live in prod is a full auth/storage bypass, and
// silently booting on them (rather than refusing to start) is the actual bug
// this closes. Checked here, at import time, so it runs before anything else
// in the app does.
if (env.nodeEnv === 'production') {
  const missing = [
    !process.env.JWT_ACCESS_SECRET && 'JWT_ACCESS_SECRET',
    !process.env.JWT_REFRESH_SECRET && 'JWT_REFRESH_SECRET',
    !process.env.S3_ACCESS_KEY_ID && 'S3_ACCESS_KEY_ID',
    !process.env.S3_SECRET_ACCESS_KEY && 'S3_SECRET_ACCESS_KEY',
    !process.env.S3_BUCKET && 'S3_BUCKET',
    !process.env.CALENDAR_TOKEN_KEK && 'CALENDAR_TOKEN_KEK',
    !process.env.RESEND_API_KEY && 'RESEND_API_KEY',
  ].filter(Boolean);

  if (missing.length > 0) {
    // eslint-disable-next-line no-console
    console.error(`FATAL: refusing to start in production without required secrets: ${missing.join(', ')}`);
    process.exit(1);
  }

  // Non-fatal: an unset ADMIN_API_KEY just means the admin review
  // endpoints 401 everyone (fails safe), not a security hole — this
  // feature is opt-in-by-deploy, so a warning is enough.
  if (!env.adminApiKey) {
    // eslint-disable-next-line no-console
    console.warn('WARNING: ADMIN_API_KEY is not set — the admin household-request review endpoints will reject all requests.');
  }
}
