import React from 'react';
import { Text } from 'react-native';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';

jest.mock('expo-local-authentication', () => ({
  hasHardwareAsync: jest.fn(async () => true),
  isEnrolledAsync: jest.fn(async () => true),
  authenticateAsync: jest.fn(async () => ({ success: true })),
}));

const LocalAuthentication = require('expo-local-authentication');
const { useJournalLockStore } = require('../../store/journalLockStore');
const JournalLockGate = require('../JournalLockGate').default;
const { withJournalLock } = require('../JournalLockGate');

const Secret = () => <Text>secret entry</Text>;

beforeEach(() => {
  jest.clearAllMocks();
  useJournalLockStore.getState().reset();
});

describe('JournalLockGate', () => {
  it('shows the journal when the lock is off', () => {
    useJournalLockStore.setState({ enabled: false, available: true, locked: false });
    const { getByText } = render(<JournalLockGate><Secret /></JournalLockGate>);
    expect(getByText('secret entry')).toBeTruthy();
  });

  it('loads the setting on first mount and hides content until unlocked', async () => {
    LocalAuthentication.authenticateAsync.mockResolvedValueOnce({ success: false });
    const { queryByText, findByLabelText } = render(<JournalLockGate><Secret /></JournalLockGate>);
    expect(queryByText('secret entry')).toBeNull();
    expect(await findByLabelText('Unlock journal')).toBeTruthy();
    expect(queryByText('secret entry')).toBeNull();
  });

  it('prompts automatically once when shown locked', async () => {
    useJournalLockStore.setState({ enabled: true, available: true, locked: true });
    const { findByText } = render(<JournalLockGate><Secret /></JournalLockGate>);
    expect(await findByText('secret entry')).toBeTruthy();
    expect(LocalAuthentication.authenticateAsync).toHaveBeenCalledTimes(1);
  });

  it("stays locked with a retry message when unlock fails, and the button retries", async () => {
    useJournalLockStore.setState({ enabled: true, available: true, locked: true });
    LocalAuthentication.authenticateAsync.mockResolvedValueOnce({ success: false });
    const { findByText, getByLabelText, queryByText } = render(<JournalLockGate><Secret /></JournalLockGate>);
    expect(await findByText("Couldn't unlock. Try again.")).toBeTruthy();
    expect(queryByText('secret entry')).toBeNull();
    fireEvent.press(getByLabelText('Unlock journal'));
    expect(await findByText('secret entry')).toBeTruthy();
  });

  it('hides content again when the store locks while mounted', async () => {
    useJournalLockStore.setState({ enabled: true, available: true, locked: false });
    LocalAuthentication.authenticateAsync.mockResolvedValue({ success: false });
    const { getByText, queryByText, findByLabelText } = render(<JournalLockGate><Secret /></JournalLockGate>);
    expect(getByText('secret entry')).toBeTruthy();
    act(() => { useJournalLockStore.setState({ locked: true }); });
    expect(await findByLabelText('Unlock journal')).toBeTruthy();
    await waitFor(() => expect(queryByText('secret entry')).toBeNull());
  });

  it('withJournalLock wraps a screen and passes its props through', () => {
    useJournalLockStore.setState({ enabled: false, available: true, locked: false });
    const Screen = ({ route }) => <Text>{route.params.title}</Text>;
    const Wrapped = withJournalLock(Screen);
    const { getByText } = render(<Wrapped route={{ params: { title: 'hello' } }} />);
    expect(getByText('hello')).toBeTruthy();
  });
});
