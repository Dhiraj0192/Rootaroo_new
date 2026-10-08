import { Router } from 'express';
import { authenticate } from '../../shared/middleware/auth';
import { requireEntitlement } from '../billing/entitlement';
import { validate } from '../../shared/middleware/validate';
import * as ctrl from './controller';
import { createCheckInSchema, checkInQuerySchema } from './validation';

const router = Router();

router.use(authenticate);
router.use(requireEntitlement);

// Create a check-in (location optional → timestamp-only, FR-168)
router.post('/', validate(createCheckInSchema), ctrl.create);

// Household timeline (cursor-paginated, FR-163)
router.get('/', validate(checkInQuerySchema), ctrl.list);

// Per-member history (default last 7 days, FR-165)
router.get('/members/:userId', validate(checkInQuerySchema), ctrl.listByMember);

export default router;
