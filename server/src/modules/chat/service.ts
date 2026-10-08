import { Op, QueryTypes } from 'sequelize';
import { v4 as uuidv4 } from 'uuid';
import {
  sequelize,
  ChatMessage,
  ChatReaction,
  Conversation,
  ConversationParticipant,
  FeedMedia,
  FeedPost,
  HouseholdMember,
  User,
} from '../../database/models';
import { NotFoundError, ForbiddenError, ValidationError } from '../../shared/utils/errors';
import { assertOwnUploadKey } from '../../shared/utils/uploadKeys';
import { getUserHousehold as getUserHouseholdCore } from '../../shared/utils/household';
import { getSignedUrl } from '../../shared/utils/s3';
import { getIO } from '../../shared/utils/socket';
import { broadcastToParticipants, notifyChatMessage } from './push';
import type {
  ChatReactionType,
  ConversationResponse,
  CreateConversationBody,
  CreateMessageBody,
  MessageQuery,
  MessageResponse,
  PaginatedMessagesResponse,
  ReactionCountResponse,
} from './types';

const ALLOWED_REACTIONS: ChatReactionType[] = ['👍', '❤️', '😂', '😲', '😢'];

// ── Conversation Helpers ──

async function toConversationResponse(
  conv: Conversation,
  unreadCount = 0,
): Promise<ConversationResponse> {
  const participants = (conv.get('participants') as User[]) || [];
  const lastMsg = (conv.get('messages') as ChatMessage[])?.[0] || null;
  return {
    id: conv.id,
    householdId: conv.householdId,
    type: conv.type,
    name: conv.name,
    createdBy: conv.createdBy,
    participants: await Promise.all(participants.map(async (u: User) => ({
      id: u.id,
      displayName: u.displayName,
      avatarUrl: await getSignedUrl(u.avatarUrl),
    }))),
    lastMessage: lastMsg
      ? {
          content: lastMsg.content,
          type: lastMsg.type || 'text',
          createdAt: lastMsg.createdAt.toISOString(),
          senderName: (lastMsg.get('sender') as User)?.displayName || 'Unknown',
        }
      : null,
    unreadCount,
    createdAt: conv.createdAt.toISOString(),
  };
}

export async function createConversation(
  userId: string,
  body: CreateConversationBody,
): Promise<ConversationResponse> {
  const householdId = await ensureHouseholdMember(userId);

  // Every participant added here must belong to the caller's own household
  // — otherwise a caller could stamp an arbitrary user id (from any
  // household) onto a conversation tagged with their own householdId,
  // bypassing tenant isolation entirely (M-02).
  const otherParticipantIds = body.participantIds.filter((id) => id !== userId);
  if (otherParticipantIds.length > 0) {
    const memberships = await HouseholdMember.findAll({
      where: { userId: { [Op.in]: otherParticipantIds }, householdId },
    });
    if (memberships.length !== otherParticipantIds.length) {
      throw new ForbiddenError('All participants must belong to your household');
    }
  }

  // For DMs, check if a conversation already exists between these users
  if (body.type === 'dm' && body.participantIds.length === 1) {
    const otherUserId = body.participantIds[0];
    // Query participants to find conversations where both users participate
    const myParts = await ConversationParticipant.findAll({ where: { userId } });
    const otherParts = await ConversationParticipant.findAll({ where: { userId: otherUserId } });
    const myConvIds = new Set(myParts.map((p) => p.conversationId));
    const commonConvIds = otherParts.filter((p) => myConvIds.has(p.conversationId)).map((p) => p.conversationId);

    for (const cid of commonConvIds) {
      const parts = await ConversationParticipant.findAll({ where: { conversationId: cid } });
      const partIds = parts.map((p) => p.userId);
      if (partIds.length === 2 && partIds.includes(userId) && partIds.includes(otherUserId)) {
        const convType = await Conversation.findByPk(cid, { attributes: ['type'] });
        if (convType && convType.type === 'dm') {
          const full = await Conversation.findByPk(cid, {
            include: [
              { model: User, as: 'participants' },
              { model: ChatMessage, as: 'messages', limit: 1, order: [['createdAt', 'DESC']], include: [{ model: User, as: 'sender' }] },
            ],
          });
          if (full) return await toConversationResponse(full);
        }
      }
    }
  }

  // 'household' conversations are singletons — one per household, membership
  // auto-synced with actual household membership elsewhere (household join/
  // leave/remove flows). Reuse the existing one instead of creating a
  // duplicate if a member has already started it.
  if (body.type === 'household') {
    const existing = await Conversation.findOne({ where: { householdId, type: 'household' } });
    if (existing) {
      const full = await Conversation.findByPk(existing.id, {
        include: [
          { model: User, as: 'participants' },
          { model: ChatMessage, as: 'messages', limit: 1, order: [['createdAt', 'DESC']], include: [{ model: User, as: 'sender' }] },
        ],
      });
      if (full) return await toConversationResponse(full);
    }
  }

  const conv = await Conversation.create({
    id: uuidv4(),
    householdId,
    type: body.type,
    name: body.name || null,
    createdBy: userId,
  });

  // Add all participants including the creator
  const allParticipantIds = [...new Set([userId, ...body.participantIds])];
  await ConversationParticipant.bulkCreate(
    allParticipantIds.map((uid) => ({
      id: uuidv4(),
      conversationId: conv.id,
      userId: uid,
    })),
  );

  const full = await Conversation.findByPk(conv.id, {
    include: [
      { model: User, as: 'participants' },
      {
        model: ChatMessage,
        as: 'messages',
        limit: 1,
        order: [['createdAt', 'DESC']],
        include: [{ model: User, as: 'sender' }],
      },
    ],
  });
  if (!full) throw new Error('Failed to create conversation');

  // Join socket room for all participants
  await joinSocketsToRoom(conv.id, allParticipantIds);

  return await toConversationResponse(full);
}

/** Join any currently-connected sockets for the given users to a socket room. */
async function joinSocketsToRoom(roomId: string, userIds: string[]): Promise<void> {
  try {
    const sockets = await getIO().fetchSockets();
    for (const s of sockets) {
      if (s.data.userId && userIds.includes(s.data.userId)) s.join(roomId);
    }
  } catch {
    /* ignore */
  }
}

/** Reuse an existing DM between two users, or create a new one. */
async function getOrCreateDm(
  userIdA: string,
  userIdB: string,
  householdId: string,
): Promise<Conversation> {
  const aParts = await ConversationParticipant.findAll({ where: { userId: userIdA } });
  const bParts = await ConversationParticipant.findAll({ where: { userId: userIdB } });
  const aConvIds = new Set(aParts.map((p) => p.conversationId));
  const commonIds = bParts
    .filter((p) => aConvIds.has(p.conversationId))
    .map((p) => p.conversationId);

  for (const cid of commonIds) {
    const parts = await ConversationParticipant.findAll({ where: { conversationId: cid } });
    if (parts.length !== 2) continue;
    const partIds = parts.map((p) => p.userId);
    if (!partIds.includes(userIdA) || !partIds.includes(userIdB)) continue;

    const conv = await Conversation.findByPk(cid);
    if (conv && conv.type === 'dm') return conv;
  }

  const conv = await Conversation.create({
    id: uuidv4(),
    householdId,
    type: 'dm',
    name: null,
    createdBy: userIdA,
  });
  await ConversationParticipant.bulkCreate([
    { id: uuidv4(), conversationId: conv.id, userId: userIdA },
    { id: uuidv4(), conversationId: conv.id, userId: userIdB },
  ]);
  await joinSocketsToRoom(conv.id, [userIdA, userIdB]);
  return conv;
}

export async function getUserConversations(userId: string): Promise<ConversationResponse[]> {
  const householdId = await ensureHouseholdMember(userId);

  // Find conversations where user is a participant
  const participations = await ConversationParticipant.findAll({
    where: { userId },
    attributes: ['conversationId'],
  });
  const convIds = participations.map((p) => p.conversationId);

  if (convIds.length === 0) return [];

  const convs = await Conversation.findAll({
    where: { id: convIds, householdId },
    include: [
      { model: User, as: 'participants' },
      {
        model: ChatMessage,
        as: 'messages',
        limit: 1,
        order: [['createdAt', 'DESC']],
        include: [{ model: User, as: 'sender' }],
      },
    ],
    order: [['createdAt', 'DESC']],
  });

  const unreadByConvId = await getUnreadCounts(userId, convs.map((c) => c.id));
  return Promise.all(convs.map((conv) => toConversationResponse(conv, unreadByConvId.get(conv.id) || 0)));
}

/**
 * Unread counts for all of a user's conversations in ONE grouped query,
 * instead of one COUNT per conversation (which also competed for the
 * 10-connection pool on app open). Mirrors the old per-conversation
 * ChatMessage.count exactly: messages from others, newer than this user's
 * lastReadAt (or all, if never read), excluding soft-deleted messages —
 * ChatMessage is paranoid, which the raw query has to spell out.
 */
async function getUnreadCounts(userId: string, conversationIds: string[]): Promise<Map<string, number>> {
  if (conversationIds.length === 0) return new Map();
  const rows = await sequelize.query<{ conversationId: string; unread: number | string }>(
    `SELECT m.conversation_id AS conversationId, COUNT(*) AS unread
       FROM chat_messages m
       JOIN conversation_participants p
         ON p.conversation_id = m.conversation_id AND p.user_id = :userId
      WHERE m.conversation_id IN (:conversationIds)
        AND m.sender_id <> :userId
        AND m.deleted_at IS NULL
        AND m.created_at > COALESCE(p.last_read_at, '1970-01-01')
      GROUP BY m.conversation_id`,
    { replacements: { userId, conversationIds }, type: QueryTypes.SELECT },
  );
  return new Map(rows.map((r) => [r.conversationId, Number(r.unread)]));
}

/** Marks a conversation as read up to now for this user — resets its unread count to 0. */
export async function markConversationRead(userId: string, conversationId: string): Promise<void> {
  const participant = await ConversationParticipant.findOne({
    where: { conversationId, userId },
  });
  if (!participant) throw new NotFoundError('Conversation');
  await participant.update({ lastReadAt: new Date() });
}

// ── Helpers ──

async function ensureHouseholdMember(userId: string): Promise<string> {
  return getUserHouseholdCore(userId, 'You must belong to a household to send messages');
}

async function isHouseholdAdmin(userId: string, householdId: string): Promise<boolean> {
  const membership = await HouseholdMember.findOne({ where: { userId, householdId } });
  return membership?.role === 'admin';
}

async function assertCanManageParticipants(
  conversationId: string,
  requesterId: string,
  action: string,
): Promise<Conversation> {
  const householdId = await ensureHouseholdMember(requesterId);
  const conv = await Conversation.findOne({ where: { id: conversationId, householdId } });
  if (!conv) throw new NotFoundError('Conversation');
  const creator = conv.createdBy === requesterId;
  const admin = await isHouseholdAdmin(requesterId, householdId);
  if (!creator && !admin) {
    throw new ForbiddenError(`Only the group admin can ${action} members`);
  }
  return conv;
}

async function toSenderResponse(
  user: User | null,
): Promise<{ id: string; displayName: string; avatarUrl: string | null; avatarEmoji: string | null } | null> {
  if (!user) return null;
  return {
    id: user.get('id') as string,
    displayName: (user.get('displayName') as string) || 'Unknown',
    avatarUrl: await getSignedUrl(user.get('avatarUrl') as string | null),
    avatarEmoji: user.get('avatarEmoji') as string | null,
  };
}

async function toMessageResponse(msg: ChatMessage): Promise<MessageResponse> {
  const sender = (msg.get('sender') as User) || null;
  const reactions = (msg.get('reactions') as ChatReaction[]) || [];
  const replies = (msg.get('replies') as ChatMessage[]) || [];
  const replyCount = replies.length;

  // Build reaction counts
  const reactionCounts = ALLOWED_REACTIONS.map((emoji) => ({
    emoji,
    count: reactions.filter((r) => r.reaction === emoji).length,
    userReacted: false, // caller fills this in
  }));

  let replyPreview: MessageResponse['replyPreview'] = null;
  const replyToId = msg.get('replyToId') as string | null;
  if (replyToId) {
    // Fetch replied-to message for preview
    const replyToMsg = await ChatMessage.findByPk(replyToId, {
      include: [{ model: User, as: 'sender', attributes: ['id', 'displayName', 'avatarUrl', 'avatarEmoji'] }],
    });
    if (replyToMsg) {
      const replySender = (replyToMsg.get('sender') as User) || null;
      replyPreview = {
        id: replyToId,
        content: replyToMsg.get('content') as string | null,
        senderName: (replySender?.get('displayName') as string) || 'Unknown',
      };
    }
  }

  return {
    id: msg.get('id') as string,
    householdId: msg.get('householdId') as string,
    senderId: msg.get('senderId') as string,
    sender: (await toSenderResponse(sender)) || { id: '', displayName: 'Deleted', avatarUrl: null, avatarEmoji: null },
    content: msg.get('content') as string | null,
    mediaUrl: await getSignedUrl(msg.get('mediaUrl') as string | null),
    type: msg.get('type') as 'text' | 'image' | 'voice',
    durationSeconds: msg.get('durationSeconds') as number | null,
    replyToId,
    replyPreview,
    reactions: reactionCounts,
    replyCount,
    editedAt: (msg.get('editedAt') as Date | null)?.toISOString() || null,
    createdAt: (msg.get('createdAt') as Date).toISOString(),
    updatedAt: (msg.get('updatedAt') as Date).toISOString(),
    deletedAt: (msg.get('deletedAt') as Date | null)?.toISOString() || null,
  };
}

// ── Send Message (FR-140) ──

export async function sendMessage(
  userId: string,
  body: CreateMessageBody,
): Promise<MessageResponse> {
  const householdId = await ensureHouseholdMember(userId);

  // Verify user is a participant in the conversation
  const participant = await ConversationParticipant.findOne({
    where: { conversationId: body.conversationId, userId },
  });
  if (!participant) throw new ForbiddenError('You are not a participant in this conversation');

  if (!body.content && (!body.mediaIds || body.mediaIds.length === 0) && !body.mediaUrl) {
    throw new ValidationError('Message must contain content or media');
  }

  // Checked before anything is written: the key is later signed into a link.
  if (body.mediaUrl) assertOwnUploadKey(body.mediaUrl, userId, ['chat/voice', 'chat/image']);

  let mediaUrl: string | null = null;
  let type: 'text' | 'image' | 'voice' = 'text';
  let durationSeconds: number | null = null;

  // FR-143: Attach media from feed upload. FeedMedia has no householdId
  // column of its own (it's denormalized on FeedPost) — filtering
  // `where: { householdId }` directly on FeedMedia queried a column that
  // doesn't exist. Scope through the FeedPost association instead (F-17).
  if (body.mediaIds && body.mediaIds.length > 0) {
    const medias = await FeedMedia.findAll({
      where: { id: { [Op.in]: body.mediaIds } },
      include: [{ model: FeedPost, as: 'post', where: { householdId }, attributes: [] }],
    });
    if (medias.length > 0) {
      mediaUrl = medias[0].get('mediaUrl') as string;
      type = 'image';
    }
  } else if (body.mediaUrl) {
    // Voice message — uploaded directly via POST /chat/media/voice
    mediaUrl = body.mediaUrl;
    type = body.type === 'voice' ? 'voice' : 'image';
    durationSeconds = body.durationSeconds ?? null;
  }

  // FR-144: Validate replyTo exists
  if (body.replyToId) {
    const parentMsg = await ChatMessage.findByPk(body.replyToId);
    if (!parentMsg) throw new NotFoundError('Message to reply to not found');
  }

  const msg = await ChatMessage.create({
    householdId,
    conversationId: body.conversationId,
    senderId: userId,
    content: body.content || null,
    mediaUrl,
    type,
    durationSeconds,
    replyToId: body.replyToId || null,
  });

  // Reload with associations
  const saved = await ChatMessage.findByPk(msg.get('id') as string, {
    include: [
      { model: User, as: 'sender', attributes: ['id', 'displayName', 'avatarUrl', 'avatarEmoji'] },
      { model: ChatReaction, as: 'reactions' },
      { model: ChatMessage, as: 'replies', attributes: ['id'] },
    ],
  });
  if (!saved) throw new Error('Message not found after create');

  const response = await toMessageResponse(saved);

  // FR-141: Broadcast via Socket.io to each participant's personal room
  await broadcastToParticipants(body.conversationId, 'new_message', response);
  void notifyChatMessage({
    conversationId: body.conversationId,
    senderId: userId,
    senderName: response.sender.displayName,
    type,
    content: body.content || null,
  });

  return response;
}

// ── List Messages (FR-140) ──

export async function listMessages(
  userId: string,
  query: MessageQuery,
): Promise<PaginatedMessagesResponse> {
  const householdId = await ensureHouseholdMember(userId);
  const limit = Math.min(query.limit || 30, 50);

  const where: any = {};
  if (query.conversationId) {
    // A conversation lookup here is not implicitly household-scoped — it
    // must also confirm the caller is actually a participant, otherwise
    // any household member could pass an arbitrary/foreign conversationId
    // and read messages (including other members' DMs) they're not part
    // of (F-04).
    const participant = await ConversationParticipant.findOne({
      where: { conversationId: query.conversationId, userId },
    });
    if (!participant) {
      throw new ForbiddenError('You are not a participant in this conversation');
    }
    where.conversationId = query.conversationId;
  } else {
    // Omitting conversationId is meant as a convenience for fetching the
    // household-wide "Everyone" chat without the client needing to know
    // its id ahead of time — NOT a way to browse every message in the
    // household regardless of conversation. Filtering by householdId
    // alone (the previous behavior) matched messages from every
    // conversation, including private DMs/groups the caller isn't a
    // participant in (same vulnerability class as F-04, just in this
    // branch instead of the explicit-conversationId one above).
    const householdConv = await Conversation.findOne({ where: { householdId, type: 'household' } });
    // No household conversation created yet — nothing to return, not an
    // error (conversationId: null matches zero rows, never a real message).
    where.conversationId = householdConv ? householdConv.id : null;
  }
  if (query.cursor) {
    where.createdAt = { [Op.lt]: new Date(query.cursor) };
  }

  const messages = await ChatMessage.findAll({
    where,
    include: [
      { model: User, as: 'sender', attributes: ['id', 'displayName', 'avatarUrl', 'avatarEmoji'] },
      { model: ChatReaction, as: 'reactions' },
      { model: ChatMessage, as: 'replies', attributes: ['id'] },
    ],
    order: [['createdAt', 'DESC']],
    limit: limit + 1,
  });

  const hasMore = messages.length > limit;
  const slice = hasMore ? messages.slice(0, limit) : messages;

  const messageResponses = await Promise.all(slice.map((m) => toMessageResponse(m)));

  // Fill in userReacted after building responses
  const userReactions = await ChatReaction.findAll({
    where: {
      userId,
      messageId: { [Op.in]: slice.map((m) => m.get('id') as string) },
    },
  });
  const userReactedSet = new Set(userReactions.map((r) => `${r.messageId}:${r.reaction}`));

  for (const resp of messageResponses) {
    for (const r of resp.reactions) {
      r.userReacted = userReactedSet.has(`${resp.id}:${r.emoji}`);
    }
  }

  const nextCursor = hasMore
    ? slice[slice.length - 1].get('createdAt')?.toISOString() || null
    : null;

  return { messages: messageResponses, nextCursor, hasMore };
}

// ── Get Message By ID ──

export async function getMessageById(
  messageId: string,
  userId: string,
): Promise<MessageResponse> {
  const householdId = await ensureHouseholdMember(userId);

  const msg = await ChatMessage.findOne({
    where: { id: messageId, householdId },
    include: [
      { model: User, as: 'sender', attributes: ['id', 'displayName', 'avatarUrl', 'avatarEmoji'] },
      { model: ChatReaction, as: 'reactions' },
      { model: ChatMessage, as: 'replies', attributes: ['id'] },
    ],
  });
  if (!msg) throw new NotFoundError('Message not found');

  // householdId scoping alone doesn't prove the caller is in this specific
  // conversation — a household DM between two other members would still
  // be readable by any third member who knows/guesses the message id.
  const conversationId = msg.get('conversationId') as string;
  const participant = await ConversationParticipant.findOne({
    where: { conversationId, userId },
  });
  if (!participant) {
    throw new ForbiddenError('You are not a participant in this conversation');
  }

  const response = await toMessageResponse(msg);

  // Check user reactions
  const userReactions = await ChatReaction.findAll({ where: { userId, messageId } });
  for (const r of response.reactions) {
    r.userReacted = userReactions.some((ur) => ur.reaction === r.emoji);
  }

  return response;
}

// ── Update Message (FR-150: not E2EE) ──

export async function updateMessage(
  messageId: string,
  userId: string,
  userRole: string,
  body: { content?: string },
): Promise<MessageResponse> {
  const householdId = await ensureHouseholdMember(userId);

  const msg = await ChatMessage.findOne({ where: { id: messageId, householdId } });
  if (!msg) throw new NotFoundError('Message not found');

  const conversationId = msg.get('conversationId') as string;

  // FR-150: Self-only edit
  const senderId = msg.get('senderId') as string;
  if (senderId !== userId && userRole !== 'admin') {
    throw new ForbiddenError('Only the sender can edit a message');
  }

  await msg.update({
    content: body.content || msg.get('content'),
    editedAt: new Date(),
  });

  const saved = await ChatMessage.findByPk(messageId, {
    include: [
      { model: User, as: 'sender', attributes: ['id', 'displayName', 'avatarUrl', 'avatarEmoji'] },
      { model: ChatReaction, as: 'reactions' },
      { model: ChatMessage, as: 'replies', attributes: ['id'] },
    ],
  });
  if (!saved) throw new NotFoundError('Message not found after update');

  const response = await toMessageResponse(saved);

  await broadcastToParticipants(conversationId, 'message_edited', response);

  return response;
}

// ── Delete Message (FR-145, FR-146) ──

export async function deleteMessage(
  messageId: string,
  userId: string,
  userRole: string,
): Promise<void> {
  const householdId = await ensureHouseholdMember(userId);

  const msg = await ChatMessage.findOne({ where: { id: messageId, householdId } });
  if (!msg) throw new NotFoundError('Message not found');

  const senderId = msg.get('senderId') as string;
  const conversationId = msg.get('conversationId') as string;
  const isOwn = senderId === userId;
  const isAdmin = userRole === 'admin';

  // Allow user to delete their own message, or admin/conversation participant
  if (!isOwn && !isAdmin) {
    const participant = await ConversationParticipant.findOne({ where: { conversationId, userId } });
    if (!participant) {
      throw new ForbiddenError('You can only delete messages in your conversations');
    }
  }

  await sequelize.transaction(async (transaction) => {
    await ChatReaction.destroy({ where: { messageId }, transaction });
    await msg.destroy({ force: true, transaction });
  });

  await broadcastToParticipants(conversationId, 'message_deleted', {
    id: messageId,
    hardDelete: true,
  });
}

// ── Add Reaction (FR-148) ──

export async function addReaction(
  messageId: string,
  userId: string,
  emoji: ChatReactionType,
): Promise<ReactionCountResponse[]> {
  await ensureHouseholdMember(userId);

  const msg = await ChatMessage.findByPk(messageId);
  if (!msg) throw new NotFoundError('Message not found');
  if (!ALLOWED_REACTIONS.includes(emoji)) throw new ValidationError('Invalid reaction');

  // Upsert reaction
  await ChatReaction.upsert({
    messageId,
    userId,
    reaction: emoji,
  });

  const reactions = await getReactions(messageId);

  await broadcastToParticipants(msg.get('conversationId') as string, 'reaction_added', { messageId, reactions, userId, emoji });

  return reactions;
}

// ── Remove Reaction ──

export async function removeReaction(
  messageId: string,
  userId: string,
  emoji: ChatReactionType,
): Promise<ReactionCountResponse[]> {
  await ensureHouseholdMember(userId);

  await ChatReaction.destroy({
    where: { messageId, userId, reaction: emoji },
  });

  const reactions = await getReactions(messageId);

  try {
    const msg = await ChatMessage.findByPk(messageId);
    if (msg) {
      await broadcastToParticipants(msg.get('conversationId') as string, 'reaction_removed', { messageId, reactions, userId, emoji });
    }
  } catch {
    /* ignore */
  }

  return reactions;
}

// ── Get Reactions ──

export async function getReactions(messageId: string): Promise<ReactionCountResponse[]> {
  const allReactions = await ChatReaction.findAll({ where: { messageId } });

  const counts = ALLOWED_REACTIONS.map((emoji) => {
    const users = allReactions.filter((r) => r.reaction === emoji);
    return { emoji, count: users.length, userReacted: false };
  });

  return counts;
}

// Typing indicator: handled entirely via the 'chat:typing'/'chat:stop-typing'
// socket events in socket/chatSocket.ts, which correctly broadcast to
// `household:${householdId}` — the room clients actually join. A REST
// typingStart/typingStop pair used to live here too, but broadcast to the
// bare householdId (no prefix), reaching zero connected clients; removed
// rather than fixed, since the socket-event path was already correct and
// is the one actually used (F-17).

// ── Participant Management ──

export async function addParticipant(
  conversationId: string,
  userId: string,
  requesterId: string,
): Promise<void> {
  const conv = await assertCanManageParticipants(conversationId, requesterId, 'add');

  // Unlike inviteToGroup, this path had no check that the target actually
  // belongs to the caller's household — letting a creator/admin add an
  // arbitrary user id (from any household) as a participant (M-02).
  const targetMembership = await HouseholdMember.findOne({
    where: { userId, householdId: conv.householdId },
  });
  if (!targetMembership) {
    throw new ForbiddenError('You can only add members of your household');
  }

  await ConversationParticipant.findOrCreate({
    where: { conversationId, userId },
    defaults: { id: uuidv4(), conversationId, userId },
  });
}

/**
 * Add a household member to a group conversation and DM them an invite
 * message for that group (not a household invite).
 */
export async function inviteToGroup(
  conversationId: string,
  targetUserId: string,
  requesterId: string,
): Promise<void> {
  const conv = await assertCanManageParticipants(conversationId, requesterId, 'add');

  // Only household members can be added to this group
  const targetMembership = await HouseholdMember.findOne({
    where: { userId: targetUserId, householdId: conv.householdId },
  });
  if (!targetMembership) {
    throw new ForbiddenError('You can only add members of your household');
  }

  // Add them to the group
  await ConversationParticipant.findOrCreate({
    where: { conversationId, userId: targetUserId },
    defaults: { id: uuidv4(), conversationId, userId: targetUserId },
  });

  // DM them an invite message for this group
  const dm = await getOrCreateDm(requesterId, targetUserId, conv.householdId);
  const requester = await User.findByPk(requesterId, { attributes: ['id', 'displayName'] });
  const requesterName = (requester?.get('displayName') as string) || 'Someone';
  const groupName = conv.name || 'this group';

  await sendMessage(requesterId, {
    conversationId: dm.id,
    content: `${requesterName} invited you to join the group "${groupName}".`,
  });
}

export async function removeParticipant(
  conversationId: string,
  userId: string,
  requesterId: string,
): Promise<void> {
  await assertCanManageParticipants(conversationId, requesterId, 'remove');
  await ConversationParticipant.destroy({ where: { conversationId, userId } });
}

export async function deleteConversation(
  conversationId: string,
  userId: string,
): Promise<void> {
  const householdId = await ensureHouseholdMember(userId);
  const conv = await Conversation.findOne({ where: { id: conversationId, householdId } });
  if (!conv) throw new NotFoundError('Conversation not found');

  // Household scoping alone isn't an authorization check — any member
  // (including a child role) could otherwise hard-wipe the whole thread
  // and every other member's messages in it (M-01).
  if (conv.type === 'dm') {
    // DMs: only a participant can end it for themselves — no household-
    // admin override, since this hard-deletes both sides of what may be
    // private correspondence the admin isn't part of.
    const participant = await ConversationParticipant.findOne({ where: { conversationId, userId } });
    if (!participant) {
      throw new ForbiddenError('Only a participant of this conversation can delete it');
    }
  } else {
    const isCreator = conv.createdBy === userId;
    const isAdmin = await isHouseholdAdmin(userId, householdId);
    if (!isCreator && !isAdmin) {
      throw new ForbiddenError('Only the creator or a household admin can delete this conversation');
    }
  }

  await sequelize.transaction(async (transaction) => {
    const messages = await ChatMessage.findAll({ where: { conversationId }, attributes: ['id'], transaction });
    const msgIds = messages.map((m) => m.id);
    if (msgIds.length > 0) {
      await ChatReaction.destroy({ where: { messageId: { [Op.in]: msgIds } }, transaction });
      await ChatMessage.destroy({ where: { conversationId }, force: true, transaction });
    }
    await ConversationParticipant.destroy({ where: { conversationId }, transaction });
    await conv.destroy({ force: true, transaction });
  });
}
