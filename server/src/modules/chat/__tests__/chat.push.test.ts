jest.mock('../../../database/models', () => ({
  ConversationParticipant: { findAll: jest.fn() },
}));
jest.mock('../../../config/redis', () => ({ __esModule: true, default: { set: jest.fn() } }));
jest.mock('../../notification/service', () => ({ sendToUser: jest.fn().mockResolvedValue(undefined) }));

const sockets: Record<string, Array<{ data: Record<string, unknown> }>> = {};
const emitted: Array<{ room: string; event: string; payload: unknown }> = [];
jest.mock('../../../shared/utils/socket', () => ({
  getIO: jest.fn(() => ({
    in: (room: string) => ({ fetchSockets: async () => sockets[room] || [] }),
    to: (room: string) => ({ emit: (event: string, payload: unknown) => emitted.push({ room, event, payload }) }),
  })),
}));

import { ConversationParticipant } from '../../../database/models';
import redis from '../../../config/redis';
import { sendToUser } from '../../notification/service';
import { getIO } from '../../../shared/utils/socket';
import { notifyChatMessage, messagePreview, broadcastToParticipants, CHAT_PUSH_THROTTLE_SECONDS } from '../push';

const conversationId = 'conv-1';
const sender = 'user-sender';
const alice = 'user-alice';
const bob = 'user-bob';

const participants = (...ids: string[]) =>
  (ConversationParticipant.findAll as jest.Mock).mockResolvedValue(ids.map((userId) => ({ userId })));

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of Object.keys(sockets)) delete sockets[k];
  emitted.length = 0;
  (redis.set as jest.Mock).mockResolvedValue('OK');
});

describe('messagePreview', () => {
  it('uses the text, trimmed to 100 characters', () => {
    expect(messagePreview('text', 'hello')).toBe('hello');
    const long = 'x'.repeat(150);
    expect(messagePreview('text', long)).toBe(`${'x'.repeat(99)}…`);
  });

  it('labels media messages', () => {
    expect(messagePreview('image', null)).toBe('📷 Photo');
    expect(messagePreview('voice', null)).toBe('🎤 Voice message');
    expect(messagePreview('image', 'look at this')).toBe('📷 look at this');
  });
});

describe('broadcastToParticipants', () => {
  it("emits to every participant's personal room, so chat updates reach the app live", async () => {
    participants(sender, alice, bob);
    await broadcastToParticipants(conversationId, 'new_message', { id: 'm1' });
    expect(emitted.map((e) => e.room).sort()).toEqual([`user:${alice}`, `user:${bob}`, `user:${sender}`].sort());
    expect(emitted.every((e) => e.event === 'new_message')).toBe(true);
  });

  it('does not throw when sockets are not available', async () => {
    participants(alice);
    (getIO as jest.Mock).mockImplementationOnce(() => { throw new Error('no io'); });
    await expect(broadcastToParticipants(conversationId, 'new_message', {})).resolves.toBeUndefined();
  });
});

describe('notifyChatMessage', () => {
  const msg = { conversationId, senderId: sender, senderName: 'Asha', type: 'text' as const, content: 'dinner at 8?' };

  it('pushes to every participant except the sender, without filling the notification list', async () => {
    participants(sender, alice, bob);
    await notifyChatMessage(msg);
    const recipients = (sendToUser as jest.Mock).mock.calls.map((c) => c[0]).sort();
    expect(recipients).toEqual([alice, bob].sort());
    expect(sendToUser).toHaveBeenCalledWith(
      alice, 'chat', 'Asha', 'dinner at 8?',
      { type: 'chat', conversationId },
      { skipHistory: true },
    );
  });

  it('skips a recipient who has this conversation open', async () => {
    participants(sender, alice, bob);
    sockets[`user:${alice}`] = [{ data: { viewingConversationId: conversationId } }];
    sockets[`user:${bob}`] = [{ data: { viewingConversationId: 'other-conv' } }];
    await notifyChatMessage(msg);
    expect((sendToUser as jest.Mock).mock.calls.map((c) => c[0])).toEqual([bob]);
  });

  it('mutes only the device that has the chat open', async () => {
    participants(sender, alice);
    sockets[`user:${alice}`] = [
      { data: { viewingConversationId: conversationId, deviceId: 'd1' } },
      { data: { deviceId: 'd2' } },
    ];
    await notifyChatMessage(msg);
    expect(sendToUser).toHaveBeenCalledWith(
      alice, 'chat', 'Asha', 'dinner at 8?',
      { type: 'chat', conversationId },
      { skipHistory: true, excludeDeviceIds: ['d1'] },
    );
  });

  it('sends nothing when every device is viewing it', async () => {
    participants(sender, alice);
    sockets[`user:${alice}`] = [
      { data: { viewingConversationId: conversationId, deviceId: 'd1' } },
      { data: { viewingConversationId: conversationId, deviceId: 'd2' } },
    ];
    await notifyChatMessage(msg);
    expect(sendToUser).not.toHaveBeenCalled();
  });

  it('sends at most one push per conversation and recipient per throttle window', async () => {
    expect(CHAT_PUSH_THROTTLE_SECONDS).toBe(30);
    participants(sender, alice);
    (redis.set as jest.Mock).mockResolvedValueOnce(null);
    await notifyChatMessage(msg);
    expect(redis.set).toHaveBeenCalledWith(`push:chat:${conversationId}:${alice}`, '1', 'EX', 30, 'NX');
    expect(sendToUser).not.toHaveBeenCalled();
  });

  it('still pushes when Redis is down (fails open)', async () => {
    participants(sender, alice);
    (redis.set as jest.Mock).mockRejectedValueOnce(new Error('redis down'));
    await notifyChatMessage(msg);
    expect(sendToUser).toHaveBeenCalledTimes(1);
  });

  it('still pushes when the socket server is unavailable', async () => {
    participants(sender, alice);
    (getIO as jest.Mock).mockImplementationOnce(() => { throw new Error('no io'); });
    await notifyChatMessage(msg);
    expect(sendToUser).toHaveBeenCalledTimes(1);
  });

  it('never throws, even if loading participants fails', async () => {
    (ConversationParticipant.findAll as jest.Mock).mockRejectedValueOnce(new Error('db'));
    await expect(notifyChatMessage(msg)).resolves.toBeUndefined();
  });
});
