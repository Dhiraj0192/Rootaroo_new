jest.mock('../notify', () => ({ alertStaff: jest.fn(), notifyHouseholdAdmins: jest.fn(), getAdminRecipients: jest.fn(async () => []) }));

import { setupAssociations, BillingEvent, BillingReconciliationRun, BillingReconciliationItem } from '../../../database/models';
import { resetDb, closeIntResources } from '../../../test/int/db';
import { alertOnRun, maybeAlertFailedBurst, alertStuckRuns, __resetAlertThrottleForTests } from '../alerts';
import { alertStaff } from '../notify';

beforeAll(() => setupAssociations());
beforeEach(async () => { await resetDb(); __resetAlertThrottleForTests(); (alertStaff as jest.Mock).mockClear(); });
afterAll(() => closeIntResources());

describe('alerting', () => {
  it('alerts on failed and slow runs, and summarises new review items in one email', async () => {
    const start = new Date(Date.now() - 31 * 60_000);
    const slow = await BillingReconciliationRun.create({ livemode: false, kind: 'daily', startedAt: start, finishedAt: new Date(), status: 'succeeded', counts: {} });
    await BillingReconciliationItem.create({ livemode: false, kind: 'missing_in_stripe', entityType: 'subscription', resolution: 'needs_review', runId: slow.id });
    await BillingReconciliationItem.create({ livemode: false, kind: 'unmatched_invoice', entityType: 'invoice', resolution: 'needs_review' });
    await alertOnRun(slow);
    const subjects = (alertStaff as jest.Mock).mock.calls.map((c) => c[0]);
    expect(subjects).toEqual(expect.arrayContaining([expect.stringMatching(/took/), expect.stringMatching(/2 new review items/)]));
    (alertStaff as jest.Mock).mockClear();
    await alertOnRun(await BillingReconciliationRun.create({ livemode: false, kind: 'daily', startedAt: new Date(), finishedAt: new Date(), status: 'failed', counts: {} }));
    expect((alertStaff as jest.Mock).mock.calls[0][0]).toMatch(/failed/);
  });

  it('alerts once per window on 5+ failed events in 15 minutes', async () => {
    for (let i = 0; i < 5; i++) {
      await BillingEvent.create({ provider: 'stripe', livemode: false, providerEventId: `evt_f${i}`, type: 'invoice.paid', payload: {}, status: 'failed', attempts: 1, receivedAt: new Date() });
    }
    expect(await maybeAlertFailedBurst()).toBe(true);
    expect(await maybeAlertFailedBurst()).toBe(false);
    expect(alertStaff).toHaveBeenCalledTimes(1);
  });

  it('does not alert below the threshold', async () => {
    await BillingEvent.create({ provider: 'stripe', livemode: false, providerEventId: 'evt_one', type: 'x', payload: {}, status: 'failed', receivedAt: new Date() });
    expect(await maybeAlertFailedBurst()).toBe(false);
  });

  it('alerts on runs stuck in running for more than 30 minutes', async () => {
    await BillingReconciliationRun.create({ livemode: false, kind: 'weekly', startedAt: new Date(Date.now() - 40 * 60_000), status: 'running' });
    expect(await alertStuckRuns()).toBe(1);
  });
});
