'use strict';
// Shared by the routing-rules migration and tests. Lives outside migrations/
// because sequelize-cli executes every file in that folder.
function defaultRoutingRules(nodeEnv) {
  if (nodeEnv === 'production') {
    return [
      { platform: 'ios', country: 'US', method: 'stripe_checkout' },
      { platform: 'android', country: 'US', method: 'stripe_checkout' },
      { platform: 'ios', country: '*', method: 'apple_iap' },
      { platform: 'android', country: '*', method: 'google_play' },
      { platform: 'web', country: '*', method: 'stripe_checkout' },
    ];
  }
  return [
    { platform: 'ios', country: '*', method: 'stripe_checkout' },
    { platform: 'android', country: '*', method: 'stripe_checkout' },
    { platform: 'web', country: '*', method: 'stripe_checkout' },
  ];
}

module.exports = { defaultRoutingRules };
