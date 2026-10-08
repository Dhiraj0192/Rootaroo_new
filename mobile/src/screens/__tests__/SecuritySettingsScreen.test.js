import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

jest.mock('expo-local-authentication', () => ({
  hasHardwareAsync: jest.fn(async () => true),
  isEnrolledAsync: jest.fn(async () => true),
  authenticateAsync: jest.fn(async () => ({ success: true })),
}));
jest.mock('../../shared/api/devices', () => ({ devicesApi: { list: jest.fn(async () => []), revoke: jest.fn() } }));

const { useJournalLockStore } = require('../../shared/store/journalLockStore');
const SecuritySettingsScreen = require('../SecuritySettingsScreen').default;

beforeEach(() => {
  useJournalLockStore.getState().reset();
});

describe('SecuritySettingsScreen', () => {
  it('turns the journal lock off', async () => {
    const setEnabled = jest.fn(async () => {});
    useJournalLockStore.setState({ enabled: true, available: true, locked: false, setEnabled });
    const { getByLabelText } = render(<SecuritySettingsScreen navigation={{ goBack: jest.fn() }} />);
    const toggle = getByLabelText('Lock journal');
    expect(toggle.props.value).toBe(true);
    fireEvent(toggle, 'valueChange', false);
    await waitFor(() => expect(setEnabled).toHaveBeenCalledWith(false));
  });

  it('disables the toggle and explains why when the device has no screen lock', () => {
    useJournalLockStore.setState({ enabled: false, available: false, locked: false });
    const { getByLabelText, getByText } = render(<SecuritySettingsScreen navigation={{ goBack: jest.fn() }} />);
    expect(getByLabelText('Lock journal').props.disabled).toBe(true);
    expect(getByText('Set a screen lock on this device to use journal lock.')).toBeTruthy();
  });

  it('has a back button', () => {
    useJournalLockStore.setState({ enabled: true, available: true, locked: false });
    const navigation = { goBack: jest.fn() };
    const { getByLabelText } = render(<SecuritySettingsScreen navigation={navigation} />);
    fireEvent.press(getByLabelText('Back'));
    expect(navigation.goBack).toHaveBeenCalled();
  });
});
