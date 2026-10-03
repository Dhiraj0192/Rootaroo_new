import apiClient from './client';

export const billingApi = {
  getStatus: () => apiClient.get('/billing/status').then((r) => r.data.data),
  getPlans: () => apiClient.get('/billing/plans').then((r) => r.data.data),
  createCheckout: ({ interval, seats }) => apiClient.post('/billing/checkout', { interval, seats }).then((r) => r.data.data),
  syncCheckout: (sessionId) => apiClient.post(`/billing/checkout/${encodeURIComponent(sessionId)}/sync`).then((r) => r.data.data),
  openPortal: () => apiClient.post('/billing/portal').then((r) => r.data.data),
  changePlan: ({ interval, seats }) => apiClient.post('/billing/plan', { interval, seats }).then((r) => r.data.data),
};
