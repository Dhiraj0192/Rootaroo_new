import { Router } from 'express';
import { authenticate } from '../../shared/middleware/auth';
import * as ctrl from './controller';

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

export default router;

