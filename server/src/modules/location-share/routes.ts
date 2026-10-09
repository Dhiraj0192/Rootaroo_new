import { Router } from 'express';
import { authenticate } from '../../shared/middleware/auth';
import { requireEntitlement } from '../billing/entitlement';
import { validate } from '../../shared/middleware/validate';
import * as ctrl from './controller';
import { startShareSchema, updateShareLocationSchema, shareIdParamSchema } from './validation';

const router = Router();

router.use(authenticate);
router.use(requireEntitlement);

/**
 * @swagger
 * /location-shares:
 *   post:
 *     tags: [Location sharing]
 *     summary: Start sharing your live location (1 minute to 8 hours); replaces any share you already have
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [durationMinutes, viewerIds, latitude, longitude]
 *             properties:
 *               durationMinutes: { type: integer, minimum: 1, maximum: 480 }
 *               viewerIds: { type: array, nullable: true, minItems: 1, items: { type: string, format: uuid }, description: null shares with everyone in the household }
 *               latitude: { type: number }
 *               longitude: { type: number }
 *               accuracy: { type: number, nullable: true }
 *     responses:
 *       201: { description: Share started }
 *       400: { description: Invalid duration or viewers }
 *   get:
 *     tags: [Location sharing]
 *     summary: Your active share and the active shares you can see
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: "{ mine, visible }" }
 * /location-shares/{id}/location:
 *   post:
 *     tags: [Location sharing]
 *     summary: Send your latest position (sharer only)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200: { description: Position stored }
 *       403: { description: Not your share }
 *       410: { description: The share has ended; stop sending }
 * /location-shares/{id}/stop:
 *   post:
 *     tags: [Location sharing]
 *     summary: Stop sharing (sharer only)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200: { description: Share ended }
 *       403: { description: Not your share }
 */
router.post('/', validate(startShareSchema), ctrl.start);
router.get('/', ctrl.list);
router.post('/:id/location', validate(updateShareLocationSchema), ctrl.updateLocation);
router.post('/:id/stop', validate(shareIdParamSchema), ctrl.stop);

export default router;
