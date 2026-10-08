import { Request, Response, RequestHandler } from 'express';
import { UniqueConstraintError } from 'sequelize';
import { BillingEvent } from '../../../database/models';
import logger from '../../../shared/utils/logger';
import { enqueueEvent } from '../worker';
import { AppleVerificationError, verifyNotification } from './apple';
import { appleEventType } from './appleEvents';
import { getIapConfig } from './config';
import { verifyPushAuthorization } from './google';
import { DeveloperNotification, googleEventType } from './googleEvents';

/**
 * POST /api/v1/billing/webhooks/apple: App Store Server Notifications V2.
 * Verify (x5c chain to Apple Root CA G3, bundle id, environment), persist, 200, enqueue. Never calls Apple.
 * A failure that could be transient (OCSP unreachable, DB down) answers 5xx so Apple retries; a bad signature is a 400.
 */
export const appleWebhookHandler: RequestHandler = async (req: Request, res: Response) => {
  if (!getIapConfig().apple) {
    res.status(503).json({ success: false, error: 'Apple IAP is not configured' });
    return;
  }
  if (!Buffer.isBuffer(req.body)) {
    res.status(400).json({ success: false, error: 'Expected application/json' });
    return;
  }
  let signedPayload: unknown;
  try {
    signedPayload = (JSON.parse(req.body.toString('utf8')) as { signedPayload?: unknown }).signedPayload;
  } catch {
    res.status(400).json({ success: false, error: 'Invalid JSON' });
    return;
  }
  if (typeof signedPayload !== 'string' || signedPayload.length === 0) {
    res.status(400).json({ success: false, error: 'Missing signedPayload' });
    return;
  }

  let verified;
  try {
    verified = await verifyNotification(signedPayload);
  } catch (err) {
    const e = err as AppleVerificationError;
    logger.warn(`[IAP] Apple notification rejected: ${e.message}`);
    res.status(e.retryable ? 503 : 400).json({ success: false, error: 'Invalid notification' });
    return;
  }
  const { notification } = verified;
  const id = notification.notificationUUID;
  if (!id) {
    res.status(400).json({ success: false, error: 'Missing notificationUUID' });
    return;
  }
  try {
    const row = await BillingEvent.create({
      provider: 'apple', livemode: verified.livemode, providerEventId: id, type: appleEventType(notification),
      payload: { notification, transaction: verified.transaction, renewal: verified.renewal } as unknown as Record<string, unknown>,
      status: 'received', attempts: 0, receivedAt: new Date(),
    });
    res.status(200).json({ received: true });
    enqueueEvent(row.id);
  } catch (err) {
    if (err instanceof UniqueConstraintError) {
      res.status(200).json({ received: true, duplicate: true });
      return;
    }
    logger.error(`[IAP] failed to persist Apple notification ${id}:`, err);
    res.status(500).json({ success: false, error: 'Temporary failure' });
  }
};

/**
 * POST /api/v1/billing/webhooks/google: Pub/Sub push of Real-time Developer Notifications.
 * Authenticated by the OIDC bearer token Google signs for the push service account. The truth is fetched from the
 * Play API by the worker, so this only decodes, persists and acknowledges (any 2xx acks the Pub/Sub message).
 */
export const googleWebhookHandler: RequestHandler = async (req: Request, res: Response) => {
  const cfg = getIapConfig().google;
  if (!cfg) {
    res.status(503).json({ success: false, error: 'Google Play billing is not configured' });
    return;
  }
  try {
    await verifyPushAuthorization(req.header('authorization'));
  } catch (err) {
    logger.warn(`[IAP] Google push rejected: ${(err as Error).message}`);
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }
  if (!Buffer.isBuffer(req.body)) {
    res.status(400).json({ success: false, error: 'Expected application/json' });
    return;
  }
  let envelope: { message?: { data?: string; messageId?: string; publishTime?: string } };
  let notification: DeveloperNotification;
  try {
    envelope = JSON.parse(req.body.toString('utf8'));
    const data = envelope.message?.data;
    if (typeof data !== 'string' || !envelope.message?.messageId) throw new Error('missing message');
    notification = JSON.parse(Buffer.from(data, 'base64').toString('utf8')) as DeveloperNotification;
  } catch {
    res.status(400).json({ success: false, error: 'Invalid Pub/Sub message' });
    return;
  }
  if (notification.packageName !== cfg.packageName) {
    // A permanent mismatch: retrying cannot fix it, so ack the message and drop it.
    logger.warn(`[IAP] Google notification for package ${String(notification.packageName)} ignored`);
    res.status(200).json({ received: true, ignored: true });
    return;
  }
  const messageId = envelope.message!.messageId!;
  try {
    const row = await BillingEvent.create({
      // livemode is unknown until the Play API says whether it was a test purchase; the worker corrects it.
      provider: 'google', livemode: true, providerEventId: messageId, type: googleEventType(notification),
      payload: { notification, publishTime: envelope.message?.publishTime } as unknown as Record<string, unknown>,
      status: 'received', attempts: 0, receivedAt: new Date(),
    });
    res.status(200).json({ received: true });
    enqueueEvent(row.id);
  } catch (err) {
    if (err instanceof UniqueConstraintError) {
      res.status(200).json({ received: true, duplicate: true });
      return;
    }
    logger.error(`[IAP] failed to persist Google message ${messageId}:`, err);
    res.status(500).json({ success: false, error: 'Temporary failure' });
  }
};
