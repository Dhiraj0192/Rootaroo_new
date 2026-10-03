import express, { Router, Request, Response, NextFunction } from 'express';
import { stripeWebhookHandler } from './webhooks';
import { appleWebhookHandler, googleWebhookHandler } from './iap/webhooks';
import { registerIapDispatchers } from './iap/register';

const router = Router();
const raw = express.raw({ type: 'application/json', limit: '1mb' });

router.post('/stripe/test', raw, stripeWebhookHandler('test'));
router.post('/stripe/live', raw, stripeWebhookHandler('live'));
router.post('/apple', raw, appleWebhookHandler);
router.post('/google', raw, googleWebhookHandler);

registerIapDispatchers();

// body-parser errors (413 too large, 400 bad encoding) as plain JSON, never the global 500.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
router.use((err: { status?: number; type?: string }, _req: Request, res: Response, _next: NextFunction) => {
  res.status(err.status === 413 ? 413 : 400).json({ success: false, error: err.type ?? 'Bad request' });
});

export default router;
