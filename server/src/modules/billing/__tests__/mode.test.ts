import { resolveMode, modeFromLivemode, livemodeOf } from '../mode';

describe('resolveMode', () => {
  it.each([
    ['development', 'live', 'test'],
    ['development', 'test', 'test'],
    ['test', 'live', 'test'],
    ['staging', 'live', 'test'],
    ['production', 'live', 'live'],
    ['production', 'test', 'test'],
  ] as const)('NODE_ENV=%s cohort=%s -> %s', (nodeEnv, cohort, expected) => {
    expect(resolveMode({ billingCohort: cohort }, nodeEnv)).toBe(expected);
  });

  it('maps livemode both ways', () => {
    expect(modeFromLivemode(true)).toBe('live');
    expect(modeFromLivemode(false)).toBe('test');
    expect(livemodeOf('live')).toBe(true);
    expect(livemodeOf('test')).toBe(false);
  });
});
