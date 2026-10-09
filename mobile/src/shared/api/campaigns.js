import apiClient from './client';

/**
 * Campaign API — server-side switches for pushes sent to the app.
 * Signed-out endpoints need no auth.
 */
export const campaignsApi = {
  signedOutAllowed: () =>
    apiClient
      .get('/campaigns/signed-out')
      .then((r) => r.data.data?.enabled === true),
};
