import { getCatalog, INTERVALS, SEAT_SIZES, SEATS_INCLUDED, SEATS_MAX } from './catalog';
import type { BillingInterval, BillingMode } from './types';

export interface PlansResponse {
  mode: BillingMode;
  priceSet: string;
  currency: string;
  seatsIncluded: number;
  seatsMax: number;
  matrix: Record<BillingInterval, Record<string, { priceId?: string; amount: number }>>;
}

export async function getPlansForMode(mode: BillingMode): Promise<PlansResponse> {
  const catalog = await getCatalog(mode);
  const matrix = { month: {}, year: {} } as PlansResponse['matrix'];
  for (const interval of INTERVALS) {
    for (const seats of SEAT_SIZES) {
      const p = catalog.prices.find((x) => x.interval === interval && x.seats === seats)!;
      matrix[interval][String(seats)] = { priceId: p.priceId, amount: p.amount };
    }
  }
  return { mode, priceSet: catalog.priceSet, currency: catalog.currency, seatsIncluded: SEATS_INCLUDED, seatsMax: SEATS_MAX, matrix };
}

