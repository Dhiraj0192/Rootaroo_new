import { create } from 'zustand';
import { chatApi } from '../api/chat';

export const useChatStore = create((set, get) => ({
  messages: [],
  activeConversationId: null,
  cursor: null,
  hasMore: true,
  loading: false,
  refreshing: false,
  error: null,

  typingUsers: [],
  replyTo: null,

  fetchMessages: async (conversationId) => {
    set({ loading: true, error: null, messages: [], cursor: null, hasMore: true, activeConversationId: conversationId });
    try {
      const data = await chatApi.list({ conversationId, limit: 30 });
      set({
        messages: data.messages,
        cursor: data.nextCursor,
        hasMore: data.hasMore,
        loading: false,
      });
    } catch (e) {
      set({
        loading: false,
        error: e?.response?.data?.message || 'Failed to load messages',
      });
    }
  },

  fetchMoreMessages: async (conversationId) => {
    const { cursor, hasMore, loading, messages } = get();
    if (!hasMore || loading) return;

    set({ loading: true });
    try {
      const data = await chatApi.list({ conversationId, cursor: cursor || undefined, limit: 30 });
      set({
        messages: [...messages, ...data.messages],
        cursor: data.nextCursor,
        hasMore: data.hasMore,
        loading: false,
      });
    } catch {
      set({ loading: false });
    }
  },

  refreshMessages: async (conversationId) => {
    set({ refreshing: true, error: null });
    try {
      const data = await chatApi.list({ conversationId, limit: 30 });
      set({
        messages: data.messages,
        cursor: data.nextCursor,
        hasMore: data.hasMore,
        refreshing: false,
      });
    } catch (e) {
      set({
        refreshing: false,
        error: e?.response?.data?.message || 'Failed to refresh',
      });
    }
  },

  sendMessage: async (conversationId, body) => {
    try {
      const msg = await chatApi.send({ ...body, conversationId });
      set((state) => {
        if (state.messages.some((m) => m.id === msg.id)) return state;
        return { messages: [msg, ...state.messages], replyTo: null };
      });
    } catch (e) {
      throw new Error(e?.response?.data?.message || 'Failed to send message');
    }
  },

  deleteConversation: async (conversationId) => {
    try {
      await chatApi.deleteConversation(conversationId);
      set({ messages: [], cursor: null, hasMore: false });
    } catch (e) {
      throw new Error(e?.response?.data?.message || 'Failed to delete conversation');
    }
  },

  deleteMessage: async (messageId) => {
    try {
      await chatApi.remove(messageId);
      set((state) => ({
        messages: state.messages.filter((m) => m.id !== messageId),
      }));
    } catch (e) {
      throw new Error(e?.response?.data?.message || 'Failed to delete message');
    }
  },

  updateMessage: async (messageId, content) => {
    try {
      const updated = await chatApi.update(messageId, { content });
      set((state) => ({
        messages: state.messages.map((m) => (m.id === messageId ? updated : m)),
      }));
    } catch (e) {
      throw new Error(e?.response?.data?.message || 'Failed to update message');
    }
  },

  toggleReaction: async (messageId, emoji) => {
    const msg = get().messages.find((m) => m.id === messageId);
    if (!msg) return;

    const existing = msg.reactions.find((r) => r.emoji === emoji);
    const isReacted = existing?.userReacted ?? false;

    try {
      let reactions;
      if (isReacted) {
        reactions = await chatApi.removeReaction(messageId, emoji);
      } else {
        reactions = await chatApi.addReaction(messageId, emoji);
      }
      set((state) => ({
        messages: state.messages.map((m) => (m.id === messageId ? { ...m, reactions } : m)),
      }));
    } catch {
      // silently fail
    }
  },

  prependMessage: (message) => {
    set((state) => {
      // The socket delivers every conversation's messages; only the open one belongs here.
      if (state.activeConversationId && message.conversationId !== state.activeConversationId) return state;
      // Prevent duplicates from socket echo-back
      if (state.messages.some((m) => m.id === message.id)) return state;
      return { messages: [message, ...state.messages] };
    });
  },

  removeMessage: (messageId) => {
    set((state) => ({
      messages: state.messages.filter((m) => m.id !== messageId),
    }));
  },

  patchMessage: (message) => {
    set((state) => ({
      messages: state.messages.map((m) => (m.id === message.id ? message : m)),
    }));
  },

  patchReactions: (messageId, reactions) => {
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === messageId ? { ...m, reactions } : m
      ),
    }));
  },

  setReplyTo: (reply) => set({ replyTo: reply }),

  addTypingUser: (user) => {
    set((state) => {
      if (state.typingUsers.some((t) => t.userId === user.userId)) return state;
      return { typingUsers: [...state.typingUsers, user] };
    });
  },

  removeTypingUser: (userId) => {
    set((state) => ({
      typingUsers: state.typingUsers.filter((t) => t.userId !== userId),
    }));
  },

  clearTypingUsers: () => set({ typingUsers: [] }),
}));
