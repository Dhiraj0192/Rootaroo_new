import { setupAssociations, Household } from '../../../database/models';
import { resetDb, closeIntResources } from '../../../test/int/db';
import { createHouseholdWithAdmin } from '../../../test/factories';
import { createSubscriptionRow } from '../../../test/billing/rows';
import { getEntitlement, isEntitledBatch, clearEntitlementCache } from '../entitlement';

beforeAll(() => setupAssociations());
beforeEach(() => resetDb());
afterAll(() => closeIntResources());

describe('getEntitlement against MySQL', () => {
  it('counts only rows whose livemode matches the resolved mode (B3)', async () => {
    const { household } = await createHouseholdWithAdmin();
    // NODE_ENV=test resolves to 'test' mode: a live row must not unlock it.
    await createSubscriptionRow(household.id, { livemode: true, status: 'active' });
    expect((await getEntitlement(household.id, { bypassCache: true })).allowed).toBe(false);
    await createSubscriptionRow(household.id, { livemode: false, status: 'active', seats: 8 });
    expect(await getEntitlement(household.id, { bypassCache: true })).toMatchObject({ allowed: true, seatsAllowed: 8, mode: 'test' });
  });

  it('honours the test cohort', async () => {
    const { household } = await createHouseholdWithAdmin({ cohort: 'test' });
    expect(await getEntitlement(household.id)).toMatchObject({ allowed: true, reason: 'test_cohort' });
  });

  it('finds soft-deleted households (paranoid: false)', async () => {
    const { household } = await createHouseholdWithAdmin();
    await createSubscriptionRow(household.id);
    await Household.destroy({ where: { id: household.id } });
    expect((await getEntitlement(household.id, { bypassCache: true })).allowed).toBe(true);
  });

  it('isEntitledBatch returns only allowed households', async () => {
    const a = (await createHouseholdWithAdmin()).household;
    const b = (await createHouseholdWithAdmin()).household;
    const c = (await createHouseholdWithAdmin({ cohort: 'test' })).household;
    await createSubscriptionRow(a.id);
    await createSubscriptionRow(b.id, { status: 'canceled' });
    const set = await isEntitledBatch([a.id, b.id, c.id, a.id]);
    expect([...set].sort()).toEqual([a.id, c.id].sort());
    await clearEntitlementCache(a.id);
  });
});
