/** Phone-only plumbing for the journal repo: files, image resizing, uploads. */

import { File, Paths } from 'expo-file-system';
import * as ImageManipulator from 'expo-image-manipulator';
import { journalApi } from '../api/journal';
import { deleteTempFiles as deleteTempFilesIn } from './tempFiles';

const THUMBNAIL_WIDTH = 480;

export async function readBytes(uri) {
  return new Uint8Array(await new File(uri).arrayBuffer());
}

export async function resizeThumbnail(uri) {
  const ctx = ImageManipulator.ImageManipulator.manipulate(uri);
  ctx.resize({ width: THUMBNAIL_WIDTH });
  const image = await ctx.renderAsync();
  const result = await image.saveAsync({ format: ImageManipulator.SaveFormat.JPEG, compress: 0.8 });
  try {
    return await readBytes(result.uri);
  } finally {
    try { new File(result.uri).delete(); } catch { /* cache is cleared by the OS */ }
  }
}

export async function fetchBytes(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Could not load the photo.');
  return new Uint8Array(await res.arrayBuffer());
}

/** Ciphertext blobs go up as opaque files; the response lists them in order. */
export async function uploadBlobs(blobs) {
  const files = [];
  try {
    const form = new FormData();
    for (const [i, blob] of blobs.entries()) {
      const file = new File(Paths.cache, `journal_enc_${Date.now()}_${i}_${Math.random().toString(36).slice(2)}`);
      await file.write(blob);
      files.push(file);
      form.append('files', { uri: file.uri, name: `blob-${i}`, type: 'application/octet-stream' });
    }
    return await journalApi.uploadMedia(form);
  } finally {
    for (const file of files) {
      try { file.delete(); } catch { /* ignore */ }
    }
  }
}

/** Removes plain picker/camera copies from the app cache (see tempFiles.js). */
export const deleteTempFiles = (uris) =>
  deleteTempFilesIn(uris, { cacheDir: Paths.cache.uri, remove: async (uri) => { new File(uri).delete(); } });
