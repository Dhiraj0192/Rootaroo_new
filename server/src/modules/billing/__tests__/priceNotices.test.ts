import { noticeDecision, effectiveRenewalDate } from '../priceNotices';

const day = 86400_000;
const NOW = new Date('2026-11-10T00:00:00Z');
const sub = (o: Record<string, unknown> = {}) => ({ status: 'active', currentPeriodEnd: new Date(NOW.getTime() + 10 * day), endedAt: null, ...o }) as any;

describe('noticeDecision (section 6.4)', () => {
  it('waits until apply_after', () => expect(noticeDecision({ applyAfter: new Date(NOW.getTime() + day) }, sub(), NOW)).toBe('wait'));
  it('applies when due and more than 48 h before renewal', () => expect(noticeDecision({ applyAfter: NOW }, sub(), NOW)).toBe('apply'));
  it('rolls over inside the 48 h window', () => {
    expect(noticeDecision({ applyAfter: NOW }, sub({ currentPeriodEnd: new Date(NOW.getTime() + 47 * 3600_000) }), NOW)).toBe('wait');
  });
  it.each(['canceled', 'unpaid', 'incomplete_expired'])('skips %s subscriptions', (status) => {
    expect(noticeDecision({ applyAfter: NOW }, sub({ status }), NOW)).toBe('skip');
  });
  it('skips ended subscriptions', () => expect(noticeDecision({ applyAfter: NOW }, sub({ endedAt: NOW }), NOW)).toBe('skip'));
});

describe('effectiveRenewalDate', () => {
  it('is the current renewal when apply_after is at least 48 h before it, else the next one', () => {
    const end = new Date('2026-12-01T00:00:00Z');
    expect(effectiveRenewalDate(new Date('2026-11-20T00:00:00Z'), end, 'month').toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(effectiveRenewalDate(new Date('2026-11-30T12:00:00Z'), end, 'month').toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(effectiveRenewalDate(new Date('2026-11-30T12:00:00Z'), end, 'year').toISOString()).toBe('2027-12-01T00:00:00.000Z');
  });
});
