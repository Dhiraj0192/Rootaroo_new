import { setupAssociations, HouseholdMember } from '../../../database/models';
import { resetDb, closeIntResources } from '../../../test/int/db';
import { createHouseholdWithAdmin, addMember, createUser } from '../../../test/factories';
import { createSubscriptionRow } from '../../../test/billing/rows';
import { joinViaCode } from '../../household/service';

beforeAll(() => setupAssociations());
beforeEach(() => resetDb());
afterAll(() => closeIntResources());

describe('seat limits (§7.3)', () => {
  it('concurrent joins at the limit: exactly one succeeds', async () => {
    const { household } = await createHouseholdWithAdmin();
    for (let i = 0; i < 3; i++) await addMember(household.id); // 4 members, 5 allowed
    const [u1, u2] = [await createUser(), await createUser()];
    const results = await Promise.allSettled([
      joinViaCode(u1.id, { code: household.inviteCode }),
      joinViaCode(u2.id, { code: household.inviteCode }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ statusCode: 402, code: 'SEAT_LIMIT' });
    expect(await HouseholdMember.count({ where: { householdId: household.id } })).toBe(5);
  });

  it('uses subscription seats, and the test cohort gets 10', async () => {
    const paid = await createHouseholdWithAdmin();
    await createSubscriptionRow(paid.household.id, { seats: 6 });
    for (let i = 0; i < 4; i++) await addMember(paid.household.id);
    await expect(joinViaCode((await createUser()).id, { code: paid.household.inviteCode })).resolves.toBeTruthy();
    await expect(joinViaCode((await createUser()).id, { code: paid.household.inviteCode })).rejects.toMatchObject({ code: 'SEAT_LIMIT' });

    const t = await createHouseholdWithAdmin({ cohort: 'test' });
    for (let i = 0; i < 8; i++) await addMember(t.household.id);
    await expect(joinViaCode((await createUser()).id, { code: t.household.inviteCode })).resolves.toBeTruthy();
    await expect(joinViaCode((await createUser()).id, { code: t.household.inviteCode })).rejects.toMatchObject({ code: 'SEAT_LIMIT' });
  });
});
