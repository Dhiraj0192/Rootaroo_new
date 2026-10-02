import Stripe from 'stripe';
import { __setBillingConfigForTests, __setStripeForTests, BillingConfig } from '../../modules/billing/config';
import type { BillingMode } from '../../modules/billing/types';
import { testBillingConfig } from './config';
import { fakeKey } from './secrets';

/** A Stripe list result that works with `await`, `for await` and autoPagingToArray. */
export function listOf<T>(items: T[]): any {
  const page = { object: 'list', data: items, has_more: false };
  const p: any = Promise.resolve(page);
  p[Symbol.asyncIterator] = async function* () { yield* items; };
  p.autoPagingToArray = async () => items;
  p.autoPagingEach = async (fn: (x: T) => unknown) => { for (const i of items) await fn(i); };
  return p;
}

const fn = () => jest.fn<any, any[]>();
const listFn = () => jest.fn<any, any[]>(() => listOf([]));

export function makeStripeMock() {
  // Real webhook helpers (pure crypto, no network) so signature tests are genuine.
  const real = new Stripe(fakeKey('sk_test'));
  return {
    customers: { create: fn(), retrieve: fn(), update: fn(), search: jest.fn<any, any[]>(() => listOf([])) },
    checkout: { sessions: { create: fn(), retrieve: fn(), expire: fn() } },
    subscriptions: { retrieve: fn(), list: listFn(), update: fn(), cancel: fn() },
    prices: { list: listFn(), create: fn(), update: fn() },
    products: { list: listFn(), create: fn(), update: fn() },
    billingPortal: { sessions: { create: fn() }, configurations: { list: listFn(), create: fn(), update: fn() } },
    invoices: { list: listFn(), retrieve: fn() },
    invoicePayments: { list: listFn() },
    paymentIntents: { retrieve: fn() },
    charges: { retrieve: fn() },
    refunds: { create: fn(), list: listFn() },
    disputes: { list: listFn(), update: fn() },
    webhookEndpoints: { list: listFn(), create: fn(), update: fn() },
    testHelpers: { testClocks: { create: fn(), advance: fn(), retrieve: fn() } },
    webhooks: real.webhooks,
  };
}

export type StripeMock = ReturnType<typeof makeStripeMock>;

export function installStripeMock(mode: BillingMode = 'test', config: BillingConfig = testBillingConfig()): StripeMock {
  __setBillingConfigForTests(config);
  const mock = makeStripeMock();
  __setStripeForTests(mode, mock);
  return mock;
}
