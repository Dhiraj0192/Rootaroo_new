import React from 'react';
import { Alert } from 'react-native';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

jest.mock('expo-local-authentication', () => ({
  hasHardwareAsync: jest.fn(async () => true),
  isEnrolledAsync: jest.fn(async () => true),
  authenticateAsync: jest.fn(async () => ({ success: true })),
}));
jest.mock('../../shared/api/e2e', () => ({ e2eApi: { getAccountKey: jest.fn(async () => ({ publicKey: null, holdsKey: false, hasBackup: false })), getBackup: jest.fn(async () => null) } }));
jest.mock('../../shared/api/devices', () => ({
  devicesApi: { list: jest.fn(), revoke: jest.fn(async () => {}) },
}));

const { devicesApi } = require('../../shared/api/devices');
const { useJournalLockStore } = require('../../shared/store/journalLockStore');
const SecuritySettingsScreen = require('../SecuritySettingsScreen').default;

const devices = [
  { id: 'd1', name: "Asha's iPhone", platform: 'ios', appVersion: '1.4.0', lastSeenAt: new Date().toISOString(), createdAt: '2026-09-01T00:00:00Z', current: true },
  { id: 'd2', name: 'Old tablet', platform: 'android', appVersion: '1.2.0', lastSeenAt: '2026-09-02T00:00:00Z', createdAt: '2026-08-01T00:00:00Z', current: false },
];

beforeEach(() => {
  jest.clearAllMocks();
  useJournalLockStore.setState({ enabled: true, available: true, locked: false });
  devicesApi.list.mockResolvedValue(devices);
});

describe('SecuritySettingsScreen devices', () => {
  const keyHolder = { id: 'd3', name: 'Old phone', platform: 'ios', appVersion: '1.4.0', lastSeenAt: '2026-09-03T00:00:00Z', createdAt: '2026-08-01T00:00:00Z', current: false, holdsKey: true };
  const pressRemoveOn = async (name) => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const { findByLabelText } = render(<SecuritySettingsScreen navigation={{ goBack: jest.fn(), navigate: jest.fn() }} />);
    fireEvent.press(await findByLabelText(`Remove ${name}`));
    const call = alert.mock.calls[0];
    alert.mockRestore();
    return call;
  };

  it('marks the phone that holds the private space', async () => {
    devicesApi.list.mockResolvedValue([...devices, keyHolder]);
    const { findByText } = render(<SecuritySettingsScreen navigation={{ goBack: jest.fn(), navigate: jest.fn() }} />);
    expect(await findByText('Holds your private space')).toBeTruthy();
  });

  it('warns that removing the key holder without a backup loses the journal and vault for good', async () => {
    devicesApi.list.mockResolvedValue([...devices, keyHolder]);
    const [, message, buttons] = await pressRemoveOn('Old phone');
    expect(message).toContain("can't be recovered");
    expect(buttons.find((b) => b.style === 'destructive').text).toBe('Remove anyway');
  });

  it('with a backup, says the backup is needed to open them again', async () => {
    const { e2eApi } = require('../../shared/api/e2e');
    e2eApi.getAccountKey.mockResolvedValueOnce({ publicKey: 'PUB', holdsKey: true, hasBackup: true });
    devicesApi.list.mockResolvedValue([...devices, keyHolder]);
    const { findByLabelText } = render(<SecuritySettingsScreen navigation={{ goBack: jest.fn(), navigate: jest.fn() }} />);
    await waitFor(() => expect(require('../../shared/store/privateSpaceStore').usePrivateSpaceStore.getState().hasBackup).toBe(true));
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    fireEvent.press(await findByLabelText('Remove Old phone'));
    const [, message, buttons] = alert.mock.calls[0];
    alert.mockRestore();
    expect(message).toContain('backup password or recovery code');
    expect(buttons.find((b) => b.style === 'destructive').text).toBe('Remove');
  });

  it('keeps the plain message for a phone that does not hold the key', async () => {
    const [, message] = await pressRemoveOn('Old tablet');
    expect(message).toBe('It will be signed out and stop getting notifications.');
  });

  it('lists signed-in devices and marks this one', async () => {
    const { findByText, getByText } = render(<SecuritySettingsScreen navigation={{ goBack: jest.fn() }} />);
    expect(await findByText("Asha's iPhone")).toBeTruthy();
    expect(getByText('Old tablet')).toBeTruthy();
    expect(getByText('This device')).toBeTruthy();
  });

  it('offers Remove only for other devices', async () => {
    const { findByLabelText, queryByLabelText } = render(<SecuritySettingsScreen navigation={{ goBack: jest.fn() }} />);
    expect(await findByLabelText('Remove Old tablet')).toBeTruthy();
    expect(queryByLabelText("Remove Asha's iPhone")).toBeNull();
  });

  it('asks before removing, then removes and reloads the list', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => {
      buttons.find((b) => b.style === 'destructive').onPress();
    });
    const { findByLabelText } = render(<SecuritySettingsScreen navigation={{ goBack: jest.fn() }} />);
    fireEvent.press(await findByLabelText('Remove Old tablet'));
    expect(alert).toHaveBeenCalledWith('Remove Old tablet?', expect.stringContaining('signed out'), expect.any(Array));
    await waitFor(() => expect(devicesApi.revoke).toHaveBeenCalledWith('d2'));
    await waitFor(() => expect(devicesApi.list).toHaveBeenCalledTimes(2));
    alert.mockRestore();
  });

  it("shows a message when the list can't load", async () => {
    devicesApi.list.mockRejectedValueOnce(new Error('offline'));
    const { findByText } = render(<SecuritySettingsScreen navigation={{ goBack: jest.fn() }} />);
    expect(await findByText("Couldn't load your devices.")).toBeTruthy();
  });
});
