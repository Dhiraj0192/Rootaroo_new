import request from 'supertest';
import app from '../../../app';
import { setupAssociations, HouseholdMember } from '../../../database/models';
import { resetDb, closeIntResources } from '../db';
import { createHouseholdWithAdmin, addMember, authHeaderFor } from '../../factories';

beforeAll(() => setupAssociations());
beforeEach(() => resetDb());
afterAll(() => closeIntResources());

describe('integration harness', () => {
  it('uses the _test database', () => {
    expect(process.env.DB_NAME).toMatch(/_test$/);
  });

  it('creates a household with members and authenticates', async () => {
    const { household, admin } = await createHouseholdWithAdmin();
    await addMember(household.id);
    expect(await HouseholdMember.count({ where: { householdId: household.id } })).toBe(2);
    const res = await request(app).get('/api/v1/households').set(authHeaderFor(admin));
    expect(res.status).toBe(200);
    expect(res.body.data[0].id).toBe(household.id);
  });
});
