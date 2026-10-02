import { Router } from 'express';
import { authenticate } from '../../shared/middleware/auth';
import { requireEntitlement } from '../billing/entitlement';
import { validate } from '../../shared/middleware/validate';
import * as ctrl from './controller';
import { deviceTokenSchema, updatePreferencesSchema } from './validation';

const router = Router();

router.use(authenticate);

// Device tokens
router.post('/tokens', validate(deviceTokenSchema), ctrl.registerToken);
router.delete('/tokens/:token', ctrl.unregisterToken);

// Notification history
router.get('/history', requireEntitlement, ctrl.getHistory);
router.post('/history/:id/read', requireEntitlement, ctrl.markAsRead);
router.post('/history/read-all', requireEntitlement, ctrl.markAllAsRead);
router.get('/unread-count', ctrl.getUnreadCount);

// Preferences
router.get('/preferences', ctrl.getPreferences);
router.patch('/preferences', validate(updatePreferencesSchema), ctrl.updatePreferences);

export default router;
