import apiClient from './client';

const data = (r) => r.data.data;

export const e2eApi = {
  getAccountKey: () => apiClient.get('/account-key').then(data),
  createAccountKey: ({ publicKey }) => apiClient.put('/account-key', { publicKey }).then(data),

  createSession: ({ ephemeralPublicKey }) =>
    apiClient.post('/key-transfer/sessions', { ephemeralPublicKey }).then(data),
  getSession: (id) => apiClient.get(`/key-transfer/sessions/${id}`).then(data),
  sendPayload: (id, { ephemeralPublicKey, sealed }) =>
    apiClient.post(`/key-transfer/sessions/${id}/payload`, { ephemeralPublicKey, sealed }).then(data),
  completeSession: (id) => apiClient.post(`/key-transfer/sessions/${id}/complete`).then(data),

  /** null when there is no backup (the server answers 404). */
  getBackup: () =>
    apiClient.get('/key-backup').then(data).catch((e) => {
      if (e?.response?.status === 404) return null;
      throw e;
    }),
  putBackup: ({ kind, salt, kdf, authKey, blob }) =>
    apiClient.put('/key-backup', { kind, salt, kdf, authKey, blob }).then(data),
  deleteBackup: () => apiClient.delete('/key-backup').then(data),
  startRestore: () => apiClient.post('/key-backup/restore/start').then(data),
  restoreParams: ({ emailCode }) => apiClient.post('/key-backup/restore/params', { emailCode }).then(data),
  restore: ({ restoreToken, authKey }) => apiClient.post('/key-backup/restore', { restoreToken, authKey }).then(data),
};
