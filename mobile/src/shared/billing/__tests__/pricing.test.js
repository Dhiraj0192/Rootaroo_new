import { formatCents, planAmount, autoRenewDisclosure, seatRange } from '../pricing';
import { derivePricing } from '../../../screens/onboarding/featureTourContent';
import * as tour from '../../../screens/onboarding/featureTourContent';
import { PLANS } from './fixtures';

describe('pricing (all 12 amounts come from the server matrix)', () => {
  it.each([[5, 899, 7999], [6, 1098, 10387], [7, 1297, 12775], [8, 1496, 15163], [9, 1695, 17551], [10, 1894, 19939]])(
    '%i members', (n, m, y) => {
      expect(planAmount(PLANS, 'month', n)).toBe(m);
      expect(planAmount(PLANS, 'year', n)).toBe(y);
    });

  it('throws for a size the matrix lacks', () => expect(() => planAmount(PLANS, 'month', 11)).toThrow());

  it('formats and discloses exactly like the server', () => {
    expect(formatCents(12775)).toBe('$127.75');
    expect(autoRenewDisclosure(899, 'month')).toBe('Renews automatically at $8.99 per month until cancelled. Cancel anytime in Manage subscription.');
  });

  it('seat range starts at max(5, members) and flags over-cap households (Review Focus 3)', () => {
    expect(seatRange(PLANS, 3)).toEqual({ min: 5, max: 10, overCap: false });
    expect(seatRange(PLANS, 7)).toEqual({ min: 7, max: 10, overCap: false });
    expect(seatRange(PLANS, 11)).toEqual({ min: 11, max: 10, overCap: true });
  });

  it('the PRICE constant is gone', () => {
    expect(tour.PRICE).toBeUndefined();
  });
});

describe('derivePricing', () => {
  it('5 members monthly', () => {
    expect(derivePricing('month', 5, PLANS)).toMatchObject({
      amountCents: 899, bigWhole: '8', bigCents: '.99', payLabel: 'Subscribe · $8.99/mo', extras: 0,
      extraLine: 'Add more any time for $1.99/mo each', savedAmount: '$291', rootYearly: '$107.88/YR',
    });
  });

  it('7 members yearly', () => {
    expect(derivePricing('year', 7, PLANS)).toMatchObject({
      amountCents: 12775, payLabel: 'Subscribe · $127.75/yr', headSub: '7 people · about $10.65 a month',
      extraLine: '2 extra members · +$3.98/mo', payFine: '7 members · 5 included, 2 × $1.99/mo · cancel any time',
    });
  });
});
