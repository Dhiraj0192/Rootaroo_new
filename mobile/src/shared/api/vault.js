import apiClient from './client';

export const vaultApi = {
  uploadDocument: (data, file) => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('name', data.name);
    formData.append('mimeType', data.mimeType);
    formData.append('sizeBytes', data.sizeBytes.toString());
    formData.append('encryptedKey', data.encryptedKey);
    formData.append('iv', data.iv);

    return apiClient.post('/vault', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }).then((r) => r.data.data);
  },

  listDocuments: (params) =>
    apiClient
      .get('/vault', { params })
      .then((r) => r.data.data),

  getDocument: (id) =>
    apiClient
      .get(`/vault/${id}`)
      .then((r) => r.data.data),

  getDocumentKey: (id) =>
    apiClient
      .get(`/vault/${id}/key`)
      .then((r) => r.data.data),

  updateDocument: (id, data) =>
    apiClient
      .patch(`/vault/${id}`, data)
      .then((r) => r.data.data),

  deleteDocument: (id) =>
    apiClient.delete(`/vault/${id}`).then((r) => r.data),

  hardDeleteDocument: (id) =>
    apiClient.delete(`/vault/${id}/hard`).then((r) => r.data),

  getSummary: () =>
    apiClient
      .get('/vault/summary')
      .then((r) => r.data.data),
};
