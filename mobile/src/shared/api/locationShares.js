import apiClient from './client';

/**
 * Timed location shares — started from the Ping screen or by accepting a
 * ping, visible to everyone or to chosen household members.
 */
export const locationSharesApi = {
  create: (body) =>
    apiClient
      .post('/location-shares', body)
      .then((r) => r.data.data),

  list: () =>
    apiClient
      .get('/location-shares')
      .then((r) => r.data.data),

  updateLocation: (id, { latitude, longitude, accuracy }) =>
    apiClient
      .post(`/location-shares/${id}/location`, { latitude, longitude, accuracy })
      .then((r) => r.data.data),

  stop: (id) =>
    apiClient
      .post(`/location-shares/${id}/stop`)
      .then((r) => r.data.data),
};
