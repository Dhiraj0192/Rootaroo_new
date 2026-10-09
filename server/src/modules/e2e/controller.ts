import { Request, Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../shared/middleware/auth';
import * as accountKey from './accountKey.service';
import * as transfer from './transfer.service';
import * as backup from './backup.service';

const who = (req: Request) => {
  const { user } = req as AuthenticatedRequest;
  return { userId: user!.userId, deviceId: user!.deviceId ?? null };
};

type Handler = (req: Request) => Promise<{ status?: number; data: unknown }>;

const wrap = (fn: Handler) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { status = 200, data } = await fn(req);
    res.status(status).json({ success: true, data });
  } catch (e) { next(e); }
};

export const getAccountKey = wrap(async (req) => {
  const { userId, deviceId } = who(req);
  return { data: await accountKey.getAccountKey(userId, deviceId) };
});

export const createAccountKey = wrap(async (req) => {
  const { userId, deviceId } = who(req);
  return { status: 201, data: await accountKey.createAccountKey(userId, deviceId, req.body.publicKey) };
});

export const createSession = wrap(async (req) => {
  const { userId, deviceId } = who(req);
  return { status: 201, data: await transfer.createSession(userId, deviceId, req.body.ephemeralPublicKey) };
});

export const getSession = wrap(async (req) => {
  const { userId, deviceId } = who(req);
  return { data: await transfer.getSession(userId, deviceId, req.params.id) };
});

export const sendPayload = wrap(async (req) => {
  const { userId, deviceId } = who(req);
  await transfer.sendPayload(userId, deviceId, req.params.id, req.body);
  return { data: { message: 'Sent' } };
});

export const completeSession = wrap(async (req) => {
  const { userId, deviceId } = who(req);
  await transfer.completeSession(userId, deviceId, req.params.id);
  return { data: { message: 'This phone now holds your private space' } };
});

export const getBackup = wrap(async (req) => ({ data: await backup.getBackup(who(req).userId) }));

export const putBackup = wrap(async (req) => {
  const { userId, deviceId } = who(req);
  await backup.putBackup(userId, deviceId, req.body);
  return { data: { message: 'Backup saved' } };
});

export const deleteBackup = wrap(async (req) => {
  const { userId, deviceId } = who(req);
  await backup.deleteBackup(userId, deviceId);
  return { data: { message: 'Backup removed' } };
});

export const startRestore = wrap(async (req) => {
  const { userId, deviceId } = who(req);
  return { data: await backup.startRestore(userId, deviceId, req.ip ?? 'unknown') };
});

export const restoreParams = wrap(async (req) => {
  const { userId, deviceId } = who(req);
  return { data: await backup.restoreParams(userId, deviceId, req.body.emailCode) };
});

export const restore = wrap(async (req) => {
  const { userId, deviceId } = who(req);
  return { data: await backup.restore(userId, deviceId, req.body.restoreToken, req.body.authKey) };
});
