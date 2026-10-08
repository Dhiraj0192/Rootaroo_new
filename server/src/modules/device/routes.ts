import { Router } from 'express';
import { authenticate } from '../../shared/middleware/auth';
import { validate } from '../../shared/middleware/validate';
import * as ctrl from './controller';
import { deviceIdParamSchema } from './validation';

const router = Router();

// No requireEntitlement: this is account security, and a lapsed plan must not
// stop someone removing a lost phone.
router.use(authenticate);

/**
 * @swagger
 * /devices:
 *   get:
 *     tags: [Devices]
 *     summary: List the devices signed in to this account
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Active devices, most recently used first }
 * /devices/{id}:
 *   delete:
 *     tags: [Devices]
 *     summary: Remove a device, signing it out and dropping its push token
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200: { description: Device removed }
 *       404: { description: Device not found }
 */
router.get('/', ctrl.list);
router.delete('/:id', validate(deviceIdParamSchema), ctrl.remove);

export default router;
