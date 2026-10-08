jest.mock('../../api/locationShares', () => ({ locationSharesApi: { list: jest.fn(), updateLocation: jest.fn() } }));
jest.mock('../../location/backgroundShare', () => ({
  LOCATION_SHARE_TASK: 'task',
  getActiveShare: jest.fn(),
  startSharing: jest.fn(),
  attachSharing: jest.fn(),
  stopSharing: jest.fn(),
  stopTracking: jest.fn(),
}));
jest.mock('../authStore', () => ({ useAuthStore: { getState: () => ({ user: { id: 'me' } }) } }));

const { useLocationShareStore } = require('../locationShareStore');

const NOW = new Date('2026-10-08T10:00:00Z').getTime();
const MIN = 60_000;

function share(overrides = {}) {
  return {
    id: 's1',
    sharer: { id: 'ravi', displayName: 'Ravi' },
    expiresAt: new Date(NOW + 60 * MIN).toISOString(),
    endedAt: null,
    latitude: 1,
    longitude: 2,
    ...overrides,
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  useLocationShareStore.setState({ mine: null, visible: [], mode: null });
});
afterEach(() => jest.useRealTimers());

describe('locationShareStore.onUpdate', () => {
  it('inserts an unknown live share and updates a known one', () => {
    const { onUpdate } = useLocationShareStore.getState();
    onUpdate(share());
    expect(useLocationShareStore.getState().visible).toHaveLength(1);
    onUpdate(share({ latitude: 9 }));
    expect(useLocationShareStore.getState().visible).toHaveLength(1);
    expect(useLocationShareStore.getState().visible[0].latitude).toBe(9);
  });

  it('ignores a share that has already ended', () => {
    useLocationShareStore.getState().onUpdate(share({ endedAt: new Date(NOW - MIN).toISOString() }));
    expect(useLocationShareStore.getState().visible).toEqual([]);
  });

  it('ignores a share whose time has run out', () => {
    useLocationShareStore.getState().onUpdate(share({ expiresAt: new Date(NOW - 1).toISOString() }));
    expect(useLocationShareStore.getState().visible).toEqual([]);
  });

  it('ignores a late update for a share that just ended, but not forever', () => {
    const { onUpdate, onEnded } = useLocationShareStore.getState();
    onUpdate(share());
    onEnded(share());
    expect(useLocationShareStore.getState().visible).toEqual([]);

    onUpdate(share({ latitude: 5 }));
    expect(useLocationShareStore.getState().visible).toEqual([]);

    jest.setSystemTime(NOW + 6 * MIN);
    onUpdate(share({ latitude: 5 }));
    expect(useLocationShareStore.getState().visible).toHaveLength(1);
  });
});
