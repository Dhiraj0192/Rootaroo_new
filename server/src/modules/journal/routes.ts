import { Router } from 'express';
import { authenticate } from '../../shared/middleware/auth';
import { requireEntitlement } from '../billing/entitlement';
import { validate } from '../../shared/middleware/validate';
import { uploadFeedMedia } from '../../shared/middleware/upload';
import * as ctrl from './controller';
import {
  createEntrySchema,
  updateEntrySchema,
  entryIdParamSchema,
  entryQuerySchema,
  historyQuerySchema,
  onThisDayQuerySchema,
} from './validation';

const router = Router();

router.use(authenticate);
router.use(requireEntitlement);

// Media upload + stats reads — all before /:id, or the UUID param route
// would swallow them.
router.post('/media/upload', uploadFeedMedia.array('files', 10), ctrl.uploadMedia);
router.get('/stats', ctrl.stats);
router.get('/history', validate(historyQuerySchema), ctrl.history);
router.get('/on-this-day', validate(onThisDayQuerySchema), ctrl.onThisDay);

// Journal CRUD
router.post('/', validate(createEntrySchema), ctrl.create);
router.get('/', validate(entryQuerySchema), ctrl.list);
router.get('/:id', validate(entryIdParamSchema), ctrl.getById);
router.patch('/:id', validate(updateEntrySchema), ctrl.update);
router.delete('/:id', validate(entryIdParamSchema), ctrl.remove);

export default router;
