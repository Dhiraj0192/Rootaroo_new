import { Router } from 'express';
import { authenticate } from '../../shared/middleware/auth';
import { validate } from '../../shared/middleware/validate';
import * as ctrl from './controller';
import { checkoutSchema } from './validation';

const router = Router();

// ── Public (no auth): the Checkout return page is added here in Task 5.6 ──

router.use(authenticate);

/**
 * @openapi
 * /billing/plans:
 *   get:
 *     tags: [Billing]
 *     summary: Price matrix for the caller's household mode (seats 5..10, month/year)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: "{ mode, priceSet, currency, seatsIncluded, seatsMax, matrix }" }
 *       403: { description: NO_HOUSEHOLD }
 *       503: { description: BILLING_MODE_UNAVAILABLE or CATALOG_UNAVAILABLE }
 */
router.get('/plans', ctrl.plans);

/**
 * @openapi
 * /billing/checkout:
 *   post:
 *     tags: [Billing]
 *     summary: Start (or reuse) a Stripe Checkout session for the caller's household (admin only)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: header, name: X-Platform, schema: { type: string, enum: [ios, android, web] } }
 *       - { in: header, name: X-Store-Country, schema: { type: string, example: US } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [interval, seats]
 *             properties:
 *               interval: { type: string, enum: [month, year] }
 *               seats: { type: integer, minimum: 5, maximum: 10 }
 *     responses:
 *       200: { description: "{ url, sessionId }" }
 *       403: { description: Not an admin, or NO_HOUSEHOLD }
 *       409: { description: "ALREADY_SUBSCRIBED | PAYMENT_ISSUE {portalUrl} | SEATS_BELOW_MEMBERS {memberCount} | PURCHASE_METHOD_MISMATCH | LOCK_BUSY" }
 *       502: { description: CHECKOUT_FAILED }
 *       503: { description: BILLING_MODE_UNAVAILABLE }
 */
router.post('/checkout', validate(checkoutSchema), ctrl.checkout);

export default router;

