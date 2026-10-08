import { Router } from 'express';
import { authenticate } from '../../shared/middleware/auth';
import { requireEntitlement } from '../billing/entitlement';
import * as ctrl from './controller';

const router = Router();

router.use(authenticate);
router.use(requireEntitlement);

router.get('/', ctrl.getDashboard); // FR-069/076/089/091 combined
router.post('/quick-notify', ctrl.quickNotify);

export default router;
