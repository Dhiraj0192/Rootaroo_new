import { BillingSubscription, BillingCustomer } from '../../database/models';

let n = 0;

export async function createSubscriptionRow(householdId: string, overrides: Record<string, unknown> = {}): Promise<BillingSubscription> {
  n += 1;
  return BillingSubscription.create({
    householdId, provider: 'stripe', livemode: false, providerSubscriptionId: `sub_row${n}`,
    status: 'active', interval: 'month', seats: 5, priceId: 'price_202610_5_month', priceSet: '2026-10',
    unitAmount: 899, currency: 'usd', currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * 86400_000),
    ...overrides,
  });
}

export async function createCustomerRow(householdId: string, overrides: Record<string, unknown> = {}): Promise<BillingCustomer> {
  n += 1;
  return BillingCustomer.create({
    householdId, provider: 'stripe', livemode: false, providerCustomerId: `cus_row${n}`, billingEmail: 'admin@example.test',
    ...overrides,
  });
}
