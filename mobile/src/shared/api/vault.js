import apiClient from './client';

/** Everything here is ciphertext or sealed keys; names and types never leave the phone in the clear. */
export const vaultApi = {
  /** `form` holds `file` (ciphertext) and `meta` (JSON: scope, sealedMeta, sizeBytes, keys). */
  upload: (form) =>
    apiClient.post('/vault', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }).then((r) => r.data.data),

  list: (params) => apiClient.get('/vault', { params }).then((r) => r.data.data),

  get: (id) => apiClient.get(`/vault/${id}`).then((r) => r.data.data),

  members: () => apiClient.get('/vault/members').then((r) => r.data.data),

  pendingGrants: () => apiClient.get('/vault/pending-grants').then((r) => r.data.data),

  grant: (id, grants) => apiClient.post(`/vault/${id}/keys`, { grants }).then((r) => r.data),

  rename: (id, body) => apiClient.patch(`/vault/${id}`, body).then((r) => r.data.data),

  setScope: (id, body) => apiClient.patch(`/vault/${id}/scope`, body).then((r) => r.data.data),

  remove: (id) => apiClient.delete(`/vault/${id}`).then((r) => r.data),
};
