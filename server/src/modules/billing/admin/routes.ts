import { Router } from 'express';
import { validate } from '../../../shared/middleware/validate';
import { auditLog, requireBillingAdminKey } from './auth';
import * as ctrl from './controller';
import { idParamSchema, transactionsQuerySchema } from './validation';

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

/**
 * @openapi
 * /billing-admin/transactions:
 *   get:
 *     tags: [BillingAdmin]
 *     summary: Ledger rows with household, payer, amounts, fee/net and a Stripe Dashboard link
 *     security: [{ billingAdminKey: [] }]
 *     parameters:
 *       - { in: query, name: mode, schema: { type: string, enum: [test, live], default: live } }
 *       - { in: query, name: householdId, schema: { type: string, format: uuid } }
 *       - { in: query, name: userId, schema: { type: string, format: uuid } }
 *       - { in: query, name: email, schema: { type: string } }
 *       - { in: query, name: type, schema: { type: string, enum: [payment, failed_payment, refund, dispute] } }
 *       - { in: query, name: status, schema: { type: string } }
 *       - { in: query, name: matchStatus, schema: { type: string, enum: [matched, unmatched] } }
 *       - { in: query, name: billingReason, schema: { type: string } }
 *       - { in: query, name: from, schema: { type: string, format: date-time } }
 *       - { in: query, name: to, schema: { type: string, format: date-time } }
 *       - { in: query, name: cursor, schema: { type: string } }
 *       - { in: query, name: limit, schema: { type: integer, minimum: 1, maximum: 200, default: 50 } }
 *     responses:
 *       200: { description: "{ success, data: Transaction[], nextCursor }" }
 *       400: { description: Invalid filter or cursor }
 *       401: { description: Missing or wrong x-admin-billing-key }
 * /billing-admin/transactions.csv:
 *   get:
 *     tags: [BillingAdmin]
 *     summary: Same filters as /transactions, streamed as CSV
 *     security: [{ billingAdminKey: [] }]
 *     responses:
 *       200: { description: text/csv }
 *       400: { description: Invalid filter or cursor }
 * /billing-admin/transactions/{id}:
 *   get:
 *     tags: [BillingAdmin]
 *     summary: One transaction with its subscription and household
 *     security: [{ billingAdminKey: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200: { description: Transaction }
 *       404: { description: Not found }
 */
router.get('/transactions', validate(transactionsQuerySchema), ctrl.transactions);
router.get('/transactions.csv', validate(transactionsQuerySchema), ctrl.transactionsCsv);
router.get('/transactions/:id', validate(idParamSchema), ctrl.transaction);

export default router;
