import { setupAssociations, BillingRoutingRule } from '../../../database/models';
import { resetDb, closeIntResources } from '../../../test/int/db';
import { replaceRoutingRules, resolvePurchaseMethod, clearRoutingCache, seedDefaultRoutingRules } from '../routing';

beforeAll(() => setupAssociations());
beforeEach(async () => { await resetDb(); clearRoutingCache(); });
afterAll(() => closeIntResources());

describe('routing rules in MySQL', () => {
  it('replaces the whole rule set and refreshes resolution', async () => {
    await seedDefaultRoutingRules('development');
    expect(await resolvePurchaseMethod({ platform: 'ios', country: 'GB' }, 'live')).toBe('stripe_checkout');
    await replaceRoutingRules([{ platform: 'ios', country: '*', method: 'apple_iap' }], 'staff:test');
    expect(await BillingRoutingRule.count()).toBe(1);
    expect(await resolvePurchaseMethod({ platform: 'ios', country: 'GB' }, 'live')).toBe('apple_iap');
    expect(await resolvePurchaseMethod({ platform: 'ios', country: 'GB' }, 'test')).toBe('stripe_checkout');
  });

  it('rolls back on an invalid set', async () => {
    await seedDefaultRoutingRules('development');
    await expect(replaceRoutingRules([{ platform: 'ios', country: 'XXX', method: 'apple_iap' }], 's')).rejects.toThrow();
    expect(await BillingRoutingRule.count()).toBe(3);
  });
});
