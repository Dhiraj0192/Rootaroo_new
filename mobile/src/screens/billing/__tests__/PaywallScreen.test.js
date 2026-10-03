import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

jest.mock('../../../shared/billing/purchase', () => ({
  startStripeCheckout: jest.fn(async () => ({ outcome: 'unlocked' })),
  openBillingPortal: jest.fn(),
  describeCheckoutError: jest.requireActual('../../../shared/billing/purchase').describeCheckoutError,
}));
jest.mock('../../../shared/api/billing', () => ({ billingApi: { getStatus: jest.fn() } }));
jest.mock('../../../shared/store/authStore', () => ({ useAuthStore: { getState: () => ({ logout: jest.fn() }) } }));

const { startStripeCheckout } = require('../../../shared/billing/purchase');
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
    await waitFor(() => expect(startStripeCheckout).toHaveBeenCalledWith({ interval: 'year', seats: 6 }));
  });

  it('explains over-cap households and disables Subscribe (Review Focus 3)', () => {
    setStatus({ memberCount: 11 });
    const { getByText, getByLabelText } = render(<PaywallScreen />);
    expect(getByText(/11 members.*largest plan is 10/)).toBeTruthy();
    expect(getByLabelText('Subscribe').props.accessibilityState.disabled).toBe(true);
  });

  it("shows \"Purchasing isn't available here yet\" for an unsupported method", () => {
    setStatus({ purchaseMethod: 'apple_iap' });
    expect(render(<PaywallScreen />).getByText("Purchasing isn't available here yet")).toBeTruthy();
  });

  it('shows Confirming while a payment is processing', async () => {
    startStripeCheckout.mockResolvedValueOnce({ outcome: 'confirming' });
    setStatus();
    const { getByLabelText, findByText } = render(<PaywallScreen />);
    fireEvent.press(getByLabelText('Subscribe'));
    expect(await findByText('Confirming your payment…')).toBeTruthy();
  });
});
