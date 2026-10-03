import Stripe from 'stripe';
import { fakeKey } from './secrets';

const stripe = new Stripe(fakeKey('sk_test'));

/** A real Stripe-Signature header for `event`, as Stripe would send it. */
export function signedWebhook(event: unknown, secret: string, timestamp?: number): { body: string; signature: string } {
  const body = JSON.stringify(event);
  const signature = stripe.webhooks.generateTestHeaderString({ payload: body, secret, ...(timestamp ? { timestamp } : {}) });
  return { body, signature };
}
