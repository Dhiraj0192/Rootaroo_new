import { autoRenewDisclosure, formatUsd } from '../copy';

describe('copy', () => {
  it('formats cents and the auto-renewal disclosure (§7.4, §9)', () => {
    expect(formatUsd(12775)).toBe('$127.75');
    expect(autoRenewDisclosure(899, 'month')).toBe('Renews automatically at $8.99 per month until cancelled. Cancel anytime in Manage subscription.');
  });
});
