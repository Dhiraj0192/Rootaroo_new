// eslint-disable-next-line @typescript-eslint/no-var-requires
const { defaultRoutingRules } = require('../billingSeeds');

describe('defaultRoutingRules (spec 5.7)', () => {
  it('routes every platform to Stripe outside production', () => {
    expect(defaultRoutingRules('development')).toEqual([
      { platform: 'ios', country: '*', method: 'stripe_checkout' },
      { platform: 'android', country: '*', method: 'stripe_checkout' },
      { platform: 'web', country: '*', method: 'stripe_checkout' },
    ]);
  });

  it('uses the launch rules in production', () => {
    expect(defaultRoutingRules('production')).toEqual([
      { platform: 'ios', country: 'US', method: 'stripe_checkout' },
      { platform: 'android', country: 'US', method: 'stripe_checkout' },
      { platform: 'ios', country: '*', method: 'apple_iap' },
      { platform: 'android', country: '*', method: 'google_play' },
      { platform: 'web', country: '*', method: 'stripe_checkout' },
    ]);
  });
});
