import { encodeCursor, decodeCursor, stripeDashboardUrl } from '../admin/service';

describe('admin helpers', () => {
  it('round-trips cursors and rejects garbage', () => {
    const at = new Date('2026-10-05T10:00:00.000Z');
    expect(decodeCursor(encodeCursor(at, 'abc'))).toEqual({ at, id: 'abc' });
    expect(decodeCursor(undefined)).toBeNull();
    expect(() => decodeCursor('!!!')).toThrow();
    expect(() => decodeCursor(Buffer.from('not-a-date|id').toString('base64url'))).toThrow('Invalid cursor');
  });

  it('builds Stripe Dashboard links per object type and mode', () => {
    expect(stripeDashboardUrl('stripe', false, 'payment', 'in_1')).toBe('https://dashboard.stripe.com/test/invoices/in_1');
    expect(stripeDashboardUrl('stripe', true, 'refund', 're_1')).toBe('https://dashboard.stripe.com/refunds/re_1');
    expect(stripeDashboardUrl('stripe', true, 'dispute', 'dp_1')).toBe('https://dashboard.stripe.com/disputes/dp_1');
    expect(stripeDashboardUrl('apple', true, 'payment', 'x')).toBeNull();
  });
});
