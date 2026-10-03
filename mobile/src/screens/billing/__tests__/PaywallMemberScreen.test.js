import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';

jest.mock('../../../shared/api/billing', () => ({ billingApi: { getStatus: jest.fn(async () => ({})) } }));
jest.mock('../../../shared/store/authStore', () => ({ useAuthStore: { getState: () => ({ logout: jest.fn() }) } }));

const { useBillingStore } = require('../../../shared/store/billingStore');
const { statusFixture } = require('../../../shared/billing/__tests__/fixtures');
const PaywallMemberScreen = require('../PaywallMemberScreen').default;

describe('PaywallMemberScreen', () => {
  it('asks the admins to renew and retries', () => {
    const refresh = jest.fn();
    useBillingStore.setState({ status: statusFixture({ isAdmin: false, adminNames: ['Asha', 'Ravi'] }), refresh });
    const { getByText } = render(<PaywallMemberScreen />);
    expect(getByText('Ask Asha or Ravi to renew Rootaroo')).toBeTruthy();
    fireEvent.press(getByText('Retry'));
    expect(refresh).toHaveBeenCalled();
  });
});
