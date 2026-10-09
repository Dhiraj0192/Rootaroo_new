jest.mock('../../database/models', () => ({
  ConversationParticipant: { findOne: jest.fn() },
}));
jest.mock('../../modules/billing/socketGate', () => ({ isSocketEntitled: jest.fn(async () => true) }));

import { ConversationParticipant } from '../../database/models';
import { registerChatSocket } from '../chatSocket';

type Handler = (data?: unknown) => Promise<void> | void;

function connect() {
  const handlers: Record<string, Handler> = {};
  const socket = {
    data: { userId: 'u1', householdId: 'h1' } as Record<string, unknown>,
    on: (event: string, fn: Handler) => { handlers[event] = fn; },
    emit: jest.fn(),
    to: jest.fn(() => ({ emit: jest.fn() })),
  };
  let onConnection: ((s: unknown) => void) | undefined;
  const io = { on: (_e: string, fn: (s: unknown) => void) => { onConnection = fn; } };
  registerChatSocket(io as never);
  onConnection!(socket);
  return { socket, handlers };
}

beforeEach(() => jest.clearAllMocks());

describe('chat:viewing / chat:left', () => {
  it('records the open conversation when the user is a participant', async () => {
    (ConversationParticipant.findOne as jest.Mock).mockResolvedValue({ id: 'p1' });
    const { socket, handlers } = connect();
    await handlers['chat:viewing']({ conversationId: 'c1' });
    expect(ConversationParticipant.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: { conversationId: 'c1', userId: 'u1' } }),
    );
    expect(socket.data.viewingConversationId).toBe('c1');
  });

  it('ignores conversations the user is not in', async () => {
    (ConversationParticipant.findOne as jest.Mock).mockResolvedValue(null);
    const { socket, handlers } = connect();
    await handlers['chat:viewing']({ conversationId: 'c-other' });
    expect(socket.data.viewingConversationId).toBeUndefined();
  });

  it('ignores malformed payloads', async () => {
    const { socket, handlers } = connect();
    await handlers['chat:viewing'](undefined);
    await handlers['chat:viewing']({ conversationId: 42 });
    expect(ConversationParticipant.findOne).not.toHaveBeenCalled();
    expect(socket.data.viewingConversationId).toBeUndefined();
  });

  it('clears it on chat:left', async () => {
    (ConversationParticipant.findOne as jest.Mock).mockResolvedValue({ id: 'p1' });
    const { socket, handlers } = connect();
    await handlers['chat:viewing']({ conversationId: 'c1' });
    await handlers['chat:left']();
    expect(socket.data.viewingConversationId).toBeNull();
  });
});
