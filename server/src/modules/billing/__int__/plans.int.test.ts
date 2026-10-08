import request from 'supertest';
import app from '../../../app';
import { setupAssociations } from '../../../database/models';
import { resetDb, closeIntResources } from '../../../test/int/db';
import { createHouseholdWithAdmin, createUser, authHeaderFor } from '../../../test/factories';
import { installStripeMock, listOf } from '../../../test/billing/stripeMock';
import { catalogPrices } from '../../../test/billing/fixtures';
import { clearLocalCatalogCache } from '../catalog';

beforeAll(() => setupAssociations());
beforeEach(async () => {
  await resetDb();
  clearLocalCatalogCache();
  const s = installStripeMock('test');
  const all = catalogPrices();
  s.prices.list.mockImplementation((p: any) => listOf(all.filter((x) => p.lookup_keys.includes(x.lookup_key))));
});
afterAll(() => closeIntResources());

describe('GET /api/v1/billing/plans', () => {
  it('returns plans for a household member', async () => {
    const { admin } = await createHouseholdWithAdmin();
    const res = await request(app).get('/api/v1/billing/plans').set(authHeaderFor(admin));
    expect(res.status).toBe(200);
    expect(res.body.data.matrix.year['7'].amount).toBe(12775);
  });

  it('returns 403 NO_HOUSEHOLD for a user without a household', async () => {
    const user = await createUser();
    const res = await request(app).get('/api/v1/billing/plans').set(authHeaderFor(user));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NO_HOUSEHOLD');
  });

  it('requires authentication', async () => {
    expect((await request(app).get('/api/v1/billing/plans')).status).toBe(401);
  });
});
