import apiClient from './client';

export const devicesApi = {
  list: () =>
    apiClient.get('/devices').then((r) => r.data.data),

  revoke: (id) =>
    apiClient.delete(`/devices/${id}`),
};
