import { Router } from 'express';
import { authenticate } from '../../shared/middleware/auth';
import { requireEntitlement } from '../billing/entitlement';
import { validate } from '../../shared/middleware/validate';
import * as ctrl from './controller';
import {
  createPingRequestSchema,
  respondPingRequestSchema,
  pingQuerySchema,
} from './validation';

const router = Router();

router.use(authenticate);
router.use(requireEntitlement);

// Request a household member's current location
router.post('/', validate(createPingRequestSchema), ctrl.create);

// List ping requests (incoming/outgoing, cursor-paginated)
router.get('/', validate(pingQuerySchema), ctrl.list);

// Accept (shares location, creates a CheckIn, optionally starts a timed live
// share in the location-share module) or decline a pending request
router.post('/:id/respond', validate(respondPingRequestSchema), ctrl.respond);

export default router;
