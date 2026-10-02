import { Router } from 'express';
import { authenticate } from '../../shared/middleware/auth';
import { requireEntitlement } from '../billing/entitlement';
import { requireRole } from '../../shared/middleware/rbac';
import { validate } from '../../shared/middleware/validate';
import * as ctrl from './controller';
import {
  createTaskSchema,
  updateTaskSchema,
  taskQuerySchema,
} from './validation';

const router = Router();

router.use(authenticate);
router.use(requireEntitlement);

router.post('/', requireRole('member'), validate(createTaskSchema), ctrl.create);    // FR-060/061
router.get('/', validate(taskQuerySchema), ctrl.list);                                // FR-065
router.get('/summary', ctrl.summary);                                                 // FR-069
router.get('/:id', ctrl.getById);                                                     // FR-060
router.patch('/:id', validate(updateTaskSchema), ctrl.update);                        // FR-066
router.delete('/:id', ctrl.remove);                                                   // FR-067
router.post('/:id/complete', ctrl.complete);                                          // FR-063/068
router.post('/:id/reopen', ctrl.reopen);                                              // FR-064

export default router;
