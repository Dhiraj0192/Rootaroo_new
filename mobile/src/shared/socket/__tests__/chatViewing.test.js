const mockHandlers = {};
const mockSocket = {
  connected: true,
  emit: jest.fn(),
  on: jest.fn((event, fn) => { mockHandlers[event] = fn; }),
  off: jest.fn(),
};
jest.mock('../../socket', () => ({ getSocket: jest.fn(() => mockSocket) }));

const { getSocket } = require('../../socket');
const { setViewingConversation, __resetChatViewingForTests } = require('../chatSocket');

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of Object.keys(mockHandlers)) delete mockHandlers[k];
  __resetChatViewingForTests();
});

describe('setViewingConversation', () => {
  it('tells the server which conversation is open, so it skips pushes for it', () => {
    setViewingConversation('c1');
    expect(mockSocket.emit).toHaveBeenCalledWith('chat:viewing', { conversationId: 'c1' });
  });

  it('tells the server when the conversation is closed', () => {
    setViewingConversation('c1');
    setViewingConversation(null);
    expect(mockSocket.emit).toHaveBeenLastCalledWith('chat:left');
  });

  it('re-sends the open conversation after the socket reconnects', () => {
    setViewingConversation('c1');
    mockSocket.emit.mockClear();
    mockHandlers.connect();
    expect(mockSocket.emit).toHaveBeenCalledWith('chat:viewing', { conversationId: 'c1' });
  });

  it('does nothing on reconnect when no conversation is open', () => {
    setViewingConversation('c1');
    setViewingConversation(null);
    mockSocket.emit.mockClear();
    if (mockHandlers.connect) mockHandlers.connect();
    expect(mockSocket.emit).not.toHaveBeenCalled();
  });

  it('is safe without a socket', () => {
    getSocket.mockReturnValueOnce(null);
    expect(() => setViewingConversation('c1')).not.toThrow();
  });
});
