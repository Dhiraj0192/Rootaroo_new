import { AppError } from '../../shared/utils/errors';

export type BillingConflictCode =
  | 'ALREADY_SUBSCRIBED'
  | 'PAYMENT_ISSUE'
  | 'SEATS_BELOW_MEMBERS'
  | 'PURCHASE_METHOD_MISMATCH'
  | 'NO_ACTIVE_SUBSCRIPTION'
  | 'PLAN_CHANGE_PENDING'
  | 'COHORT_CHANGE_BLOCKED'
  | 'PURCHASE_HOUSEHOLD_MISMATCH';

export class PaymentRequiredError extends AppError {
  constructor(code: 'SUBSCRIPTION_REQUIRED' | 'SEAT_LIMIT', message: string, details: Record<string, unknown> = {}) {
    super(402, message, code, details);
  }
}

export class BillingConflictError extends AppError {
  constructor(code: BillingConflictCode, message: string, details: Record<string, unknown> = {}) {
    super(409, message, code, details);
  }
}

export class BillingUnavailableError extends AppError {
  constructor(message = 'Purchasing is not available right now') {
    super(503, message, 'BILLING_MODE_UNAVAILABLE');
  }
}

export class NoHouseholdError extends AppError {
  constructor() {
    super(403, 'You must belong to a household to do this', 'NO_HOUSEHOLD');
  }
}

export class LockBusyError extends AppError {
  constructor(public lockName: string) {
    super(409, 'Another billing operation is in progress. Try again in a moment.', 'LOCK_BUSY');
  }
}
