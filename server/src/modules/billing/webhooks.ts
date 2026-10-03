import Stripe from 'stripe';
import { Request, Response, RequestHandler } from 'express';
import { UniqueConstraintError } from 'sequelize';
import { BillingEvent } from '../../database/models';
import logger from '../../shared/utils/logger';
import { getBillingConfig, getStripe } from './config';
import { livemodeOf } from './mode';
import { enqueueEvent } from './worker';
import type { BillingMode } from './types';

export class WebhookVerificationError extends Error {}

const TOLERANCE_SEC = 300;

export function verifyStripeEvent(raw: Buffer, signature: string | undefined, mode: BillingMode): Stripe.Event {
  const modeCfg = getBillingConfig().modes[mode];
  if (!modeCfg || modeCfg.webhookSecrets.length === 0) throw new WebhookVerificationError(`${mode} webhooks are not configured`);
  if (!signature) throw new WebhookVerificationError('missing Stripe-Signature');
  const stripe = getStripe(mode);
  for (const secret of modeCfg.webhookSecrets) {
    try {
      return stripe.webhooks.constructEvent(raw, signature, secret, TOLERANCE_SEC);
    } catch {
      // try the next secret (rotation)
    }
  }
  throw new WebhookVerificationError('signature verification failed');
}

/** Verify, persist, 200, enqueue. Finishes in milliseconds; never calls Stripe (§8.4). */
export function stripeWebhookHandler(mode: BillingMode): RequestHandler {
  return async (req: Request, res: Response) => {
    if (!Buffer.isBuffer(req.body)) {
      res.status(400).json({ success: false, error: 'Expected application/json' });
      return;
    }
    let event: Stripe.Event;
    try {
      event = verifyStripeEvent(req.body, req.header('stripe-signature'), mode);
    } catch (err) {
      logger.warn(`[Billing] ${mode} webhook rejected: ${(err as Error).message}`);
      res.status(400).json({ success: false, error: 'Invalid signature' });
      return;
    }
    if (event.livemode !== livemodeOf(mode)) {
      res.status(400).json({ success: false, error: 'Mode mismatch' });
      return;
    }
    try {
      const row = await BillingEvent.create({
        provider: 'stripe', livemode: event.livemode, providerEventId: event.id, type: event.type,
        payload: event as unknown as Record<string, unknown>, status: 'received', attempts: 0, receivedAt: new Date(),
      });
      res.status(200).json({ received: true });
      enqueueEvent(row.id);
    } catch (err) {
      if (err instanceof UniqueConstraintError) {
        res.status(200).json({ received: true, duplicate: true });
        return;
      }
      logger.error(`[Billing] failed to persist ${event.id}:`, err);
      res.status(500).json({ success: false, error: 'Temporary failure' }); // Stripe retries
    }
  };
}
