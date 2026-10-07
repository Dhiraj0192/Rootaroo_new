import { Server as SocketIOServer } from 'socket.io';
import {
  AuthenticatedSocket,
  requireHouseholdAccess,
} from '../shared/middleware/socketAuth';
import { ConversationParticipant } from '../database/models';
import logger from '../shared/utils/logger';
import { isSocketEntitled } from '../modules/billing/socketGate';

/**
 * Registers chat-related socket event handlers.
 *
 * All events are scoped to the household room — the auth middleware
 * in socketAuth.ts handles JWT verification and room joining.
 * Each event handler re-checks household membership via the guard.
 */
export function registerChatSocket(io: SocketIOServer): void {
  io.on('connection', (socket: AuthenticatedSocket) => {
    // ── Typing indicator ──
    socket.on('chat:typing', async (data: { householdId: string }) => {
      if (!data?.householdId || typeof data.householdId !== 'string') return;
      if (!requireHouseholdAccess(socket, data.householdId)) return;
      if (!(await isSocketEntitled(socket))) return;

      socket.to(`household:${data.householdId}`).emit('chat:typing', {
        userId: socket.data.userId,
      });
    });

    socket.on('chat:stop-typing', async (data: { householdId: string }) => {
      if (!data?.householdId || typeof data.householdId !== 'string') return;
      if (!requireHouseholdAccess(socket, data.householdId)) return;
      if (!(await isSocketEntitled(socket))) return;

      socket.to(`household:${data.householdId}`).emit('chat:stop-typing', {
        userId: socket.data.userId,
      });
    });

    // ── Open conversation tracking (suppresses push for the viewer) ──
    socket.on('chat:viewing', async (data: { conversationId: string }) => {
      if (!data?.conversationId || typeof data.conversationId !== 'string') return;
      const participant = await ConversationParticipant.findOne({
        where: { conversationId: data.conversationId, userId: socket.data.userId },
      });
      if (!participant) return;
      socket.data.viewingConversationId = data.conversationId;
    });

    socket.on('chat:left', () => {
      socket.data.viewingConversationId = null;
    });

    // ── Message read receipt ──
    socket.on(
      'chat:read',
      async (data: { householdId: string; messageId: string }) => {
        if (!data?.householdId || typeof data.householdId !== 'string') return;
        if (!data?.messageId || typeof data.messageId !== 'string') return;
        if (!requireHouseholdAccess(socket, data.householdId)) return;
        if (!(await isSocketEntitled(socket))) return;

        socket.to(`household:${data.householdId}`).emit('chat:read', {
          userId: socket.data.userId,
          messageId: data.messageId,
        });
      },
    );

    // ── Presence / online status ──
    socket.on('presence:online', async (data: { householdId: string }) => {
      if (!data?.householdId || typeof data.householdId !== 'string') return;
      if (!requireHouseholdAccess(socket, data.householdId)) return;
      if (!(await isSocketEntitled(socket))) return;

      socket.to(`household:${data.householdId}`).emit('presence:online', {
        userId: socket.data.userId,
      });
    });
  });

  logger.info('✓ Chat socket handlers registered (household-scoped with auth guards)');
}
