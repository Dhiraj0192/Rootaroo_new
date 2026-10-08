import Stripe from 'stripe';
import redis from '../../config/redis';
import logger from '../../shared/utils/logger';
import { AppError, ValidationError } from '../../shared/utils/errors';
import { getStripe } from './config';
import { CATALOG_BUST_CHANNEL, publishMessage } from './cache';
import type { BillingInterval, BillingMode } from './types';

export const SEATS_INCLUDED = 5;
export const SEATS_MAX = 10;
export const SEAT_SIZES: readonly number[] = [5, 6, 7, 8, 9, 10];
export const INTERVALS: readonly BillingInterval[] = ['month', 'year'];

export interface PriceFormula { monthBase: number; monthExtra: number; yearBase: number; yearExtra: number }
export const LAUNCH_FORMULA: PriceFormula = { monthBase: 899, monthExtra: 199, yearBase: 7999, yearExtra: 2388 };
export const LAUNCH_PRICE_SET = '2026-10';

const TTL_MS = 10 * 60_000;

export interface CatalogPrice {
  priceId: string;
  amount: number;
  currency: string;
  priceSet: string;
  seats: number;
  interval: BillingInterval;
  active: boolean;
  lookupKey: string | null;
}

export interface Catalog { mode: BillingMode; priceSet: string; currency: string; prices: CatalogPrice[]; loadedAt: number }

export function assertSeats(seats: number): void {
  if (!Number.isInteger(seats) || seats < SEATS_INCLUDED || seats > SEATS_MAX) {
    throw new ValidationError(`seats must be an integer from ${SEATS_INCLUDED} to ${SEATS_MAX}`);
  }
}

export function amountFor(f: PriceFormula, interval: BillingInterval, seats: number): number {
  assertSeats(seats);
  const extra = seats - SEATS_INCLUDED;
  return interval === 'month' ? f.monthBase + f.monthExtra * extra : f.yearBase + f.yearExtra * extra;
}

export function lookupKey(interval: BillingInterval, seats: number): string {
  return `rootaroo_hh${seats}_${interval}`;
}

export function toCatalogPrice(p: Stripe.Price): CatalogPrice | null {
  const seats = Number(p.metadata?.seats);
  const interval = p.recurring?.interval;
  const priceSet = p.metadata?.price_set;
  if (!Number.isInteger(seats) || seats < SEATS_INCLUDED || seats > SEATS_MAX) return null;
  if (interval !== 'month' && interval !== 'year') return null;
  if (!priceSet || typeof p.unit_amount !== 'number') return null;
  return {
    priceId: p.id, amount: p.unit_amount, currency: p.currency, priceSet, seats, interval: interval as BillingInterval,
    active: p.active, lookupKey: p.lookup_key ?? null,
  };
}

const catalogCache = new Map<BillingMode, { value: Catalog; expires: number }>();
const allPricesCache = new Map<BillingMode, { value: CatalogPrice[]; expires: number }>();

export function clearLocalCatalogCache(mode?: BillingMode): void {
  if (mode) { catalogCache.delete(mode); allPricesCache.delete(mode); return; }
  catalogCache.clear();
  allPricesCache.clear();
}

export async function getCatalog(mode: BillingMode, now: number = Date.now()): Promise<Catalog> {
  const hit = catalogCache.get(mode);
  if (hit && hit.expires > now) return hit.value;
  const stripe = getStripe(mode);
  // Verify at implementation time: lookup_keys accepts at most 10 values
  // (https://docs.stripe.com/api/prices/list.md), hence one call per interval.
  const pages = await Promise.all(INTERVALS.map((interval) =>
    stripe.prices.list({ lookup_keys: SEAT_SIZES.map((s) => lookupKey(interval, s)), active: true, limit: 10 })));
  const prices = pages.flatMap((pg) => pg.data).map(toCatalogPrice).filter((p): p is CatalogPrice => p !== null);
  for (const interval of INTERVALS) {
    for (const seats of SEAT_SIZES) {
      if (!prices.some((p) => p.interval === interval && p.seats === seats)) {
        throw new AppError(503, `Price catalog is incomplete (${lookupKey(interval, seats)} missing)`, 'CATALOG_UNAVAILABLE');
      }
    }
  }
  const base = prices.find((p) => p.interval === 'month' && p.seats === SEATS_INCLUDED)!;
  const value: Catalog = { mode, priceSet: base.priceSet, currency: base.currency, prices, loadedAt: now };
  catalogCache.set(mode, { value, expires: now + TTL_MS });
  return value;
}

export function priceFor(catalog: Catalog, interval: BillingInterval, seats: number): CatalogPrice {
  assertSeats(seats);
  const p = catalog.prices.find((x) => x.interval === interval && x.seats === seats);
  if (!p) throw new AppError(503, 'Price not available', 'CATALOG_UNAVAILABLE');
  return p;
}

async function allActivePrices(mode: BillingMode, now = Date.now()): Promise<CatalogPrice[]> {
  const hit = allPricesCache.get(mode);
  if (hit && hit.expires > now) return hit.value;
  const raw = await getStripe(mode).prices.list({ active: true, limit: 100 }).autoPagingToArray({ limit: 2000 });
  const value = raw.map(toCatalogPrice).filter((p): p is CatalogPrice => p !== null);
  allPricesCache.set(mode, { value, expires: now + TTL_MS });
  return value;
}

/** §6.5 grandfathering: an active price from a specific price_set, or null. */
export async function findPriceInSet(mode: BillingMode, priceSet: string, interval: BillingInterval, seats: number): Promise<CatalogPrice | null> {
  assertSeats(seats);
  const catalog = await getCatalog(mode);
  if (catalog.priceSet === priceSet) return priceFor(catalog, interval, seats);
  const all = await allActivePrices(mode);
  return all.find((p) => p.priceSet === priceSet && p.interval === interval && p.seats === seats && p.active) ?? null;
}

export async function bustCatalogCache(mode?: BillingMode): Promise<void> {
  clearLocalCatalogCache(mode);
  const sent = await publishMessage(CATALOG_BUST_CHANNEL, mode ?? 'all');
  if (!sent) logger.warn('[Billing] Catalog bust not published (Redis down); other instances refresh within 10 minutes');
}

export function startCatalogBustSubscriber(): void {
  const sub = redis.duplicate();
  sub.on('error', () => undefined);
  sub.subscribe(CATALOG_BUST_CHANNEL).catch((err: Error) => logger.warn(`[Billing] catalog subscriber: ${err.message}`));
  sub.on('message', (_channel: string, message: string) => {
    clearLocalCatalogCache(message === 'test' || message === 'live' ? message : undefined);
  });
}
