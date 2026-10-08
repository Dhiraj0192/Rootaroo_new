import http from 'http';
import { AddressInfo } from 'net';
import jwt from 'jsonwebtoken';
import { Server } from 'socket.io';
import { io as connect, Socket } from 'socket.io-client';
import { env } from '../../../config/env';
import { setupAssociations } from '../../../database/models';
import { socketAuthMiddleware, setupSocketConnectionHandlers } from '../../../shared/middleware/socketAuth';
import { registerChatSocket } from '../../../socket/chatSocket';
import { setIO } from '../../../shared/utils/socket';
import { resetDb, closeIntResources } from '../../../test/int/db';
import { createHouseholdWithAdmin, addMember } from '../../../test/factories';
import { createSubscriptionRow } from '../../../test/billing/rows';

let server: http.Server; let ioServer: Server; let url: string;
const clients: Socket[] = [];

beforeAll(async () => {
  setupAssociations();
  server = http.createServer();
  ioServer = new Server(server);
  socketAuthMiddleware(ioServer); setupSocketConnectionHandlers(ioServer); registerChatSocket(ioServer); setIO(ioServer);
  await new Promise<void>((r) => server.listen(0, r));
  url = `http://localhost:${(server.address() as AddressInfo).port}`;
});
beforeEach(() => resetDb());
afterEach(() => { clients.splice(0).forEach((c) => c.close()); });
afterAll(async () => { ioServer.close(); await closeIntResources(); });

function client(user: { id: string; email: string; role: string }): Promise<Socket> {
  const token = jwt.sign({ userId: user.id, email: user.email, role: user.role }, env.jwt.accessSecret);
  const c = connect(url, { auth: { token }, transports: ['websocket'] });
  clients.push(c);
  return new Promise((resolve) => c.on('connect', () => resolve(c)));
}

const received = (c: Socket, event: string, ms = 500) =>
  new Promise<boolean>((resolve) => { const t = setTimeout(() => resolve(false), ms); c.once(event, () => { clearTimeout(t); resolve(true); }); });

describe('socket gating (B7)', () => {
  it('drops chat:typing from a blocked household', async () => {
    const { household, admin } = await createHouseholdWithAdmin();
    const member = await addMember(household.id);
    const [a, b] = [await client(admin), await client(member)];
    const got = received(b, 'chat:typing');
    a.emit('chat:typing', { householdId: household.id });
    expect(await got).toBe(false);
  });

  it('relays chat:typing for an entitled household', async () => {
    const { household, admin } = await createHouseholdWithAdmin();
    await createSubscriptionRow(household.id);
    const member = await addMember(household.id);
    const [a, b] = [await client(admin), await client(member)];
    const got = received(b, 'chat:typing', 1500);
    a.emit('chat:typing', { householdId: household.id });
    expect(await got).toBe(true);
  });
});
