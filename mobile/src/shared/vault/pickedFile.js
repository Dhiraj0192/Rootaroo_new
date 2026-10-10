/**
 * Reads a picked file into memory straight away and deletes the plain copy.
 * The picker's copy lives in the app cache, which Android may wipe at any time
 * when storage is low, so it must not wait through the name prompt.
 * Some pickers don't report a size; the file is asked, so a huge one is never loaded.
 */
export async function takePickedBytes(asset, maxSize, io) {
  const size = asset.size || io.fileSize(asset.uri);
  if (size > maxSize) return { ...asset, size }; // the caller rejects it; never load it
  const bytes = await io.readBytes(asset.uri);
  await io.deleteTemp(asset.uri);
  return { ...asset, bytes, size: bytes.length };
}
