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

function isAllowedExternalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !isInternalHost(url.hostname);
  } catch {
    return false;
  }
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
