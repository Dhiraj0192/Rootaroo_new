import { Router } from 'express';
import { requireAdminApiKey } from '../../shared/middleware/adminApiKey';
import { auditLog } from '../billing/admin/auth';
import { validate } from '../../shared/middleware/validate';
import { reviewActionRequestSchema } from './validation';
import * as ctrl from './controller';

const router = Router();

// Rootaroo-staff-only surface — guarded by a static API key, not a user JWT.
// Audit first so rejected requests are logged too (spec 5.10).
router.use(auditLog('admin'));
router.use(requireAdminApiKey);

/**
 * @openapi
 * /admin/requests:
 *   get:
 *     tags: [Admin]
 *     summary: List household leave/delete action requests (admin-only)
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [pending, approved, rejected] }
 *     responses:
 *       200:
 *         description: List of requests
 */
router.get('/requests', ctrl.listRequests);

/**
 * @openapi
 * /admin/requests/{id}/approve:
 *   post:
 *     tags: [Admin]
 *     summary: Approve a pending household action request (admin-only)
 *     description: >
 *       'leave' executes the member removal immediately; 'delete' starts
 *       the existing 30-day grace period.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Request approved
 *       400:
 *         description: Request already reviewed
 * /admin/requests/{id}/reject:
 *   post:
 *     tags: [Admin]
 *     summary: Reject a pending household action request (admin-only)
 *     description: No side effect on the household or membership.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Request rejected
 *       400:
 *         description: Request already reviewed
 */
router.post('/requests/:id/approve', validate(reviewActionRequestSchema), ctrl.approveRequest);
router.post('/requests/:id/reject', validate(reviewActionRequestSchema), ctrl.rejectRequest);

export default router;
