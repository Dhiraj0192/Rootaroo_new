jest.mock('../../../database/models', () => ({
  HouseholdMember: { findOne: jest.fn() },
  Household: { findByPk: jest.fn(), findAll: jest.fn() },
  BillingSubscription: { findAll: jest.fn() },
}));
import * as models from '../../../database/models';
import { requireEntitlement } from '../entitlement';

const run = (req: any) => new Promise<unknown>((resolve) => requireEntitlement(req, {} as any, resolve));

beforeEach(() => jest.clearAllMocks());

describe('requireEntitlement', () => {
  const req = () => ({ user: { userId: 'u1' } });

  it('403 NO_HOUSEHOLD without a membership', async () => {
    (models.HouseholdMember.findOne as jest.Mock).mockResolvedValue(null);
    expect(await run(req())).toMatchObject({ statusCode: 403, code: 'NO_HOUSEHOLD' });
  });

  it('402 SUBSCRIPTION_REQUIRED with reason and isAdmin', async () => {
    (models.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId: 'h1', role: 'admin' });
    (models.Household.findByPk as jest.Mock).mockResolvedValue({ id: 'h1', billingCohort: 'live' });
    (models.BillingSubscription.findAll as jest.Mock).mockResolvedValue([]);
    expect(await run(req())).toMatchObject({ statusCode: 402, code: 'SUBSCRIPTION_REQUIRED', details: { reason: 'subscription_required', isAdmin: true } });
  });

  it('calls next() and attaches billing context when allowed', async () => {
    (models.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId: 'h1', role: 'member' });
    (models.Household.findByPk as jest.Mock).mockResolvedValue({ id: 'h1', billingCohort: 'test' });
    (models.BillingSubscription.findAll as jest.Mock).mockResolvedValue([]);
    const r: any = req();
    expect(await run(r)).toBeUndefined();
    expect(r.billing).toMatchObject({ householdId: 'h1', role: 'member', entitlement: { reason: 'test_cohort' } });
  });
});
