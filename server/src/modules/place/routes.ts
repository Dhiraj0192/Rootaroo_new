import { Router } from 'express';
import { authenticate } from '../../shared/middleware/auth';
import { requireEntitlement } from '../billing/entitlement';
import { validate } from '../../shared/middleware/validate';
import * as ctrl from './controller';
import { createSavedPlaceSchema, updateSavedPlaceSchema } from './validation';

const router = Router();

router.use(authenticate);
router.use(requireEntitlement);

// Bookmark a location (Home, Office, School, or custom)
router.post('/', validate(createSavedPlaceSchema), ctrl.create);

// List all saved places for the household
router.get('/', ctrl.list);

// Edit / remove a saved place (owner only)
router.patch('/:id', validate(updateSavedPlaceSchema), ctrl.update);
router.delete('/:id', ctrl.remove);

export default router;
