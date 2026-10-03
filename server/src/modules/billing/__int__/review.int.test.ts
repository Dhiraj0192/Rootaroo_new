import { setupAssociations, BillingReconciliationItem } from '../../../database/models';
import { resetDb, closeIntResources } from '../../../test/int/db';
import { raiseReviewItem, recordAutoFix } from '../review';

beforeAll(() => setupAssociations());
beforeEach(() => resetDb());
afterAll(() => closeIntResources());

describe('review queue', () => {
  it('deduplicates open items by kind + object + mode and keeps the latest "after"', async () => {
    const a = await raiseReviewItem({ livemode: false, kind: 'unmatched_invoice', entityType: 'invoice', providerObjectId: 'in_1', after: { v: 1 } });
    const b = await raiseReviewItem({ livemode: false, kind: 'unmatched_invoice', entityType: 'invoice', providerObjectId: 'in_1', after: { v: 2 } });
    expect(b.id).toBe(a.id);
    expect((await BillingReconciliationItem.findByPk(a.id))!.after).toEqual({ v: 2 });
    await raiseReviewItem({ livemode: true, kind: 'unmatched_invoice', entityType: 'invoice', providerObjectId: 'in_1' });
    expect(await BillingReconciliationItem.count()).toBe(2);
  });

  it('records auto-fixes as separate rows', async () => {
    await recordAutoFix({ livemode: false, kind: 'subscription_drift', entityType: 'subscription', providerObjectId: 'sub_1', before: { seats: 5 }, after: { seats: 6 } });
    expect(await BillingReconciliationItem.count({ where: { resolution: 'auto_fixed' } })).toBe(1);
  });
});
