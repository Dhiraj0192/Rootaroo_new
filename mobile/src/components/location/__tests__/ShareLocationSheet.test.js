import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';

const ShareLocationSheet = require('../ShareLocationSheet').default;
const ActiveShareBanner = require('../ActiveShareBanner').default;

const members = [
  { id: 'u2', displayName: 'Ravi' },
  { id: 'u3', displayName: 'Mina' },
];

describe('ShareLocationSheet', () => {
  it('shares with everyone for the chosen preset', () => {
    const onStart = jest.fn();
    const { getByLabelText } = render(<ShareLocationSheet members={members} onStart={onStart} onCancel={jest.fn()} />);
    fireEvent.press(getByLabelText('Share for 1 hour'));
    fireEvent.press(getByLabelText('Start sharing'));
    expect(onStart).toHaveBeenCalledWith({ durationMinutes: 60, viewerIds: null });
  });

  it('defaults to 15 minutes', () => {
    const onStart = jest.fn();
    const { getByLabelText } = render(<ShareLocationSheet members={members} onStart={onStart} onCancel={jest.fn()} />);
    fireEvent.press(getByLabelText('Start sharing'));
    expect(onStart).toHaveBeenCalledWith({ durationMinutes: 15, viewerIds: null });
  });

  it('can share with chosen members only', () => {
    const onStart = jest.fn();
    const { getByLabelText } = render(<ShareLocationSheet members={members} onStart={onStart} onCancel={jest.fn()} />);
    fireEvent.press(getByLabelText('Choose people'));
    fireEvent.press(getByLabelText('Share with Mina'));
    fireEvent.press(getByLabelText('Share for 8 hours'));
    fireEvent.press(getByLabelText('Start sharing'));
    expect(onStart).toHaveBeenCalledWith({ durationMinutes: 480, viewerIds: ['u3'] });
  });

  it('cannot start with nobody chosen', () => {
    const onStart = jest.fn();
    const { getByLabelText } = render(<ShareLocationSheet members={members} onStart={onStart} onCancel={jest.fn()} />);
    fireEvent.press(getByLabelText('Choose people'));
    expect(getByLabelText('Start sharing').props.accessibilityState).toEqual(expect.objectContaining({ disabled: true }));
    fireEvent.press(getByLabelText('Start sharing'));
    expect(onStart).not.toHaveBeenCalled();
  });

  it('a preselected requester (answering a ping) is the default audience', () => {
    const onStart = jest.fn();
    const { getByLabelText } = render(
      <ShareLocationSheet members={members} initialViewerIds={['u2']} onStart={onStart} onCancel={jest.fn()} />,
    );
    fireEvent.press(getByLabelText('Start sharing'));
    expect(onStart).toHaveBeenCalledWith({ durationMinutes: 15, viewerIds: ['u2'] });
  });
});

describe('ActiveShareBanner', () => {
  const NOW = new Date('2026-10-08T10:00:00Z').getTime();

  it('shows time left and stops on tap', () => {
    const onStop = jest.fn();
    const share = { id: 's1', expiresAt: new Date(NOW + 65 * 60_000).toISOString() };
    const { getByText, getByLabelText } = render(<ActiveShareBanner share={share} now={NOW} mode="background" onStop={onStop} />);
    expect(getByText('Sharing your location · 1 h 5 min left')).toBeTruthy();
    fireEvent.press(getByLabelText('Stop sharing'));
    expect(onStop).toHaveBeenCalled();
  });

  it('warns when sharing only works with the app open', () => {
    const share = { id: 's1', expiresAt: new Date(NOW + 15 * 60_000).toISOString() };
    const { getByText } = render(<ActiveShareBanner share={share} now={NOW} mode="foreground" onStop={jest.fn()} />);
    expect(getByText('Keep Rootaroo open to keep sharing. Allow "Always" location in Settings to share in the background.')).toBeTruthy();
  });
});
