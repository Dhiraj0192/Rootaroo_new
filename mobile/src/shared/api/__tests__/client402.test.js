jest.mock('../../store/authStore', () => ({ useAuthStore: { getState: () => ({ accessToken: 't', refreshToken: 'r', user: {}, logout: jest.fn(), setAuth: jest.fn() }) } }));

const { default: apiClient, setPaymentRequiredHandler, platformHeaders } = require('../client');

describe('api client billing hooks', () => {
  it('sends platform and store-country headers', async () => {
    const config = await apiClient.interceptors.request.handlers[0].fulfilled({ headers: {} });
    expect(config.headers).toMatchObject(platformHeaders());
    expect(['ios', 'android', 'web']).toContain(config.headers['X-Platform']);
    expect(config.headers['X-Store-Country']).toBe('ZZ');
  });

  it('routes every 402 to the payment-required handler and still rejects', async () => {
    const handler = jest.fn();
    setPaymentRequiredHandler(handler);
    const error = { config: {}, response: { status: 402, data: { code: 'SUBSCRIPTION_REQUIRED' } } };
    await expect(apiClient.interceptors.response.handlers[0].rejected(error)).rejects.toBe(error);
    expect(handler).toHaveBeenCalledWith({ code: 'SUBSCRIPTION_REQUIRED' });
  });
});
