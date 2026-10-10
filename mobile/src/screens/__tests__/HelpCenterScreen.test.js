import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';

jest.mock('../../shared/hooks/useTabBarDockHeight', () => ({ useTabBarDockHeight: () => 0 }));

const HelpCenterScreen = require('../HelpCenterScreen').default;

describe('HelpCenterScreen', () => {
  // The answers must match the privacy policy on rootaroo.com, not an older version of the app.
  it('describes background location truthfully and the private-space backup', () => {
    const { getByText, queryByText } = render(<HelpCenterScreen navigation={{ goBack: jest.fn() }} />);
    fireEvent.press(getByText('How does location sharing work?'));
    expect(getByText(/keeps updating in the background, even when the app is closed, and only while that share runs/)).toBeTruthy();
    expect(queryByText(/Nothing is shared automatically or in the background/)).toBeNull();
    fireEvent.press(getByText('What happens to my journal and vault if I lose my phone?'));
    expect(getByText(/backup password or recovery code/)).toBeTruthy();
    expect(queryByText(/passphrase/)).toBeNull();
  });

  it('uses the same contact address as the privacy policy', () => {
    const { getByText } = render(<HelpCenterScreen navigation={{ goBack: jest.fn() }} />);
    expect(getByText('contact@rootaroo.com')).toBeTruthy();
  });
});
