import apiClient from './client';

export const notificationApi = {
  registerToken: (token, platform) =>
    apiClient.post('/notifications/tokens', { token, platform }),

  // `accessToken` is passed explicitly at logout, when the store's copy is
  // already cleared. `_retry` keeps a 401 here from kicking off a refresh
  // (and with it, another logout).
  unregisterToken: (token, accessToken) =>
    apiClient.delete(`/notifications/tokens/${encodeURIComponent(token)}`, {
      ...(accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : {}),
      _retry: true,
    }),

  getHistory: (params) =>
    apiClient.get('/notifications/history', { params })
      .then((r) => r.data.data),

  markAsRead: (id) =>
    apiClient.post(`/notifications/history/${id}/read`),

  markAllAsRead: () =>
    apiClient.post('/notifications/history/read-all'),

  getUnreadCount: () =>
    apiClient.get('/notifications/unread-count')
      .then((r) => r.data.data.count),

  getPreferences: () =>
    apiClient.get('/notifications/preferences')
      .then((r) => r.data.data),

  updatePreferences: (data) =>
    apiClient.patch('/notifications/preferences', data)
      .then((r) => r.data.data),
};
