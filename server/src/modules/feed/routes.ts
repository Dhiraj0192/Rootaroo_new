import { Router } from 'express';
import { authenticate } from '../../shared/middleware/auth';
import { requireEntitlement } from '../billing/entitlement';
import { validate } from '../../shared/middleware/validate';
import * as ctrl from './controller';
import { uploadFeedMedia } from '../../shared/middleware/upload';
import {
  createPostSchema,
  feedQuerySchema,
  createCommentSchema,
  commentQuerySchema,
} from './validation';

const router = Router();

// All feed routes require authentication
router.use(authenticate);
router.use(requireEntitlement);

// Post CRUD
router.post('/', validate(createPostSchema), ctrl.create);                            // FR-040/041/042/043
router.get('/', validate(feedQuerySchema), ctrl.list);                                // FR-040/046/050
router.get('/:postId', ctrl.getById);                                                 // FR-040
router.delete('/:postId', ctrl.remove);                                               // FR-048/049

// Likes
router.post('/:postId/like', ctrl.toggleLike);                                       // FR-044
router.delete('/:postId/like', ctrl.removeLike);                                     // FR-044

// Comments
router.get('/:postId/comments', validate(commentQuerySchema), ctrl.listComments);     // FR-045
router.post('/:postId/comments', validate(createCommentSchema), ctrl.addComment);     // FR-045
router.delete('/comments/:commentId', ctrl.removeComment);                            // FR-045

// Comment reactions
router.post('/comments/:commentId/reactions', ctrl.toggleReaction);
router.delete('/comments/:commentId/reactions/:reaction', ctrl.toggleReaction);

// Media upload (for FR-042/043)
router.post('/media/upload', uploadFeedMedia.array('files', 10), ctrl.uploadMedia);   // FR-042/043

export default router;
