import { webcrypto } from 'node:crypto';

if (!globalThis.crypto?.subtle) globalThis.crypto = webcrypto;

const { generateAccountKeyPair } = require('../accountKey');
const {
  startOnNewPhone, parseTransferQr, prepareOnOldPhone, codeOnNewPhone, receiveOnNewPhone,
} = require('../keyTransfer');

/** A fake server that just stores what the phones send, like the real relay. */
function fakeServer() {
  const sessions = {};
  return {
    sessions,
    createSession: jest.fn(async ({ ephemeralPublicKey }) => {
      const id = `s${Object.keys(sessions).length + 1}`;
      sessions[id] = { id, newEphemeralPublicKey: ephemeralPublicKey };
      return { sessionId: id, expiresAt: new Date(Date.now() + 300_000).toISOString() };
    }),
    getSession: jest.fn(async (id) => ({ ...sessions[id] })),
    sendPayload: jest.fn(async (id, body) => { Object.assign(sessions[id], body); }),
  };
}

describe('moving the account key to a new phone', () => {
  it('the new phone ends up with exactly the old phone\'s key, and both show the same code', async () => {
    const server = fakeServer();
    const account = await generateAccountKeyPair();

    const newPhone = await startOnNewPhone({ api: server });
    const qr = parseTransferQr(newPhone.qr);
    expect(qr.sessionId).toBe(newPhone.sessionId);

    const old = await prepareOnOldPhone({ qr, api: server, accountKey: account });
    expect(old.code).toMatch(/^\d{6}$/);
    await old.send();

    const s = server.sessions[newPhone.sessionId];
    expect(await codeOnNewPhone(newPhone.state, s.ephemeralPublicKey)).toBe(old.code);
    const received = await receiveOnNewPhone(newPhone.state, s, account.publicKey);
    expect(received).toEqual(account);
  });

  it('never sends the QR secret to the server', async () => {
    const server = fakeServer();
    const newPhone = await startOnNewPhone({ api: server });
    const { secret } = parseTransferQr(newPhone.qr);
    const sent = JSON.stringify(server.createSession.mock.calls);
    expect(sent).not.toContain(secret);
  });

  it('the old phone refuses when the server swapped the new phone\'s key', async () => {
    const server = fakeServer();
    const account = await generateAccountKeyPair();
    const newPhone = await startOnNewPhone({ api: server });
    const attacker = await startOnNewPhone({ api: fakeServer() });
    server.sessions[newPhone.sessionId].newEphemeralPublicKey = parseTransferQr(attacker.qr).ephemeralPublicKey;
    await expect(prepareOnOldPhone({ qr: parseTransferQr(newPhone.qr), api: server, accountKey: account }))
      .rejects.toThrow('This code does not match');
    expect(server.sendPayload).not.toHaveBeenCalled();
  });

  it('a relay that never saw the QR cannot read the key', async () => {
    const server = fakeServer();
    const account = await generateAccountKeyPair();
    const newPhone = await startOnNewPhone({ api: server });
    const old = await prepareOnOldPhone({ qr: parseTransferQr(newPhone.qr), api: server, accountKey: account });
    await old.send();
    const wrongSecretState = { ...newPhone.state, secret: Buffer.alloc(16, 7).toString('base64') };
    await expect(receiveOnNewPhone(wrongSecretState, server.sessions[newPhone.sessionId], account.publicKey)).rejects.toThrow();
  });

  it('the new phone rejects a key that does not match the account\'s public key on the server', async () => {
    const server = fakeServer();
    const account = await generateAccountKeyPair();
    const other = await generateAccountKeyPair();
    const newPhone = await startOnNewPhone({ api: server });
    const old = await prepareOnOldPhone({ qr: parseTransferQr(newPhone.qr), api: server, accountKey: account });
    await old.send();
    await expect(receiveOnNewPhone(newPhone.state, server.sessions[newPhone.sessionId], other.publicKey))
      .rejects.toThrow('does not match your account');
  });

  it('rejects QR codes that are not Rootaroo transfer codes', () => {
    expect(() => parseTransferQr('https://example.com')).toThrow('not a Rootaroo');
    expect(() => parseTransferQr(JSON.stringify({ v: 2, sessionId: 'x' }))).toThrow('not a Rootaroo');
  });
});
