import { Router } from 'express';
import { authenticate } from '../../shared/middleware/auth';
import { requireEntitlement } from '../billing/entitlement';
import { validate } from '../../shared/middleware/validate';
import * as ctrl from './controller';
import { getWeatherSchema } from './validation';

const router = Router();

router.use(authenticate);
router.use(requireEntitlement);

router.get('/', validate(getWeatherSchema), ctrl.getWeather);

export default router;
