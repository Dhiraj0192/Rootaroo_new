import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => {}) }));
jest.mock('../../shared/services/themedAlert', () => ({ showAlert: jest.fn() }));

const { showAlert } = require('../../shared/services/themedAlert');
const { usePrivateSpaceStore } = require('../../shared/store/privateSpaceStore');
const PrivateSpaceSetupScreen = require('../PrivateSpaceSetupScreen').default;

const setUp = jest.fn();
const navigation = { goBack: jest.fn() };

beforeEach(() => {
  jest.clearAllMocks();
  usePrivateSpaceStore.setState({ setUp, status: 'none' });
});

describe('PrivateSpaceSetupScreen', () => {
  it('states that Rootaroo cannot read the data or reset the password', () => {
    const { getByText } = render(<PrivateSpaceSetupScreen navigation={navigation} />);
    expect(getByText("Rootaroo can't read your journal or vault, and can't reset this password.")).toBeTruthy();
  });

  it('rejects short and mismatched passwords before touching the store', () => {
    const { getByLabelText, getByText } = render(<PrivateSpaceSetupScreen navigation={navigation} />);
    fireEvent.changeText(getByLabelText('Enter backup password'), 'abc');
    fireEvent.press(getByText('Create my private space'));
    expect(getByText('Use at least 6 characters')).toBeTruthy();
    fireEvent.changeText(getByLabelText('Enter backup password'), 'Biscuit');
    fireEvent.changeText(getByLabelText('Confirm password'), 'Biscuits');
    fireEvent.press(getByText('Create my private space'));
    expect(getByText('The two passwords do not match')).toBeTruthy();
    expect(setUp).not.toHaveBeenCalled();
  });

  it('sets up with a matching password', async () => {
    setUp.mockResolvedValue({});
    const { getByLabelText, getByText } = render(<PrivateSpaceSetupScreen navigation={navigation} />);
    fireEvent.changeText(getByLabelText('Enter backup password'), 'Biscuit');
    fireEvent.changeText(getByLabelText('Confirm password'), 'Biscuit');
    fireEvent.press(getByText('Create my private space'));
    await waitFor(() => expect(setUp).toHaveBeenCalledWith({ backup: 'password', secret: 'Biscuit' }));
    expect(navigation.goBack).toHaveBeenCalled();
  });

  it('warns before choosing no backup', () => {
    const { getByLabelText, getByText } = render(<PrivateSpaceSetupScreen navigation={navigation} />);
    fireEvent.press(getByLabelText('No backup'));
    fireEvent.press(getByText('Create my private space'));
    expect(showAlert).toHaveBeenCalledWith('Continue without a backup?', expect.any(String), expect.any(Array));
    expect(setUp).not.toHaveBeenCalled();
  });

  it('shows the recovery code once and needs "I saved it" before Done', async () => {
    setUp.mockResolvedValue({ recoveryCode: 'ABCD-EFGH-JKLM-NPQR-STUV-WXYZ' });
    const { getByLabelText, getByText } = render(<PrivateSpaceSetupScreen navigation={navigation} />);
    fireEvent.press(getByLabelText('Use a recovery code instead'));
    fireEvent.press(getByText('Create my private space'));
    await waitFor(() => expect(getByText('ABCD-EFGH-JKLM-NPQR-STUV-WXYZ')).toBeTruthy());
    fireEvent.press(getByLabelText('Done'));
    expect(navigation.goBack).not.toHaveBeenCalled();
    fireEvent.press(getByLabelText('I saved it'));
    fireEvent.press(getByLabelText('Done'));
    expect(navigation.goBack).toHaveBeenCalled();
  });
});
