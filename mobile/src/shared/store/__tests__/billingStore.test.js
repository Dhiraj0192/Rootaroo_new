import AsyncStorage from '@react-native-async-storage/async-storage';

jest.mock('../../api/billing', () => ({ billingApi: { getStatus: jest.fn() } }));
jest.mock('../../api/client', () => ({ setPaymentRequiredHandler: jest.fn() }));

const { billingApi } = require('../../api/billing');
const { setPaymentRequiredHandler } = require('../../api/client');
const { useBillingStore, selectGate, BILLING_STORAGE_KEY } = require('../billingStore');
const { statusFixture } = require('../../billing/__tests__/fixtures');

// Captured at import time: clearAllMocks below would erase the registration call.
const registrations = [...setPaymentRequiredHandler.mock.calls];

beforeEach(async () => {
  jest.clearAllMocks();
  useBillingStore.getState().reset();
  await AsyncStorage.clear();
});

describe('billingStore', () => {
  it('registers itself as the 402 handler', () => {
    expect(registrations).toEqual([[expect.any(Function)]]);
  });

  it('refresh is single-flight: a burst of calls makes one request', async () => {
    let resolve;
    billingApi.getStatus.mockReturnValue(new Promise((r) => { resolve = r; }));
    const calls = [useBillingStore.getState().refresh(), useBillingStore.getState().refresh(), useBillingStore.getState().refresh()];
    resolve(statusFixture());
    await Promise.all(calls);
    expect(billingApi.getStatus).toHaveBeenCalledTimes(1);
    expect(selectGate(useBillingStore.getState())).toBe('blocked');
  });

  it('network errors keep the last-known status (gate unchanged)', async () => {
    billingApi.getStatus.mockResolvedValueOnce(statusFixture({ entitlement: { allowed: true, reason: 'active' } }));
    await useBillingStore.getState().refresh();
    billingApi.getStatus.mockRejectedValueOnce(new Error('Network Error'));
    await useBillingStore.getState().refresh();
    expect(selectGate(useBillingStore.getState())).toBe('allowed');
    expect(useBillingStore.getState().error).toBe('Network Error');
  });

  it('NO_HOUSEHOLD clears the gate instead of blocking', async () => {
    billingApi.getStatus.mockRejectedValueOnce({ response: { status: 403, data: { code: 'NO_HOUSEHOLD' } } });
    await useBillingStore.getState().refresh();
    expect(useBillingStore.getState()).toMatchObject({ status: null, noHousehold: true });
    expect(selectGate(useBillingStore.getState())).toBe('unknown');
  });

  it('persists per user and hydrates only for the same user', async () => {
    await useBillingStore.getState().hydrate('u1');
    billingApi.getStatus.mockResolvedValueOnce(statusFixture());
    await useBillingStore.getState().refresh();
    expect(JSON.parse(await AsyncStorage.getItem(BILLING_STORAGE_KEY)).userId).toBe('u1');
    useBillingStore.setState({ status: null });
    await useBillingStore.getState().hydrate('u2');
    expect(useBillingStore.getState().status).toBeNull();
    await useBillingStore.getState().hydrate('u1');
    expect(useBillingStore.getState().status).not.toBeNull();
  });

  it('maps grace and allowed', () => {
    expect(selectGate({ status: statusFixture({ entitlement: { allowed: true, reason: 'grace' } }) })).toBe('grace');
    expect(selectGate({ status: statusFixture({ entitlement: { allowed: true, reason: 'test_cohort' } }) })).toBe('allowed');
    expect(selectGate({ status: null })).toBe('unknown');
  });

  it('applySync updates entitlement and pending checkout', async () => {
    billingApi.getStatus.mockResolvedValueOnce(statusFixture());
    await useBillingStore.getState().refresh();
    useBillingStore.getState().applySync({ entitlement: { allowed: true, reason: 'active' }, pendingCheckout: { sessionId: 'cs', state: 'complete' } });
    expect(useBillingStore.getState().status).toMatchObject({ entitlement: { allowed: true }, pendingCheckout: null });
  });

  it('discards a response that lands after sign-out (reset)', async () => {
    let resolve;
    billingApi.getStatus.mockReturnValue(new Promise((r) => { resolve = r; }));
    const call = useBillingStore.getState().refresh();
    useBillingStore.getState().reset();
    resolve(statusFixture());
    await call;
    expect(useBillingStore.getState().status).toBeNull();
  });
});
