jest.mock('../../notify', () => {
  const actual = jest.requireActual('../../notify');
  return { ...actual, notifyHouseholdAdmins: jest.fn(), alertStaff: jest.fn() };
});

import { setupAssociations, BillingSubscription, BillingReconciliationItem } from '../../../../database/models';
import { resetDb, closeIntResources } from '../../../../test/int/db';
import { createHouseholdWithAdmin } from '../../../../test/factories';
import { createSubscriptionRow } from '../../../../test/billing/rows';
import { installStripeMock, listOf } from '../../../../test/billing/stripeMock';
import { appleRenewal, appleTransaction, buildTestChain, signJws, TestChain, TEST_APP_APPLE_ID, TEST_BUNDLE } from '../../../../test/billing/appleFixtures';
import { GoogleNotFoundError, __setPlayHttpForTests } from '../google';
import { __setAppleApiClientForTests, __setAppleRootsForTests } from '../apple';
import { __setIapConfigForTests } from '../config';
import { runReconciliation } from '../../reconcile';
import { playSubscription, TEST_AUDIENCE, TEST_PACKAGE, TEST_PUSH_SA } from '../../../../test/billing/googleFixtures';
import { getEntitlement } from '../../entitlement';

let chain: TestChain;
const cfg = (apple: boolean, google: boolean) => ({
  apple: apple ? { keyId: 'K', issuerId: 'I', privateKey: 'p', bundleId: TEST_BUNDLE, appAppleId: TEST_APP_APPLE_ID } : null,
  google: google ? { serviceAccountJson: '{}', packageName: TEST_PACKAGE, rtdnAudience: TEST_AUDIENCE, rtdnServiceAccountEmail: TEST_PUSH_SA } : null,
  appleOnlineChecks: false, warnings: [],
}) as never;

beforeAll(() => setupAssociations());
beforeEach(async () => {
  await resetDb();
  const s = installStripeMock('test');
  s.subscriptions.list.mockReturnValue(listOf([]));
  s.invoices.list.mockReturnValue(listOf([]));
  s.refunds.list.mockReturnValue(listOf([]));
  s.disputes.list.mockReturnValue(listOf([]));
  chain = buildTestChain('Test');
  __setAppleRootsForTests([chain.rootDer]);
  __setAppleApiClientForTests(null);
  __setPlayHttpForTests(null);
  __setIapConfigForTests(cfg(true, true));
});
afterAll(async () => {
  __setAppleApiClientForTests(null); __setPlayHttpForTests(null); __setAppleRootsForTests(null); __setIapConfigForTests(null);
  await closeIntResources();
});

const appleStatus = (otid: string, status: number, tx: Record<string, unknown>, renewal: Record<string, unknown> = {}) => ({
  data: [{ lastTransactions: [{
    originalTransactionId: otid, status,
    signedTransactionInfo: signJws(appleTransaction({ originalTransactionId: otid, ...tx }), chain),
    signedRenewalInfo: signJws(appleRenewal({ originalTransactionId: otid, ...renewal }), chain),
  }] }],
});

describe('runReconciliation with store subscriptions (Task 11.4)', () => {
  it('refetches Apple subscriptions, fixes drift and records it', async () => {
    const { household } = await createHouseholdWithAdmin();
    const stale = await createSubscriptionRow(household.id, { provider: 'apple', providerSubscriptionId: 'A-1', status: 'active', seats: 5, priceId: 'rootaroo.hh5.month' });
    const getAll = jest.fn(async (id: string) => {
      return appleStatus(id, 2, { productId: 'rootaroo.hh5.month', expiresDate: Date.now() - 86400_000, appAccountToken: household.id });
    });
    __setAppleApiClientForTests(() => ({ getAllSubscriptionStatuses: getAll }) as never);

    const run = await runReconciliation('test', 'daily');
    expect(run.status).toBe('succeeded');
    expect(await stale.reload()).toMatchObject({ status: 'canceled' });
    expect(await BillingReconciliationItem.count({ where: { kind: 'subscription_drift', providerObjectId: 'A-1', resolution: 'auto_fixed' } })).toBe(1);
    expect(run.counts).toMatchObject({ storeChecked: expect.any(Number), storeFixed: expect.any(Number) });
    expect((await getEntitlement(household.id, { bypassCache: true })).allowed).toBe(false);
    expect(getAll).toHaveBeenCalledWith('A-1');
  });

  it('marks an Apple subscription that 404s as missing_in_store and revokes local access', async () => {
    const { household } = await createHouseholdWithAdmin();
    const gone = await createSubscriptionRow(household.id, { provider: 'apple', providerSubscriptionId: 'A-GONE', status: 'active' });
    const { APIException } = await import('@apple/app-store-server-library');
    __setAppleApiClientForTests(() => ({ getAllSubscriptionStatuses: jest.fn(async () => { throw new APIException(404, 4040010, 'not found'); }) }) as never);
    const run = await runReconciliation('test', 'daily');
    expect(await gone.reload()).toMatchObject({ status: 'canceled' });
    expect(await BillingReconciliationItem.count({ where: { kind: 'missing_in_store', providerObjectId: 'A-GONE', resolution: 'needs_review' } })).toBe(1);
    expect((run.counts as { storeMissing: number }).storeMissing).toBe(1);
  });

  it('refetches Google subscriptions, repairs drift, acknowledges what was missed, and survives one failing token', async () => {
    const { household } = await createHouseholdWithAdmin();
    const drift = await createSubscriptionRow(household.id, { provider: 'google', providerSubscriptionId: 'G-1', status: 'past_due', graceUntil: new Date(Date.now() + 86400_000) });
    const other = await createHouseholdWithAdmin();
    const broken = await createSubscriptionRow(other.household.id, { provider: 'google', providerSubscriptionId: 'G-BROKEN', status: 'active' });
    const acks: string[] = [];
    __setPlayHttpForTests(async (req) => {
      if (req.method === 'POST') { acks.push(req.url); return { status: 200, data: {} }; }
      if (req.url.includes('G-BROKEN')) throw new Error('500 from Play');
      return { status: 200, data: playSubscription({ householdId: household.id, test: true, ack: false }) };
    });
    const run = await runReconciliation('test', 'daily');
    expect(run.status).toBe('succeeded');
    expect(await drift.reload()).toMatchObject({ status: 'active', graceUntil: null });
    expect(acks).toHaveLength(1);
    expect((run.counts as { storeErrors: number }).storeErrors).toBe(1);
    expect((await broken.reload()).status).toBe('active'); // an outage never revokes access
  });

  it('a Google token the Play API reports gone is canceled with a review item', async () => {
    const { household } = await createHouseholdWithAdmin();
    const row = await createSubscriptionRow(household.id, { provider: 'google', providerSubscriptionId: 'G-GONE', status: 'active' });
    __setPlayHttpForTests(async () => { throw new GoogleNotFoundError('410'); });
    await runReconciliation('test', 'daily');
    expect(await row.reload()).toMatchObject({ status: 'canceled' });
    expect(await BillingReconciliationItem.count({ where: { kind: 'missing_in_store' } })).toBe(1);
  });

  it('skips stores that are not configured and leaves Stripe-only reconciliation unchanged', async () => {
    __setIapConfigForTests(cfg(false, false));
    const { household } = await createHouseholdWithAdmin();
    const row = await createSubscriptionRow(household.id, { provider: 'apple', providerSubscriptionId: 'A-2', status: 'active' });
    const run = await runReconciliation('test', 'daily');
    expect(run.status).toBe('succeeded');
    expect((await row.reload()).status).toBe('active');
    expect((run.counts as { storeChecked: number }).storeChecked).toBe(0);
    expect(await BillingSubscription.count()).toBe(1);
  });
});
