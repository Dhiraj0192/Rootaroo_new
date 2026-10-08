import { PaymentRequiredError, BillingConflictError, BillingUnavailableError, NoHouseholdError, LockBusyError } from '../errors';

describe('billing errors', () => {
  it('maps to the documented status codes and codes', () => {
    expect(new PaymentRequiredError('SEAT_LIMIT', 'full', { seatsAllowed: 5 })).toMatchObject({ statusCode: 402, code: 'SEAT_LIMIT', details: { seatsAllowed: 5 } });
    expect(new BillingConflictError('ALREADY_SUBSCRIBED', 'dup')).toMatchObject({ statusCode: 409, code: 'ALREADY_SUBSCRIBED' });
    expect(new BillingUnavailableError()).toMatchObject({ statusCode: 503, code: 'BILLING_MODE_UNAVAILABLE' });
    expect(new NoHouseholdError()).toMatchObject({ statusCode: 403, code: 'NO_HOUSEHOLD' });
    expect(new LockBusyError('billing:x')).toMatchObject({ statusCode: 409, code: 'LOCK_BUSY' });
  });
});
