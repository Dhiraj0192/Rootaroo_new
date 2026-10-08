import { Router } from 'express';
import { validate } from '../../../shared/middleware/validate';
import { auditLog, requireBillingAdminKey } from './auth';
import * as ctrl from './controller';
import {
  cohortSchema, idParamSchema, itemsQuerySchema, replayParamsSchema, resolveSchema, routingSchema, runBodySchema, runsQuerySchema,
  subscriptionsQuerySchema, summaryQuerySchema, transactionsQuerySchema,
} from './validation';

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

/**
 * @openapi
 * /billing-admin/summary:
 *   get:
 *     tags: [BillingAdmin]
 *     summary: "Revenue summary: net = gross - succeeded refunds - withdrawn dispute amounts - fees - dispute fees; MRR; subscription counts"
 *     security: [{ billingAdminKey: [] }]
 *     parameters:
 *       - { in: query, name: mode, schema: { type: string, enum: [test, live], default: live } }
 *       - { in: query, name: from, schema: { type: string, format: date-time } }
 *       - { in: query, name: to, schema: { type: string, format: date-time } }
 *     responses:
 *       200: { description: Summary }
 *       400: { description: Invalid parameters }
 * /billing-admin/subscriptions:
 *   get:
 *     tags: [BillingAdmin]
 *     summary: Subscriptions by mode and status
 *     security: [{ billingAdminKey: [] }]
 *     parameters:
 *       - { in: query, name: mode, schema: { type: string, enum: [test, live], default: live } }
 *       - { in: query, name: status, schema: { type: string } }
 *       - { in: query, name: cursor, schema: { type: string } }
 *       - { in: query, name: limit, schema: { type: integer, minimum: 1, maximum: 200, default: 50 } }
 *     responses:
 *       200: { description: "{ success, data, nextCursor }" }
 *       400: { description: Invalid parameters }
 * /billing-admin/households/{id}:
 *   get:
 *     tags: [BillingAdmin]
 *     summary: Cohort, entitlement, subscriptions in every mode (labelled), customers, members, recent transactions
 *     security: [{ billingAdminKey: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200: { description: Household billing view }
 *       404: { description: Not found }
 */
router.get('/summary', validate(summaryQuerySchema), ctrl.summary);
router.get('/subscriptions', validate(subscriptionsQuerySchema), ctrl.subscriptions);
router.get('/households/:id', validate(idParamSchema), ctrl.household);

/**
 * @openapi
 * /billing-admin/reconciliation/runs:
 *   get:
 *     tags: [BillingAdmin]
 *     summary: Reconciliation runs (newest first)
 *     security: [{ billingAdminKey: [] }]
 *     parameters:
 *       - { in: query, name: mode, schema: { type: string, enum: [test, live], default: live } }
 *       - { in: query, name: cursor, schema: { type: string } }
 *       - { in: query, name: limit, schema: { type: integer, minimum: 1, maximum: 200, default: 50 } }
 *     responses:
 *       200: { description: "{ success, data, nextCursor }" }
 *       400: { description: Invalid parameters }
 * /billing-admin/reconciliation/items:
 *   get:
 *     tags: [BillingAdmin]
 *     summary: Review queue items; filter status=needs_review|auto_fixed|resolved|ignored
 *     security: [{ billingAdminKey: [] }]
 *     parameters:
 *       - { in: query, name: mode, schema: { type: string, enum: [test, live], default: live } }
 *       - { in: query, name: status, schema: { type: string, enum: [auto_fixed, needs_review, resolved, ignored] } }
 *       - { in: query, name: cursor, schema: { type: string } }
 *       - { in: query, name: limit, schema: { type: integer, minimum: 1, maximum: 200, default: 50 } }
 *     responses:
 *       200: { description: "{ success, data, nextCursor }" }
 *       400: { description: Invalid parameters }
 * /billing-admin/reconciliation/run:
 *   post:
 *     tags: [BillingAdmin]
 *     summary: Run a manual reconciliation for one mode now
 *     security: [{ billingAdminKey: [] }]
 *     requestBody: { required: true, content: { application/json: { schema: { type: object, required: [mode], properties: { mode: { type: string, enum: [test, live] } } } } } }
 *     responses:
 *       200: { description: The finished run }
 *       400: { description: Invalid mode }
 *       409: { description: LOCK_BUSY (a run is in progress) }
 * /billing-admin/reconciliation/items/{id}/resolve:
 *   post:
 *     tags: [BillingAdmin]
 *     summary: Resolve or ignore a review item with a note (audited)
 *     security: [{ billingAdminKey: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *     requestBody: { required: true, content: { application/json: { schema: { type: object, required: [resolution, note], properties: { resolution: { type: string, enum: [resolved, ignored] }, note: { type: string } } } } } }
 *     responses:
 *       200: { description: Updated item }
 *       400: { description: Invalid body }
 *       404: { description: Not found }
 * /billing-admin/events/{id}/replay:
 *   post:
 *     tags: [BillingAdmin]
 *     summary: Re-queue a stored webhook event (row id or provider event id)
 *     security: [{ billingAdminKey: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: The event row }
 *       404: { description: Not found }
 *       409: { description: EVENT_PROCESSING (a worker holds the event) }
 */
router.get('/reconciliation/runs', validate(runsQuerySchema), ctrl.runs);
router.get('/reconciliation/items', validate(itemsQuerySchema), ctrl.items);
router.post('/reconciliation/run', validate(runBodySchema), ctrl.runNow);
router.post('/reconciliation/items/:id/resolve', validate(resolveSchema), ctrl.resolve);
router.post('/events/:id/replay', validate(replayParamsSchema), ctrl.replay);

/**
 * @openapi
 * /billing-admin/households/{id}/cohort:
 *   post:
 *     tags: [BillingAdmin]
 *     summary: Change a household's billing cohort (live/test). Audited; refused with an active subscription or open checkout unless force.
 *     security: [{ billingAdminKey: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [cohort, reason]
 *             properties:
 *               cohort: { type: string, enum: [live, test] }
 *               reason: { type: string }
 *               force: { type: boolean, description: "Sets cancel_at_period_end and expires open sessions" }
 *     responses:
 *       200: { description: "{ changed, from, to, canceledSubscriptions, expiredSessions, storeSubscriptions }" }
 *       400: { description: Invalid body }
 *       404: { description: Household not found }
 *       409: { description: "COHORT_CHANGE_BLOCKED { subscriptions, openSessions }" }
 * /billing-admin/routing:
 *   get:
 *     tags: [BillingAdmin]
 *     summary: Current routing rules
 *     security: [{ billingAdminKey: [] }]
 *     responses:
 *       200: { description: "Rule[]" }
 *   put:
 *     tags: [BillingAdmin]
 *     summary: Replace all routing rules in one transaction (audited)
 *     security: [{ billingAdminKey: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [rules]
 *             properties:
 *               rules:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     platform: { type: string, enum: [ios, android, web] }
 *                     country: { type: string, example: US }
 *                     method: { type: string, enum: [stripe_checkout, apple_iap, google_play, none] }
 *     responses:
 *       200: { description: "Rule[]" }
 *       400: { description: Invalid or duplicate rule }
 */
router.post('/households/:id/cohort', validate(cohortSchema), ctrl.cohort);
router.get('/routing', ctrl.routing);
router.put('/routing', validate(routingSchema), ctrl.putRouting);

export default router;
