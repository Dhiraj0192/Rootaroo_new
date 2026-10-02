import request from 'supertest';
import app from '../../../app';
import { setupAssociations } from '../../../database/models';
import { resetDb, closeIntResources } from '../../../test/int/db';
import { createHouseholdWithAdmin, addMember, createUser, authHeaderFor } from '../../../test/factories';
import { createSubscriptionRow } from '../../../test/billing/rows';

beforeAll(() => setupAssociations());
beforeEach(() => resetDb());
afterAll(() => closeIntResources());

const GUARDED: Array<['get' | 'post', string]> = [
  ['get', '/api/v1/feed'], ['get', '/api/v1/tasks'], ['get', '/api/v1/groceries'], ['get', '/api/v1/todos'],
  ['get', '/api/v1/expenses'], ['get', '/api/v1/vault'], ['get', '/api/v1/events'], ['get', '/api/v1/chat/conversations'],
  ['get', '/api/v1/checkins'], ['get', '/api/v1/pings'], ['get', '/api/v1/places'], ['get', '/api/v1/journal'],
  ['get', '/api/v1/dashboard'], ['get', '/api/v1/weather'], ['get', '/api/v1/events/export.ics'],
  ['get', '/api/v1/notifications/history'], ['post', '/api/v1/notifications/history/read-all'],
  ['post', '/api/v1/notifications/history/00000000-0000-4000-8000-000000000000/read'],
];

describe('paywall guards (B7)', () => {
  it.each(GUARDED)('%s %s -> 402 for a blocked household', async (method, path) => {
    const { household } = await createHouseholdWithAdmin();
    const member = await addMember(household.id);
    const res = await request(app)[method](path).set(authHeaderFor(member));
    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({ success: false, code: 'SUBSCRIPTION_REQUIRED', reason: 'subscription_required', isAdmin: false });
  });

  it('reports isAdmin=true for the admin', async () => {
    const { admin } = await createHouseholdWithAdmin();
    const res = await request(app).get('/api/v1/tasks').set(authHeaderFor(admin));
    expect(res.body.isAdmin).toBe(true);
  });

  it.each([
    ['get', '/api/v1/households'], ['get', '/api/v1/notifications/unread-count'],
    ['get', '/api/v1/notifications/preferences'], ['get', '/api/v1/auth/me'],
  ] as Array<['get', string]>)('%s %s stays reachable while blocked', async (method, path) => {
    const { admin } = await createHouseholdWithAdmin();
    const res = await request(app)[method](path).set(authHeaderFor(admin));
    expect(res.status).toBe(200);
  });

  it('guarded routes return 403 NO_HOUSEHOLD without a household', async () => {
    const user = await createUser();
    const res = await request(app).get('/api/v1/tasks').set(authHeaderFor(user));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NO_HOUSEHOLD');
  });

  it('an active subscription or the test cohort unlocks guarded routes', async () => {
    const paid = await createHouseholdWithAdmin();
    await createSubscriptionRow(paid.household.id);
    expect((await request(app).get('/api/v1/tasks').set(authHeaderFor(paid.admin))).status).not.toBe(402);
    const testCohort = await createHouseholdWithAdmin({ cohort: 'test' });
    expect((await request(app).get('/api/v1/groceries').set(authHeaderFor(testCohort.admin))).status).not.toBe(402);
  });

  it('grace keeps access; expired grace blocks', async () => {
    const { household, admin } = await createHouseholdWithAdmin();
    const sub = await createSubscriptionRow(household.id, { status: 'past_due', graceUntil: new Date(Date.now() + 86400_000) });
    expect((await request(app).get('/api/v1/tasks').set(authHeaderFor(admin))).status).not.toBe(402);
    await sub.update({ graceUntil: new Date(Date.now() - 1000) });
    await (await import('../entitlement')).clearEntitlementCache(household.id);
    expect((await request(app).get('/api/v1/tasks').set(authHeaderFor(admin))).status).toBe(402);
  });
});
