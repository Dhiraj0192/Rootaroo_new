import { DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl as presign } from '@aws-sdk/s3-request-presigner';
import { getSignedUrl as cloudfrontSign } from '@aws-sdk/cloudfront-signer';
import { randomUUID } from 'crypto';
import { s3Client, S3_BUCKET } from '../../config/s3';
import { env } from '../../config/env';
import logger from './logger';

const SIGNED_URL_TTL_SECONDS = 3600;

// CloudFront links expire at the end of the NEXT fixed 6-hour window rather
// than "now + N". Every request inside the same window therefore gets a
// byte-identical URL for a given file, so the phone's image cache (and any
// HTTP cache in between) can actually reuse it — a fresh signature per
// request would look like a new URL every time. Validity is 6-12 hours.
const CLOUDFRONT_WINDOW_MS = 6 * 60 * 60 * 1000;

function cloudfrontEnabled(): boolean {
  const { domain, keyPairId, privateKey } = env.cloudfront;
  return !!(domain && keyPairId && privateKey);
}

// Each signature is a synchronous RSA-2048 operation (~1ms), and a feed page
// needs 40-80 of them — enough to block the event loop for every other
// request arriving at the same moment. Since a URL is fixed for its whole
// window anyway, sign each key once per window and reuse it.
const signedUrlCache = new Map<string, string>();
let signedUrlCacheWindow = 0;

function signCloudfrontUrl(key: string): string {
  const { domain, keyPairId, privateKey } = env.cloudfront;
  const windowEnd = (Math.floor(Date.now() / CLOUDFRONT_WINDOW_MS) + 2) * CLOUDFRONT_WINDOW_MS;
  if (windowEnd !== signedUrlCacheWindow) {
    signedUrlCache.clear();
    signedUrlCacheWindow = windowEnd;
  }
  const cached = signedUrlCache.get(key);
  if (cached) return cached;

  const url = cloudfrontSign({
    url: `https://${domain}/${encodeURI(key)}`,
    keyPairId,
    privateKey,
    dateLessThan: new Date(windowEnd).toISOString(),
  });
  signedUrlCache.set(key, url);
  return url;
}

export async function uploadBuffer(
  buffer: Buffer,
  folder: string,
  contentType?: string,
  extension?: string,
): Promise<{ key: string }> {
  const key = `${folder}/${randomUUID()}${extension ? `.${extension.replace(/^\./, '')}` : ''}`;
  try {
    const upload = new Upload({
      client: s3Client,
      params: { Bucket: S3_BUCKET, Key: key, Body: buffer, ContentType: contentType },
    });
    await upload.done();
    return { key };
  } catch (error) {
    logger.error('[S3] Upload failed:', (error as Error).message);
    throw error;
  }
}

export async function deleteObject(key: string): Promise<void> {
  await s3Client.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key }));
}

/** Downloads an object's full bytes — used by the thumbnail backfill script. */
export async function downloadObjectBuffer(key: string): Promise<Buffer> {
  const result = await s3Client.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
  const chunks: Buffer[] = [];
  for await (const chunk of result.Body as AsyncIterable<Buffer>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Turns a stored S3 key into a time-limited signed GET URL. Pass-through
 * null/undefined for unset fields, and pass through anything that's already
 * a full URL unchanged — some fields (e.g. `User.avatarUrl` for Google
 * sign-ins) store an external URL we don't own, not an S3 key, and signing
 * that would produce a broken link.
 */
export async function getSignedUrl(key: string | null | undefined): Promise<string | null> {
  if (!key) return null;
  if (/^https?:\/\//i.test(key)) return key;
  if (cloudfrontEnabled()) {
    try {
      return signCloudfrontUrl(key);
    } catch (error) {
      // A malformed key/PEM in config must not take every image in the app
      // down with it — fall back to direct S3 presigning.
      logger.error('[S3] CloudFront signing failed, falling back to S3:', (error as Error).message);
    }
  }
  return presign(s3Client, new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }), {
    expiresIn: SIGNED_URL_TTL_SECONDS,
  });
}
