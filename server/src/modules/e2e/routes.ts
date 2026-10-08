import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, AuthenticatedRequest } from '../../shared/middleware/auth';
import { validate } from '../../shared/middleware/validate';
import * as ctrl from './controller';
import { assertKeyHolder } from './holder';
import {
  createAccountKeySchema, createTransferSessionSchema, transferSessionParamSchema, transferPayloadSchema,
  putBackupSchema, restoreParamsSchema, restoreSchema,
} from './validation';

// No requireEntitlement on any of these: a lapsed household must still be able
// to move or restore its data, and data export depends on it.

/** Authorisation before body validation, so a phone without the key gets 403 whatever it sent. */
function requireKeyHolder(req: Request, _res: Response, next: NextFunction): void {
  const { user } = req as AuthenticatedRequest;
  assertKeyHolder(user!.userId, user!.deviceId ?? null).then(() => next(), next);
}

// ── Account key ──
export const accountKeyRouter = Router();
accountKeyRouter.use(authenticate);

/**
 * @swagger
 * /account-key:
 *   get:
 *     tags: [Private space]
 *     summary: Your account public key and whether this phone holds the private half
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: "{ publicKey (null if none yet), holdsKey, hasBackup, keyVersion }" }
 *   put:
 *     tags: [Private space]
 *     summary: Create the account key (first time only); the calling phone becomes the key holder
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [publicKey]
 *             properties:
 *               publicKey: { type: string, description: Base64 of the raw 32-byte X25519 public key }
 *     responses:
 *       201: { description: Created }
 *       400: { description: Not a 32-byte key }
 *       409: { description: An account key already exists }
 */
accountKeyRouter.get('/', ctrl.getAccountKey);
accountKeyRouter.put('/', validate(createAccountKeySchema), ctrl.createAccountKey);

// ── Phone-to-phone transfer ──
export const keyTransferRouter = Router();
keyTransferRouter.use(authenticate);

/**
 * @swagger
 * /key-transfer/sessions:
 *   post:
 *     tags: [Private space]
 *     summary: New phone opens a 5-minute transfer session (replaces any earlier one)
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [ephemeralPublicKey]
 *             properties:
 *               ephemeralPublicKey: { type: string, description: Base64 32-byte X25519 key }
 *     responses:
 *       201: { description: "{ sessionId, expiresAt }" }
 *       409: { description: No account key yet, or this phone already holds it }
 * /key-transfer/sessions/{id}:
 *   get:
 *     tags: [Private space]
 *     summary: Read a session (any phone of the same user); the sealed payload is returned only to the new phone
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200: { description: "{ sessionId, status, expiresAt, newEphemeralPublicKey, oldEphemeralPublicKey, payload }" }
 *       404: { description: Unknown, expired or someone else's session }
 * /key-transfer/sessions/{id}/payload:
 *   post:
 *     tags: [Private space]
 *     summary: Old phone (the key holder) sends the sealed key
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [ephemeralPublicKey, sealed]
 *             properties:
 *               ephemeralPublicKey: { type: string, description: Base64 32-byte key }
 *               sealed: { type: string, description: Base64, at most 4 KB }
 *     responses:
 *       200: { description: Stored; the new phone is told over the socket (key-transfer:payload) }
 *       403: { description: Not the key-holding phone }
 *       404: { description: Unknown or expired session }
 *       409: { description: A payload was already sent }
 * /key-transfer/sessions/{id}/complete:
 *   post:
 *     tags: [Private space]
 *     summary: New phone confirms it stored the key; it becomes the holder and the old holder is signed out
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200: { description: Done }
 *       403: { description: Not the phone that opened the session }
 *       404: { description: Unknown or expired session }
 *       409: { description: No payload yet, or already complete }
 */
keyTransferRouter.post('/sessions', validate(createTransferSessionSchema), ctrl.createSession);
keyTransferRouter.get('/sessions/:id', validate(transferSessionParamSchema), ctrl.getSession);
keyTransferRouter.post('/sessions/:id/payload', requireKeyHolder, validate(transferPayloadSchema), ctrl.sendPayload);
keyTransferRouter.post('/sessions/:id/complete', validate(transferSessionParamSchema), ctrl.completeSession);

// ── Backup and restore ──
export const keyBackupRouter = Router();
keyBackupRouter.use(authenticate);

/**
 * @swagger
 * /key-backup:
 *   get:
 *     tags: [Private space]
 *     summary: Backup kind, created date and guesses left (no secrets)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: "{ kind, createdAt, attemptsLeft }" }
 *       404: { description: No backup }
 *   put:
 *     tags: [Private space]
 *     summary: Create or replace the backup (key-holding phone only); resets the guesses to 10
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [kind, salt, kdf, authKey, blob]
 *             properties:
 *               kind: { type: string, enum: [password, recovery_code] }
 *               salt: { type: string, description: Base64 of 16 bytes }
 *               kdf: { type: object, description: "{ algorithm: argon2id, memoryKiB, iterations, parallelism, length }" }
 *               authKey: { type: string, description: Base64 of 32 bytes; stored only as a key-vault MAC }
 *               blob: { type: string, description: Base64, at most 4 KB; stored encrypted by the key vault }
 *     responses:
 *       200: { description: Saved }
 *       403: { description: Not the key-holding phone }
 *   delete:
 *     tags: [Private space]
 *     summary: Remove the backup (key-holding phone only)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Removed }
 *       403: { description: Not the key-holding phone }
 * /key-backup/restore/start:
 *   post:
 *     tags: [Private space]
 *     summary: Email a 6-digit restore code (max 3 an hour per user)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Code sent }
 *       403: { description: This phone already holds the key }
 *       404: { description: No backup }
 *       429: { description: Too many requests }
 * /key-backup/restore/params:
 *   post:
 *     tags: [Private space]
 *     summary: Exchange the emailed code (5 tries) for the backup parameters and a 10-minute restore token
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [emailCode]
 *             properties:
 *               emailCode: { type: string, pattern: '^[0-9]{6}$' }
 *     responses:
 *       200: { description: "{ salt, kdf, kind, attemptsLeft, restoreToken }" }
 *       400: { description: Wrong or expired code }
 * /key-backup/restore:
 *   post:
 *     tags: [Private space]
 *     summary: Prove the password; on success returns the blob and this phone becomes the key holder
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [restoreToken, authKey]
 *             properties:
 *               restoreToken: { type: string }
 *               authKey: { type: string, description: Base64 of 32 bytes }
 *     responses:
 *       200: { description: "{ blob }" }
 *       401: { description: "Wrong password; body has attemptsLeft" }
 *       410: { description: Tenth wrong guess; the backup is erased }
 *       404: { description: No backup }
 */
keyBackupRouter.get('/', ctrl.getBackup);
keyBackupRouter.put('/', requireKeyHolder, validate(putBackupSchema), ctrl.putBackup);
keyBackupRouter.delete('/', requireKeyHolder, ctrl.deleteBackup);
keyBackupRouter.post('/restore/start', ctrl.startRestore);
keyBackupRouter.post('/restore/params', validate(restoreParamsSchema), ctrl.restoreParams);
keyBackupRouter.post('/restore', validate(restoreSchema), ctrl.restore);
