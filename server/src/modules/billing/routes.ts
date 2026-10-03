import { Router } from 'express';
import { authenticate } from '../../shared/middleware/auth';
import { validate } from '../../shared/middleware/validate';
import * as ctrl from './controller';
import { billingReturn } from './returnPage';
import { checkoutSchema, syncParamsSchema } from './validation';

const router = Router();

// ── Public (no auth) ──

/**
 * @openapi
 * /billing/return/{result}:
 *   get:
 *     tags: [Billing]
 *     summary: Public Checkout/portal return page. 302 to rootaroo://billing/<result>; no side effects
 *     parameters:
 *       - { in: path, name: result, required: true, schema: { type: string, enum: [success, cancel, portal] } }
 *       - { in: query, name: session_id, schema: { type: string, pattern: '^cs_(test|live)_[A-Za-z0-9]+$' } }
 *     responses:
 *       302: { description: Redirect into the app }
 *       200: { description: Static fallback page }
 */
router.get('/return/:result', billingReturn);

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

/**
 * @openapi
 * /billing/checkout/{sessionId}/sync:
 *   post:
 *     tags: [Billing]
 *     summary: Sync a Checkout session for the caller household (any member)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: sessionId, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: "{ entitlement, pendingCheckout: { sessionId, state: open|processing|complete|expired } }" }
 *       403: { description: Session belongs to another household or mode }
 * /billing/status:
 *   get:
 *     tags: [Billing]
 *     summary: Entitlement, subscription, admins, purchase method, plans and pending checkout
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: "{ entitlement, subscription, isAdmin, adminNames, purchaseMethod, plans, pendingCheckout, memberCount }" }
 *       403: { description: NO_HOUSEHOLD }
 */
router.post('/checkout/:sessionId/sync', validate(syncParamsSchema), ctrl.sync);
router.get('/status', ctrl.status);

export default router;

