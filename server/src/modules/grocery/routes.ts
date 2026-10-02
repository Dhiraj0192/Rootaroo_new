import { Router } from 'express';
import { authenticate } from '../../shared/middleware/auth';
import { requireEntitlement } from '../billing/entitlement';
import { validate } from '../../shared/middleware/validate';
import * as ctrl from './controller';
import { createGrocerySchema, updateGrocerySchema } from './validation';

const router = Router();

router.use(authenticate);
router.use(requireEntitlement);

router.post('/', validate(createGrocerySchema), ctrl.create);   // FR-080
router.get('/', ctrl.list);                                      // FR-087
router.patch('/:id', validate(updateGrocerySchema), ctrl.update); // FR-083
router.delete('/:id', ctrl.remove);                              // FR-082
router.post('/:id/toggle', ctrl.toggle);                         // FR-081
router.post('/:id/archive', ctrl.archive);                       // FR-088
router.get('/summary', ctrl.summary);                            // FR-089

export default router;
