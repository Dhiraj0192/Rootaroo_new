import { matchRule, normalizeCountry, normalizePlatform, isStripeCheckoutAllowed, validateRules, RuleRow } from '../routing';

const PROD: RuleRow[] = [
  { platform: 'ios', country: 'US', method: 'stripe_checkout' },
  { platform: 'android', country: 'US', method: 'stripe_checkout' },
  { platform: 'ios', country: '*', method: 'apple_iap' },
  { platform: 'android', country: '*', method: 'google_play' },
  { platform: 'web', country: '*', method: 'stripe_checkout' },
];

describe('routing resolution (§12)', () => {
  it.each([
    ['ios', 'US', 'stripe_checkout'], ['ios', 'GB', 'apple_iap'], ['android', 'US', 'stripe_checkout'],
    ['android', 'NP', 'google_play'], ['web', 'ZZ', 'stripe_checkout'], ['ios', 'ZZ', 'apple_iap'],
  ] as const)('%s/%s -> %s', (p, c, m) => expect(matchRule(PROD, p, c)).toBe(m));

  it('falls through to none', () => {
    expect(matchRule([{ platform: 'ios', country: 'US', method: 'stripe_checkout' }], 'android', 'US')).toBe('none');
  });

  it('normalizes headers', () => {
    expect(normalizePlatform('IOS')).toBe('ios');
    expect(normalizePlatform('windows')).toBe('web');
    expect(normalizePlatform(undefined)).toBe('web');
    expect(normalizeCountry('us')).toBe('US');
    expect(normalizeCountry('USA')).toBe('ZZ');
    expect(normalizeCountry(undefined)).toBe('ZZ');
  });

  it('allows Stripe checkout for the test cohort and outside production', () => {
    expect(isStripeCheckoutAllowed('apple_iap', 'live', 'production')).toBe(false);
    expect(isStripeCheckoutAllowed('apple_iap', 'test', 'production')).toBe(true);
    expect(isStripeCheckoutAllowed('none', 'live', 'development')).toBe(true);
    expect(isStripeCheckoutAllowed('stripe_checkout', 'live', 'production')).toBe(true);
  });

  it('validates rule sets', () => {
    expect(() => validateRules(PROD)).not.toThrow();
    expect(() => validateRules([...PROD, PROD[0]])).toThrow(/duplicate/);
    expect(() => validateRules([{ platform: 'ios', country: 'usa', method: 'apple_iap' }])).toThrow(/country/);
    expect(() => validateRules([{ platform: 'tv' as any, country: '*', method: 'apple_iap' }])).toThrow(/platform/);
  });
});
