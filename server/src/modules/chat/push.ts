import { ConversationParticipant } from '../../database/models';
import redis from '../../config/redis';
import { getIO } from '../../shared/utils/socket';
import { sendToUser } from '../notification/service';
import logger from '../../shared/utils/logger';

export const CHAT_PUSH_THROTTLE_SECONDS = 30;

export function messagePreview(type: 'text' | 'image' | 'voice', content: string | null): string {
  if (type === 'voice') return '🎤 Voice message';
  if (type === 'image') return content ? `📷 ${content}` : '📷 Photo';
  const text = content || '';
  return text.length > 100 ? `${text.slice(0, 99)}…` : text;
}

async function participantIds(conversationId: string): Promise<string[]> {
  const rows = await ConversationParticipant.findAll({ where: { conversationId } });
  return rows.map((r) => r.userId);
}

/**
 * Sockets only ever join `user:{id}` and `household:{id}` rooms (see
 * socketAuth.ts) — nobody joins a conversation-id room, so chat events are
 * fanned out to each participant's personal room instead.
 */
export async function broadcastToParticipants(
  conversationId: string,
  event: string,
  payload: unknown,
): Promise<void> {
  try {
    const ids = await participantIds(conversationId);
    const io = getIO();
    for (const id of ids) io.to(`user:${id}`).emit(event, payload);
  } catch {
    /* socket not available */
  }
}

/**
 * Which of the user's devices have this chat open. `all` means every connected
 * socket is viewing it, so there is nobody left to notify.
 */
async function viewingState(userId: string, conversationId: string): Promise<{ all: boolean; viewingDeviceIds: string[] }> {
  try {
    const sockets = await getIO().in(`user:${userId}`).fetchSockets();
    const viewing = sockets.filter((s) => s.data?.viewingConversationId === conversationId);
    const viewingDeviceIds = [...new Set(viewing.map((s) => s.data?.deviceId as string | undefined).filter((d): d is string => !!d))];
    return { all: sockets.length > 0 && viewing.length === sockets.length, viewingDeviceIds };
  } catch {
    return { all: false, viewingDeviceIds: [] };
  }
}

/** Throttle so a burst of messages produces one push; fail open if Redis is down. */
async function claimPushSlot(conversationId: string, userId: string): Promise<boolean> {
  try {
    const res = await redis.set(
      `push:chat:${conversationId}:${userId}`, '1', 'EX', CHAT_PUSH_THROTTLE_SECONDS, 'NX',
    );
    return res !== null;
  } catch {
    return true;
  }
}

export async function notifyChatMessage(args: {
  conversationId: string;
  senderId: string;
  senderName: string;
  type: 'text' | 'image' | 'voice';
  content: string | null;
}): Promise<void> {
  try {
    const { conversationId, senderId, senderName, type, content } = args;
    const recipients = (await participantIds(conversationId)).filter((id) => id !== senderId);
    const preview = messagePreview(type, content);
    await Promise.all(recipients.map(async (userId) => {
      const { all, viewingDeviceIds } = await viewingState(userId, conversationId);
      if (all) return;
      if (!(await claimPushSlot(conversationId, userId))) return;
      // Other devices still get the push; only the one looking at the chat is muted.
      const options = viewingDeviceIds.length > 0
        ? { skipHistory: true, excludeDeviceIds: viewingDeviceIds }
        : { skipHistory: true };
      await sendToUser(userId, 'chat', senderName, preview, { type: 'chat', conversationId }, options)
        .catch((e: Error) => logger.warn('[Push] Chat notify failed:', e.message));
    }));
  } catch (e) {
    logger.warn('[Push] Chat notify failed:', (e as Error).message);
  }
}
