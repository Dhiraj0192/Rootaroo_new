jest.mock('../../api/chat', () => ({
  chatApi: { list: jest.fn(async () => ({ messages: [{ id: 'm0', conversationId: 'c1' }], nextCursor: null, hasMore: false })) },
}));

const { useChatStore } = require('../chatStore');

beforeEach(() => {
  useChatStore.setState({ messages: [], activeConversationId: null });
});

describe('chatStore live messages', () => {
  it('remembers which conversation is loaded', async () => {
    await useChatStore.getState().fetchMessages('c1');
    expect(useChatStore.getState().activeConversationId).toBe('c1');
  });

  it('adds a live message for the open conversation', async () => {
    await useChatStore.getState().fetchMessages('c1');
    useChatStore.getState().prependMessage({ id: 'm1', conversationId: 'c1' });
    expect(useChatStore.getState().messages.map((m) => m.id)).toEqual(['m1', 'm0']);
  });

  it('ignores live messages from other conversations (the socket now delivers all of them)', async () => {
    await useChatStore.getState().fetchMessages('c1');
    useChatStore.getState().prependMessage({ id: 'x1', conversationId: 'c2' });
    expect(useChatStore.getState().messages.map((m) => m.id)).toEqual(['m0']);
  });

  it('still drops duplicates', async () => {
    await useChatStore.getState().fetchMessages('c1');
    useChatStore.getState().prependMessage({ id: 'm0', conversationId: 'c1' });
    expect(useChatStore.getState().messages).toHaveLength(1);
  });
});
