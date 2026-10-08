import React from 'react';
import { Alert } from 'react-native';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

jest.mock('expo-local-authentication', () => ({
  hasHardwareAsync: jest.fn(async () => true),
  isEnrolledAsync: jest.fn(async () => true),
  authenticateAsync: jest.fn(async () => ({ success: true })),
}));
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
