import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

jest.mock('../../../shared/billing/purchase', () => ({ startStripeCheckout: jest.fn() }));
jest.mock('../../../shared/api/billing', () => ({ billingApi: { getStatus: jest.fn(async () => ({})) } }));
const mockCompleteSetup = jest.fn();
jest.mock('../../../shared/store/authStore', () => ({
  useAuthStore: { getState: () => ({ triggerCelebration: jest.fn(), triggerTour: jest.fn(), completeSetup: mockCompleteSetup }) },
}));
jest.mock('../../../shared/store/signupProgress', () => ({ updateSignupProgress: jest.fn(async () => {}) }));
jest.mock('@react-navigation/native', () => ({ ...jest.requireActual('@react-navigation/native'), useIsFocused: () => true }));
jest.mock('../FeatureTourShell', () => {
  const { Text, View, TouchableOpacity } = require('react-native');
  return ({ ctaLabel, onContinue, children }) => (
    <View>{children}<TouchableOpacity onPress={onContinue}><Text>{ctaLabel}</Text></TouchableOpacity></View>
  );
});

const { startStripeCheckout } = require('../../../shared/billing/purchase');
const { useBillingStore } = require('../../../shared/store/billingStore');
const { statusFixture } = require('../../../shared/billing/__tests__/fixtures');
const FeaturePricingScreen = require('../FeaturePricingScreen').default;

describe('FeaturePricingScreen purchase', () => {
  beforeEach(() => { jest.clearAllMocks(); useBillingStore.setState({ status: statusFixture(), refresh: jest.fn() }); });

  it('subscribes with the selected plan and finishes when unlocked', async () => {
    startStripeCheckout.mockResolvedValue({ outcome: 'unlocked' });
    const { getByText } = render(<FeaturePricingScreen navigation={{}} />);
    fireEvent.press(getByText('Subscribe · $79.99/yr'));
    await waitFor(() => expect(startStripeCheckout).toHaveBeenCalledWith({ interval: 'year', seats: 5 }));
    await waitFor(() => expect(mockCompleteSetup).toHaveBeenCalled());
  });

  it('stays on screen while confirming, and "Not now" finishes', async () => {
    startStripeCheckout.mockResolvedValue({ outcome: 'confirming' });
    const { getByText, findByText } = render(<FeaturePricingScreen navigation={{}} />);
    fireEvent.press(getByText('Subscribe · $79.99/yr'));
    expect(await findByText('Confirming your payment…')).toBeTruthy();
    expect(mockCompleteSetup).not.toHaveBeenCalled();
    fireEvent.press(getByText('Not now'));
    await waitFor(() => expect(mockCompleteSetup).toHaveBeenCalled());
  });

  it('shows the auto-renewal disclosure and Terms/Privacy links', () => {
    const { getByText } = render(<FeaturePricingScreen navigation={{}} />);
    expect(getByText('Renews automatically at $79.99 per year until cancelled. Cancel anytime in Manage subscription.')).toBeTruthy();
    expect(getByText('Terms')).toBeTruthy();
    expect(getByText('Privacy')).toBeTruthy();
  });
});
