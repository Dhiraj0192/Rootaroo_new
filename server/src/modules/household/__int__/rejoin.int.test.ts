import request from 'supertest';
import app from '../../../app';
import { setupAssociations, HouseholdMember } from '../../../database/models';
import { resetDb, closeIntResources } from '../../../test/int/db';
import { createHouseholdWithAdmin, addMember, authHeaderFor } from '../../../test/factories';

beforeAll(() => setupAssociations());
beforeEach(() => resetDb());
afterAll(() => closeIntResources());

describe('a removed member joining the same household again', () => {
  it('restores the old membership row as a plain member', async () => {
    const { household, admin } = await createHouseholdWithAdmin({ cohort: 'test' });
    const member = await addMember(household.id);

    const removed = await request(app).delete(`/api/v1/households/${household.id}/members/${member.id}`).set(authHeaderFor(admin));
    expect(removed.status).toBe(200);
    expect(await HouseholdMember.count({ where: { userId: member.id } })).toBe(0);

    const joined = await request(app).post('/api/v1/households/join').set(authHeaderFor(member)).send({ code: household.inviteCode });
    expect([200, 201]).toContain(joined.status);

    const rows = await HouseholdMember.findAll({ where: { householdId: household.id, userId: member.id }, paranoid: false });
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe('member');
    expect(rows[0].deletedAt).toBeNull();
  });
});
