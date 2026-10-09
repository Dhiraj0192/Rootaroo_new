/**
 * Picked and captured photos are copied into the app cache in plain form. They
 * are deleted as soon as the encrypted entry is saved or the draft is dropped.
 * Only files inside the cache folder are ever touched: never the user's library.
 */

const normalize = (dir) => (dir.endsWith('/') ? dir : `${dir}/`);

/** True when `uri` is a file inside `dir` (no `..` or encoded `..` tricks, no look-alike folders). */
export function isUnderDir(uri, dir) {
  if (typeof uri !== 'string' || !dir) return false;
  let decoded;
  try {
    decoded = decodeURIComponent(uri);
  } catch {
    return false;
  }
  if (decoded.split('/').includes('..') || uri.split('/').includes('..')) return false;
  return decoded.startsWith(normalize(dir)) && decoded.length > normalize(dir).length;
}

/** Deletes the cache-folder files among `uris`; a file that is already gone is not an error. */
export async function deleteTempFiles(uris, { cacheDir, remove }) {
  for (const uri of uris || []) {
    if (!isUnderDir(uri, cacheDir)) continue;
    try {
      await remove(uri);
    } catch {
      /* already gone */
    }
  }
}
