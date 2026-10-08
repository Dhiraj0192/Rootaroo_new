import { Router } from 'express';
import { authenticate } from '../../shared/middleware/auth';
import { requireEntitlement } from '../billing/entitlement';
import { validate } from '../../shared/middleware/validate';
import { uploadChatVoice, uploadChatImage } from '../../shared/middleware/upload';
import * as ctrl from './controller';
import {
  createMessageSchema,
  updateMessageSchema,
  reactionSchema,
  deleteReactionSchema,
  messageQuerySchema,
  messageIdParamSchema,
  createConversationSchema,
  conversationIdParamSchema,
  addParticipantSchema,
  removeParticipantSchema,
} from './validation';

const router = Router();

router.use(authenticate);
router.use(requireEntitlement);

// Conversations — must be registered before /:id so "conversations" is not treated as a message id
router.post('/conversations', validate(createConversationSchema), ctrl.createConversationCtrl);
router.get('/conversations', ctrl.getUserConversationsCtrl);
router.delete('/conversations/:id', validate(conversationIdParamSchema), ctrl.deleteConversationCtrl);
router.post('/conversations/:id/participants', validate(addParticipantSchema), ctrl.addParticipantCtrl);
router.delete('/conversations/:id/participants/:userId', validate(removeParticipantSchema), ctrl.removeParticipantCtrl);
router.post('/conversations/:id/invite', validate(addParticipantSchema), ctrl.inviteParticipantCtrl);
router.post('/conversations/:id/read', validate(conversationIdParamSchema), ctrl.markConversationReadCtrl);

// Typing indicator: client-driven via the 'chat:typing'/'chat:stop-typing'
// socket events (socket/chatSocket.ts) — there used to also be a REST
// POST /typing path here, but it broadcast to the bare householdId room
// instead of `household:${householdId}` (the room clients actually join),
// so it reached zero connected clients. Removed rather than fixed, since
// the socket-event path was already correct and is the one actually used
// (F-17).

// Voice message upload — before /:id
router.post('/media/voice', uploadChatVoice.single('file'), ctrl.uploadVoiceCtrl);
router.post('/media/image', uploadChatImage.single('file'), ctrl.uploadChatImageCtrl);

// Chat CRUD
router.post('/', validate(createMessageSchema), ctrl.sendMessageCtrl);                     // FR-140/143/144
router.get('/', validate(messageQuerySchema), ctrl.listMessagesCtrl);                       // FR-140
router.get('/:id', validate(messageIdParamSchema), ctrl.getMessageByIdCtrl);
router.patch('/:id', validate(updateMessageSchema), ctrl.updateMessageCtrl);                // FR-150
router.delete('/:id', validate(messageIdParamSchema), ctrl.deleteMessageCtrl);               // FR-145/146

// Reactions
router.post('/:id/reactions', validate(reactionSchema), ctrl.addReactionCtrl);              // FR-148
router.delete('/:id/reactions/:emoji', validate(deleteReactionSchema), ctrl.removeReactionCtrl);

export default router;
