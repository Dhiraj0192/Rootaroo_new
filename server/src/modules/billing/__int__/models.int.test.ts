import { UniqueConstraintError } from 'sequelize';
import {
  setupAssociations, Household, BillingEvent, BillingTransaction, BillingSubscription, BillingCustomer,
} from '../../../database/models';
import { resetDb, closeIntResources } from '../../../test/int/db';
import { createHouseholdWithAdmin } from '../../../test/factories';

beforeAll(() => setupAssociations());
beforeEach(() => resetDb());
afterAll(() => closeIntResources());

describe('billing schema', () => {
  it('defaults households to the live cohort', async () => {
    const { household } = await createHouseholdWithAdmin();
    const fresh = await Household.findByPk(household.id);
    expect(fresh!.billingCohort).toBe('live');
  });

  it('enforces unique provider_event_id', async () => {
    const row = { provider: 'stripe', livemode: false, providerEventId: 'evt_1', type: 'x', payload: {}, receivedAt: new Date() } as const;
    await BillingEvent.create({ ...row });
    await expect(BillingEvent.create({ ...row })).rejects.toBeInstanceOf(UniqueConstraintError);
  });

  it('enforces the ledger identity and allows the same object id across types', async () => {
    const base = {
      provider: 'stripe', livemode: false, status: 'paid', amount: 899, currency: 'usd',
      matchStatus: 'unmatched', providerObjectId: 'in_1', occurredAt: new Date(),
    } as const;
    await BillingTransaction.create({ ...base, type: 'payment' });
    await BillingTransaction.create({ ...base, type: 'failed_payment' });
    await expect(BillingTransaction.create({ ...base, type: 'payment' })).rejects.toBeInstanceOf(UniqueConstraintError);
  });

  it('enforces one customer per household, provider and mode', async () => {
    const { household } = await createHouseholdWithAdmin();
    await BillingCustomer.create({ householdId: household.id, provider: 'stripe', livemode: false, providerCustomerId: 'cus_1' });
    await BillingCustomer.create({ householdId: household.id, provider: 'stripe', livemode: true, providerCustomerId: 'cus_2' });
    await expect(BillingCustomer.create({ householdId: household.id, provider: 'stripe', livemode: false, providerCustomerId: 'cus_3' }))
      .rejects.toBeInstanceOf(UniqueConstraintError);
  });

  it('stores subscriptions with JSON and nullable fields', async () => {
    const { household, admin } = await createHouseholdWithAdmin();
    const sub = await BillingSubscription.create({
      householdId: household.id, provider: 'stripe', livemode: false, providerSubscriptionId: 'sub_1',
      status: 'active', interval: 'month', seats: 5, pendingUpdate: { expires_at: 1 }, purchasedByUserId: admin.id,
    });
    const fresh = await BillingSubscription.findByPk(sub.id);
    expect(fresh!.pendingUpdate).toEqual({ expires_at: 1 });
    expect(fresh!.cancelAtPeriodEnd).toBe(false);
  });
});
