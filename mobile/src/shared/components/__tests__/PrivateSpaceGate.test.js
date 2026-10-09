import React from 'react';
import { Text } from 'react-native';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

const PrivateSpaceGate = require('../PrivateSpaceGate').default;
const { withPrivateSpace } = require('../PrivateSpaceGate');
const { usePrivateSpaceStore } = require('../../store/privateSpaceStore');

const Secret = () => <Text>secret entry</Text>;
const navigation = () => ({ navigate: jest.fn(), goBack: jest.fn(), canGoBack: () => true });

function withStatus(status, extra = {}) {
  usePrivateSpaceStore.setState({ status, error: null, hasBackup: false, refresh: jest.fn(async () => {}), ...extra });
}

afterEach(() => usePrivateSpaceStore.getState().reset());

describe('PrivateSpaceGate', () => {
  it('shows the screen when this phone holds the key', () => {
    withStatus('here');
    const { getByText } = render(<PrivateSpaceGate navigation={navigation()}><Secret /></PrivateSpaceGate>);
    expect(getByText('secret entry')).toBeTruthy();
  });

  it('offers setup when no private space exists', () => {
    withStatus('none');
    const nav = navigation();
    const { getByText, queryByText } = render(<PrivateSpaceGate navigation={nav}><Secret /></PrivateSpaceGate>);
    expect(queryByText('secret entry')).toBeNull();
    fireEvent.press(getByText('Set up'));
    expect(nav.navigate).toHaveBeenCalledWith('PrivateSpaceSetup');
  });

  it('says the space is on another phone and offers move and restore', () => {
    withStatus('elsewhere', { hasBackup: true });
    const nav = navigation();
    const { getByText } = render(<PrivateSpaceGate navigation={nav}><Secret /></PrivateSpaceGate>);
    expect(getByText('Your private space is on another phone')).toBeTruthy();
    fireEvent.press(getByText('Move it here'));
    expect(nav.navigate).toHaveBeenCalledWith('MoveHere');
    fireEvent.press(getByText('Restore from backup'));
    expect(nav.navigate).toHaveBeenCalledWith('Restore');
  });

  it('hides Restore when there is no backup', () => {
    withStatus('elsewhere', { hasBackup: false });
    const { queryByText } = render(<PrivateSpaceGate navigation={navigation()}><Secret /></PrivateSpaceGate>);
    expect(queryByText('Restore from backup')).toBeNull();
  });

  it('checks with the server on mount, and withPrivateSpace passes props through', async () => {
    withStatus('here');
    const refresh = usePrivateSpaceStore.getState().refresh;
    const Wrapped = withPrivateSpace(({ label }) => <Text>{label}</Text>);
    const { getByText } = render(<Wrapped navigation={navigation()} label="inside" />);
    expect(getByText('inside')).toBeTruthy();
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });
});
