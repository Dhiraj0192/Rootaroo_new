import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

jest.mock('../../../shared/billing/purchase', () => ({
  ...jest.requireActual('../../../shared/billing/purchase'),
  startPurchase: jest.fn(async () => ({ outcome: 'unlocked' })),
  restorePurchases: jest.fn(async () => ({ outcome: 'refreshed' })),
  openBillingPortal: jest.fn(),
}));
jest.mock('../../../shared/billing/iap', () => ({ fetchStorePrices: jest.fn(async () => ({})) }));
jest.mock('../../../shared/api/billing', () => ({ billingApi: { getStatus: jest.fn() } }));
jest.mock('../../../shared/store/authStore', () => ({ useAuthStore: { getState: () => ({ logout: jest.fn() }) } }));

const { startPurchase, restorePurchases } = require('../../../shared/billing/purchase');
const { fetchStorePrices } = require('../../../shared/billing/iap');
const { useBillingStore } = require('../../../shared/store/billingStore');
const { statusFixture } = require('../../../shared/billing/__tests__/fixtures');
const PaywallScreen = require('../PaywallScreen').default;

const setStatus = (o) => useBillingStore.setState({ status: statusFixture(o) });

describe('PaywallScreen', () => {
  beforeEach(() => jest.clearAllMocks());

  it('shows the yearly total and the auto-renewal disclosure next to Subscribe', () => {
    setStatus();
    const { getByText } = render(<PaywallScreen />);
    expect(getByText('$79.99')).toBeTruthy();
    expect(getByText('Renews automatically at $79.99 per year until cancelled. Cancel anytime in Manage subscription.')).toBeTruthy();
  });

  it('links Terms and Privacy', () => {
    setStatus();
    const { getByText } = render(<PaywallScreen />);
    expect(getByText('Terms')).toBeTruthy();
    expect(getByText('Privacy')).toBeTruthy();
  });

  it('stepper starts at the member count and cannot go below it', () => {
    setStatus({ memberCount: 7 });
    const { getByLabelText, getByText } = render(<PaywallScreen />);
    expect(getByText('7')).toBeTruthy();
    fireEvent.press(getByLabelText('Remove a member'));
    expect(getByText('7')).toBeTruthy();
    fireEvent.press(getByLabelText('Monthly'));
    expect(getByText('$12.97')).toBeTruthy();
  });

  it('subscribes with the chosen plan', async () => {
    setStatus();
    const { getByLabelText } = render(<PaywallScreen />);
    fireEvent.press(getByLabelText('Add a member'));
    fireEvent.press(getByLabelText('Subscribe'));
    await waitFor(() => expect(startPurchase).toHaveBeenCalledWith({ method: 'stripe_checkout', interval: 'year', seats: 6 }));
  });

  it('explains over-cap households and disables Subscribe (Review Focus 3)', () => {
    setStatus({ memberCount: 11 });
    const { getByText, getByLabelText } = render(<PaywallScreen />);
    expect(getByText(/11 members.*largest plan is 10/)).toBeTruthy();
    expect(getByLabelText('Subscribe').props.accessibilityState.disabled).toBe(true);
  });

  it("shows \"Purchasing isn't available here yet\" for an unsupported method", () => {
    setStatus({ purchaseMethod: 'none' });
    expect(render(<PaywallScreen />).getByText("Purchasing isn't available here yet")).toBeTruthy();
  });

  it.each(['apple_iap', 'google_play'])('%s is purchasable: Subscribe dispatches with the server-chosen method', async (method) => {
    setStatus({ purchaseMethod: method });
    const { getByLabelText, queryByText } = render(<PaywallScreen />);
    expect(queryByText("Purchasing isn't available here yet")).toBeNull();
    fireEvent.press(getByLabelText('Subscribe'));
    await waitFor(() => expect(startPurchase).toHaveBeenCalledWith({ method, interval: 'year', seats: 5 }));
  });

  it('shows the store-localized price and disclosure for IAP instead of the server USD amount', async () => {
    fetchStorePrices.mockResolvedValueOnce({ 'year:5': '€74,99' });
    setStatus({ purchaseMethod: 'apple_iap' });
    const { findByText, queryByText } = render(<PaywallScreen />);
    expect(await findByText('€74,99')).toBeTruthy();
    expect(await findByText('Renews automatically at €74,99 per year until cancelled. Cancel anytime in Manage subscription.')).toBeTruthy();
    expect(queryByText('$79.99')).toBeNull();
  });

  it('does not ask the store for prices on the Stripe path', () => {
    setStatus();
    render(<PaywallScreen />);
    expect(fetchStorePrices).not.toHaveBeenCalled();
  });

  it('explains a pending (Ask to Buy) purchase', async () => {
    startPurchase.mockResolvedValueOnce({ outcome: 'pending' });
    setStatus({ purchaseMethod: 'apple_iap' });
    const { getByLabelText, findByText } = render(<PaywallScreen />);
    fireEvent.press(getByLabelText('Subscribe'));
    expect(await findByText(/pending approval/)).toBeTruthy();
  });

  it('Restore purchases asks the store for IAP and reports when there is nothing to restore', async () => {
    restorePurchases.mockResolvedValueOnce({ outcome: 'nothing_to_restore' });
    setStatus({ purchaseMethod: 'google_play' });
    const { getByLabelText, findByText } = render(<PaywallScreen />);
    fireEvent.press(getByLabelText('Restore purchases'));
    await waitFor(() => expect(restorePurchases).toHaveBeenCalledWith({ method: 'google_play' }));
    expect(await findByText('No purchases to restore for this household.')).toBeTruthy();
  });

  it('shows Confirming while a payment is processing', async () => {
    startPurchase.mockResolvedValueOnce({ outcome: 'confirming' });
    setStatus();
    const { getByLabelText, findByText } = render(<PaywallScreen />);
    fireEvent.press(getByLabelText('Subscribe'));
    expect(await findByText('Confirming your payment…')).toBeTruthy();
  });
});
