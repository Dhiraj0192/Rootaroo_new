const { SHARE_PRESETS, MAX_SHARE_MINUTES, formatRemaining, formatUpdatedAgo } = require('../sharePresets');

const NOW = new Date('2026-10-08T10:00:00Z').getTime();
const at = (ms) => new Date(NOW + ms).toISOString();
const MIN = 60_000;

describe('share presets', () => {
  it('offers 15 minutes, 1 hour and 8 hours, and 8 hours is the maximum', () => {
    expect(SHARE_PRESETS).toEqual([
      { label: '15 min', minutes: 15 },
      { label: '1 hour', minutes: 60 },
      { label: '8 hours', minutes: 480 },
    ]);
    expect(MAX_SHARE_MINUTES).toBe(480);
  });
});

describe('formatRemaining', () => {
  it.each([
    [14 * MIN + 30_000, '15 min left'],
    [60 * MIN, '1 h left'],
    [65 * MIN, '1 h 5 min left'],
    [7 * 60 * MIN + 59 * MIN, '7 h 59 min left'],
    [30_000, '1 min left'],
    [0, 'Ending now'],
    [-MIN, 'Ending now'],
  ])('%i ms → %s', (ms, text) => {
    expect(formatRemaining(at(ms), NOW)).toBe(text);
  });
});

describe('formatUpdatedAgo', () => {
  it.each([
    [-10_000, 'Updated just now'],
    [-59_000, 'Updated just now'],
    [-3 * MIN, 'Updated 3 min ago'],
    [-2 * 60 * MIN, 'Updated 2 h ago'],
  ])('%i ms → %s', (ms, text) => {
    expect(formatUpdatedAgo(at(ms), NOW)).toBe(text);
  });

  it('handles a missing timestamp', () => {
    expect(formatUpdatedAgo(null, NOW)).toBe('Waiting for location');
  });
});
