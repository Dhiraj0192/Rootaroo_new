import { Router } from 'express';
import { authenticate } from '../../shared/middleware/auth';
import { requireEntitlement } from '../billing/entitlement';
import { validate } from '../../shared/middleware/validate';
import * as ctrl from './controller';
import {
  createEventSchema,
  listEventsQuerySchema,
  updateEventSchema,
  connectGoogleCalendarSchema,
  connectAppleCalendarSchema,
} from './validation';

const router = Router();

router.use(authenticate);
router.use(requireEntitlement);

router.post('/', validate(createEventSchema), ctrl.create);     // FR-181: create family event
router.get('/', validate(listEventsQuerySchema), ctrl.list);    // FR-180/182: household events
router.get('/export.ics', ctrl.exportIcs);                      // FR-185: iCalendar export (must precede /:id)

// Google Calendar two-way sync (must precede /:id)
router.get('/google/status', ctrl.googleStatus);
router.post('/google/connect', validate(connectGoogleCalendarSchema), ctrl.googleConnect);
router.post('/google/disconnect', ctrl.googleDisconnect);

// Outlook Calendar one-way ICS subscription feed (must precede /:id) — no
// body to validate, connect just (re)generates the feed token.
router.get('/outlook/status', ctrl.outlookStatus);
router.post('/outlook/connect', ctrl.outlookConnect);
router.post('/outlook/disconnect', ctrl.outlookDisconnect);

// Apple Calendar two-way sync (must precede /:id)
router.get('/apple/status', ctrl.appleStatus);
router.post('/apple/connect', validate(connectAppleCalendarSchema), ctrl.appleConnect);
router.post('/apple/disconnect', ctrl.appleDisconnect);

router.get('/:id', ctrl.getById);                               // FR: single event detail
router.patch('/:id', validate(updateEventSchema), ctrl.update); // FR-187/188: edit
router.delete('/:id', ctrl.remove);                             // FR-187/188: delete

export default router;
