import { env } from '../../config/env';
import { ForbiddenError } from './errors';

/** Folder an upload goes into: one per uploader, so ownership is checkable from the key alone. */
export function userUploadFolder(area: string, userId: string): string {
  return `${area}/${userId}`;
}

// Hosts a server-side fetch or a link could be aimed at: loopback, private
// ranges, link-local (cloud metadata) and any bare IP address.
function isInternalHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal')) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return true;
  if (h.includes(':')) return true;
  return false;
}

// The only outside photo links we accept: Google account pictures (Apple sign-in carries no photo).
const EXTERNAL_PHOTO_HOST_SUFFIXES = ['.googleusercontent.com'];

function isAllowedExternalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:'
      && !isInternalHost(host)
      && EXTERNAL_PHOTO_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
  } catch {
    return false;
  }
}

/**
 * One of our own storage links (an S3-presigned or CloudFront-signed URL the server
 * handed out) turned back into the storage key inside it. Null for anything else.
 * The app sometimes sends back the link it was shown; storing that would save an
 * expiring URL, so callers store the key instead.
 */
export function storageKeyFromOwnUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase();
  const bucket = env.s3.bucket.toLowerCase();
  let path: string;
  try {
    path = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  } catch {
    return null;
  }
  const cdn = env.cloudfront.domain.toLowerCase();
  if (cdn && host === cdn) return path || null;
  // Virtual-hosted style: <bucket>.s3.<region>.amazonaws.com/<key>
  if (host.startsWith(`${bucket}.s3.`) && host.endsWith('.amazonaws.com')) return path || null;
  // Path style: s3.<region>.amazonaws.com/<bucket>/<key>
  if (/^s3([.-][a-z0-9-]+)?\.amazonaws\.com$/.test(host) && path.startsWith(`${bucket}/`)) {
    return path.slice(bucket.length + 1) || null;
  }
  return null;
}

/**
 * Client-supplied storage keys are later turned into signed download links, so
 * a key must be one this user uploaded themselves — otherwise anyone could ask
 * for a link to another user's object. Throws unless `key` is exactly
 * `<area>/<userId>/<name>` for one of the allowed areas.
 */
export function assertOwnUploadKey(
  key: string,
  userId: string,
  areas: string[],
  opts: { allowExternalUrl?: boolean } = {},
): void {
  if (/^https?:\/\//i.test(key)) {
    if (opts.allowExternalUrl && isAllowedExternalUrl(key)) return;
    throw new ForbiddenError("That file isn't yours");
  }
  for (const area of areas) {
    const prefix = `${userUploadFolder(area, userId)}/`;
    if (!key.startsWith(prefix)) continue;
    const name = key.slice(prefix.length);
    if (name && name !== '..' && name !== '.' && !name.includes('/') && !name.includes('\\')) return;
  }
  throw new ForbiddenError("That file isn't yours");
}
