import { Router } from 'express';
import { auditLog, requireBillingAdminKey } from './auth';
import * as ctrl from './controller';

const router = Router();

// Audit first so rejected requests are logged too.
router.use(auditLog('billing-admin'));
router.use(requireBillingAdminKey);

/**
 * @openapi
 * /billing-admin/ping:
 *   get:
 *     tags: [BillingAdmin]
 *     summary: Verify a billing admin key
 *     security: [{ billingAdminKey: [] }]
 *     responses:
 *       200: { description: "{ ok: true }" }
 *       401: { description: Missing or wrong x-admin-billing-key }
 *       403: { description: IP not in ADMIN_BILLING_IP_ALLOWLIST }
 */
router.get('/ping', ctrl.ping);

export default router;
