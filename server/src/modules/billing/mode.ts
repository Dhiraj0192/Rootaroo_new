import { env } from '../../config/env';
import type { BillingCohort, BillingMode } from './types';

/** §4.3. Never used by webhooks or reconciliation, which take the mode from event.livemode. */
export function resolveMode(household: { billingCohort: BillingCohort }, nodeEnv: string = env.nodeEnv): BillingMode {
  if (nodeEnv !== 'production') return 'test';
  return household.billingCohort === 'test' ? 'test' : 'live';
}

export function modeFromLivemode(livemode: boolean): BillingMode {
  return livemode ? 'live' : 'test';
}

export function livemodeOf(mode: BillingMode): boolean {
  return mode === 'live';
}
