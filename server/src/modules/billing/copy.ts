import type { BillingInterval } from './types';

export function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Shown in the app next to Subscribe and on the Checkout submit button (§7.4, §9). */
export function autoRenewDisclosure(cents: number, interval: BillingInterval): string {
  return `Renews automatically at ${formatUsd(cents)} per ${interval} until cancelled. Cancel anytime in Manage subscription.`;
}
