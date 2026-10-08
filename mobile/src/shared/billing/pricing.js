// Every displayed price comes from GET /billing/plans (spec section 6.2); nothing is hard-coded.
export function formatCents(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

export function planAmount(plans, interval, seats) {
  const cell = plans?.matrix?.[interval]?.[String(seats)];
  if (!cell) throw new Error(`No ${interval} price for ${seats} members`);
  return cell.amount;
}

// Must match server/src/modules/billing/copy.ts autoRenewDisclosure exactly.
export function autoRenewDisclosureText(priceText, interval) {
  return `Renews automatically at ${priceText} per ${interval} until cancelled. Cancel anytime in Manage subscription.`;
}

export function autoRenewDisclosure(cents, interval) {
  return autoRenewDisclosureText(formatCents(cents), interval);
}

export function seatRange(plans, memberCount) {
  const min = Math.max(plans.seatsIncluded, memberCount || 0);
  return { min, max: plans.seatsMax, overCap: min > plans.seatsMax };
}
