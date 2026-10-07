import { getSocket } from '../socket';
import { useChatStore } from '../store/chatStore';

let listenersAttached = false;
let viewingConversationId = null;
let viewingListenerSocket = null;

export function registerChatSocket() {
  const socket = getSocket();
  if (!socket || listenersAttached) return;
  listenersAttached = true;

  const store = useChatStore.getState;

  // FR-141: New message from another user
  socket.on('new_message', (msg) => {
    useChatStore.getState().prependMessage(msg);
  });

  // FR-145/146: Message deleted
  socket.on('message_deleted', (data) => {
    useChatStore.getState().removeMessage(data.id);
  });

  // FR-150: Message edited
  socket.on('message_edited', (msg) => {
    useChatStore.getState().patchMessage(msg);
  });

  // FR-148: Reaction added
  socket.on('reaction_added', (data) => {
    useChatStore.getState().patchReactions(data.messageId, data.reactions);
  });

  // FR-148: Reaction removed
  socket.on('reaction_removed', (data) => {
    useChatStore.getState().patchReactions(data.messageId, data.reactions);
  });

  // FR-149: Typing indicator — event names must match what the server
  // actually emits (server/src/socket/chatSocket.ts broadcasts
  // 'chat:typing'/'chat:stop-typing', not 'typing_start'/'typing_stop' —
  // this mismatch meant received typing indicators were silently dropped).
  socket.on('chat:typing', (data) => {
    useChatStore.getState().addTypingUser(data);
  });

  socket.on('chat:stop-typing', (data) => {
    useChatStore.getState().removeTypingUser(data.userId);
  });
}

export function unregisterChatSocket() {
  const socket = getSocket();
  if (!socket) return;
  listenersAttached = false;
  socket.off('new_message');
  socket.off('message_deleted');
  socket.off('message_edited');
  socket.off('reaction_added');
  socket.off('reaction_removed');
  socket.off('chat:typing');
  socket.off('chat:stop-typing');
}

// Tells the server which conversation is open so it can skip pushes for it.
export function setViewingConversation(conversationId) {
  viewingConversationId = conversationId || null;
  const socket = getSocket();
  if (!socket) return;

  if (viewingListenerSocket !== socket) {
    viewingListenerSocket = socket;
    socket.on('connect', () => {
      if (viewingConversationId) {
        socket.emit('chat:viewing', { conversationId: viewingConversationId });
      }
    });
  }

  if (viewingConversationId) {
    socket.emit('chat:viewing', { conversationId: viewingConversationId });
  } else {
    socket.emit('chat:left');
  }
}

export function __resetChatViewingForTests() {
  viewingConversationId = null;
  viewingListenerSocket = null;
}
