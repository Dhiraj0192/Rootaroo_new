/** Phone-only plumbing for the vault repo: files and the multipart upload. */

import { File, Paths } from 'expo-file-system';
import { vaultApi } from '../api/vault';

export async function readBytes(uri) {
  return new Uint8Array(await new File(uri).arrayBuffer());
}

export async function fetchBytes(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Could not download the file.');
  return new Uint8Array(await res.arrayBuffer());
}

export async function writeTemp(bytes, ext) {
  const file = new File(Paths.cache, `vault_export_${Date.now()}.${ext}`);
  await file.write(bytes);
  return file.uri;
}

export async function deleteTemp(uri) {
  try { new File(uri).delete(); } catch { /* cache is cleared by the OS */ }
}

export async function uploadCiphertext(blob, meta) {
  const file = new File(Paths.cache, `vault_enc_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  try {
    await file.write(blob);
    const form = new FormData();
    form.append('file', { uri: file.uri, name: 'blob', type: 'application/octet-stream' });
    form.append('meta', JSON.stringify(meta));
    return await vaultApi.upload(form);
  } finally {
    try { file.delete(); } catch { /* ignore */ }
  }
}
