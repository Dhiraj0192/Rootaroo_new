import React from 'react';
import { Linking } from 'react-native';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import * as WebBrowser from 'expo-web-browser';

jest.mock('../../../shared/api/billing', () => ({ billingApi: { getStatus: jest.fn(), changePlan: jest.fn() } }));
jest.mock('../../../shared/billing/purchase', () => ({
  ...jest.requireActual('../../../shared/billing/purchase'),
  openBillingPortal: jest.fn(async () => {}),
  restorePurchases: jest.fn(async () => ({ outcome: 'refreshed' })),
}));
jest.mock('../../../shared/store/authStore', () => ({ useAuthStore: { getState: () => ({}) } }));

const { billingApi } = require('../../../shared/api/billing');
const { openBillingPortal, restorePurchases } = require('../../../shared/billing/purchase');
const { useBillingStore } = require('../../../shared/store/billingStore');
const { statusFixture } = require('../../../shared/billing/__tests__/fixtures');
const SubscriptionScreen = require('../SubscriptionScreen').default;

const active = (o = {}) => statusFixture({
  entitlement: { allowed: true, reason: 'active', seatsAllowed: 6 },
  subscription: { provider: 'stripe', status: 'active', interval: 'month', seats: 6, unitAmount: 1098, currency: 'usd', priceSet: '2026-10', currentPeriodEnd: '2026-11-02T00:00:00.000Z', cancelAtPeriodEnd: false, graceUntil: null, pendingUpdate: false },
  memberCount: 4, ...o,
});

describe('SubscriptionScreen', () => {
  beforeEach(() => jest.clearAllMocks());

  it('shows plan, price paid, renewal and seats', () => {
    useBillingStore.setState({ status: active() });
    const { getByText } = render(<SubscriptionScreen />);
    expect(getByText('6 members · monthly')).toBeTruthy();
    expect(getByText('$10.98 per month')).toBeTruthy();
    expect(getByText(/Renews on/)).toBeTruthy();
    expect(getByText('4 of 6 seats used')).toBeTruthy();
    expect(getByText('Paid with card (Stripe)')).toBeTruthy();
  });

  it('shows "Ends on" when cancelling at period end', () => {
    useBillingStore.setState({ status: active({ subscription: { ...active().subscription, cancelAtPeriodEnd: true } }) });
    expect(render(<SubscriptionScreen />).getByText(/Ends on/)).toBeTruthy();
  });

  it('Manage subscription opens the Stripe portal', () => {
    useBillingStore.setState({ status: active() });
    fireEvent.press(render(<SubscriptionScreen />).getByText('Manage subscription'));
    expect(openBillingPortal).toHaveBeenCalled();
  });

  it('Manage subscription opens the store page for IAP providers and hides Change plan', () => {
    const spy = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    useBillingStore.setState({ status: active({ subscription: { ...active().subscription, provider: 'apple' } }) });
    const { getByText, queryByText } = render(<SubscriptionScreen />);
    fireEvent.press(getByText('Manage subscription'));
    expect(spy).toHaveBeenCalledWith('https://apps.apple.com/account/subscriptions');
    expect(queryByText('Change plan')).toBeNull();
  });

  it('Restore purchases uses the server-chosen purchase method', async () => {
    useBillingStore.setState({ status: active({ purchaseMethod: 'apple_iap' }) });
    fireEvent.press(render(<SubscriptionScreen />).getByText('Restore purchases'));
    await waitFor(() => expect(restorePurchases).toHaveBeenCalledWith({ method: 'apple_iap' }));
  });

  it('shows the store label for a Google Play subscription', () => {
    useBillingStore.setState({ status: active({ subscription: { ...active().subscription, provider: 'google' } }) });
    expect(render(<SubscriptionScreen />).getByText('Paid through Google Play')).toBeTruthy();
  });

  it('changes plan and opens the hosted invoice when payment needs action (T8)', async () => {
    useBillingStore.setState({ status: active(), refresh: jest.fn() });
    billingApi.changePlan.mockResolvedValue({ changed: true, pendingUpdate: true, hostedInvoiceUrl: 'https://invoice.stripe.com/i/x' });
    const { getByText, getByLabelText } = render(<SubscriptionScreen />);
    fireEvent.press(getByText('Change plan'));
    fireEvent.press(getByLabelText('Add a member'));
    fireEvent.press(getByText('Confirm change'));
    await waitFor(() => expect(billingApi.changePlan).toHaveBeenCalledWith({ interval: 'month', seats: 7 }));
    await waitFor(() => expect(WebBrowser.openBrowserAsync).toHaveBeenCalledWith('https://invoice.stripe.com/i/x'));
  });

  it('members see the plan but no actions', () => {
    useBillingStore.setState({ status: active({ isAdmin: false }) });
    const { queryByText } = render(<SubscriptionScreen />);
    expect(queryByText('Manage subscription')).toBeNull();
    expect(queryByText('Change plan')).toBeNull();
  });
});
