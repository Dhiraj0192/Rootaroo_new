import apiClient from './client';

/**
 * Ping API — request a household member's current location, and
 * accept/decline requests sent to you.
 */
export const pingApi = {
  create: (targetUserId, note) =>
    apiClient
      .post('/pings', { targetUserId, note })
      .then((r) => r.data.data),

  respond: (id, body) =>
    apiClient
      .post(`/pings/${id}/respond`, body)
      .then((r) => r.data.data),

  list: (params) =>
    apiClient
      .get('/pings', { params })
      .then((r) => r.data.data),
};
