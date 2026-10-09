import { Router } from 'express';
import { signedOutNudgesEnabled } from './settings';

const router = Router();

// Public and outside the paywall: the signed-out app asks this before it schedules any local nudge.
/**
 * @swagger
 * /campaigns/signed-out:
 *   get:
 *     tags: [Campaigns]
 *     summary: Whether signed-out nudges are switched on (no auth)
 *     responses:
 *       200: { description: "{ success, data: { enabled } }, cacheable for 5 minutes" }
 */
router.get('/signed-out', async (_req, res, next) => {
  try {
    const enabled = await signedOutNudgesEnabled();
    res.set('Cache-Control', 'public, max-age=300');
    res.status(200).json({ success: true, data: { enabled } });
  } catch (e) { next(e); }
});

export default router;
