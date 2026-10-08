import { Router } from 'express';
import { requireAdminApiKey } from '../../shared/middleware/adminApiKey';
import { auditLog } from '../billing/admin/auth';
import { validate } from '../../shared/middleware/validate';
import { reviewActionRequestSchema, setCampaignSchema } from './validation';
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

/**
 * @openapi
 * /admin/campaigns:
 *   get:
 *     tags: [Admin]
 *     summary: Campaign switches (all off by default) and the copy deck for review (admin-only)
 *     responses:
 *       200:
 *         description: "{ all, rules, signedOutNudges, updated, copy }"
 * /admin/campaigns/{key}:
 *   put:
 *     tags: [Admin]
 *     summary: Switch the master, one rule, or signed-out nudges on or off (admin-only)
 *     parameters:
 *       - in: path
 *         name: key
 *         required: true
 *         schema: { type: string, description: "all, a rule name, or signed_out_nudges" }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [enabled]
 *             properties:
 *               enabled: { type: boolean }
 *     responses:
 *       200:
 *         description: The new settings
 *       400:
 *         description: Unknown campaign or invalid body
 */
router.get('/campaigns', ctrl.listCampaigns);
router.put('/campaigns/:key', validate(setCampaignSchema), ctrl.setCampaign);

export default router;
