import { Router } from 'express';
import { authenticate } from '../../shared/middleware/auth';
import { requireEntitlement } from '../billing/entitlement';
import { validate } from '../../shared/middleware/validate';
import { uploadJournalBlobs } from '../../shared/middleware/upload';
import * as ctrl from './controller';
import {
  createEntrySchema,
  updateEntrySchema,
  entryIdParamSchema,
  entryQuerySchema,
  historyQuerySchema,
  onThisDayQuerySchema,
} from './validation';

const router = Router();

router.use(authenticate);
router.use(requireEntitlement);

/**
 * @swagger
 * components:
 *   schemas:
 *     JournalEntry:
 *       type: object
 *       description: An end-to-end encrypted entry. The server only ever holds the ciphertext.
 *       properties:
 *         id: { type: string, format: uuid }
 *         ciphertext: { type: string, description: "Base64, at most 96 KB decoded" }
 *         sealedKey: { type: string, description: "Base64, at most 256 bytes: the entry key sealed to the account key" }
 *         format: { type: integer, example: 1 }
 *         media:
 *           type: array
 *           items:
 *             type: object
 *             properties:
 *               id: { type: string, format: uuid }
 *               url: { type: string, description: Signed link to the encrypted photo }
 *               thumbnailUrl: { type: string, nullable: true, description: Signed link to the encrypted thumbnail }
 *               sizeBytes: { type: integer, nullable: true }
 *         createdAt: { type: string, format: date-time }
 *         updatedAt: { type: string, format: date-time }
 *     JournalEntryInput:
 *       type: object
 *       additionalProperties: false
 *       required: [id, ciphertext, sealedKey, format]
 *       properties:
 *         ciphertext: { type: string, description: "Base64, at most 96 KB decoded" }
 *         sealedKey: { type: string, description: "Base64, at most 256 bytes" }
 *         format: { type: integer, enum: [1] }
 *         media:
 *           type: array
 *           maxItems: 10
 *           description: On create, new descriptors. On update, the complete list - existing items as { id }, new ones as descriptors; anything not listed is dropped.
 *           items:
 *             type: object
 *             properties:
 *               id: { type: string, format: uuid }
 *               blobKey: { type: string, description: "fileName returned by POST /journal/media/upload" }
 *               thumbnailKey: { type: string }
 *               sizeBytes: { type: integer }
 */

// Media upload + stats reads — all before /:id, or the UUID param route
// would swallow them.
/**
 * @swagger
 * /journal/media/upload:
 *   post:
 *     tags: [Journal]
 *     summary: Upload up to 5 encrypted photo blobs per request (the phone encrypts photo and thumbnail first)
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               files:
 *                 type: array
 *                 maxItems: 5
 *                 items: { type: string, format: binary, description: "application/octet-stream ciphertext, 10 MB max each; 2 GB per user in total" }
 *     responses:
 *       201: { description: "[{ fileName (the storage key), size }]" }
 *       400: { description: No files, or a file that is not application/octet-stream }
 *       413: { description: Journal photo storage limit reached }
 */
router.post('/media/upload', uploadJournalBlobs.array('files', 10), ctrl.uploadMedia);

/**
 * @swagger
 * /journal/stats:
 *   get:
 *     tags: [Journal]
 *     summary: Streak card, computed from entry dates only
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: "{ streak, bestStreak, wroteToday, entriesThisMonth, last7Days: [{ date, wrote }], prompt }" }
 */
router.get('/stats', ctrl.stats);

/**
 * @swagger
 * /journal/history:
 *   get:
 *     tags: [Journal]
 *     summary: Days of a month that have an entry
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: month, schema: { type: string, example: "2026-07" }, description: "YYYY-MM, defaults to this month" }
 *     responses:
 *       200: { description: "{ month, entryDates: ['YYYY-MM-DD'], daysInMonth, firstWeekday }" }
 */
router.get('/history', validate(historyQuerySchema), ctrl.history);

/**
 * @swagger
 * /journal/on-this-day:
 *   get:
 *     tags: [Journal]
 *     summary: Encrypted entries from the same month and day in earlier years (up to 5)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: date, schema: { type: string, example: "2026-07-17" }, description: "YYYY-MM-DD, defaults to today" }
 *     responses:
 *       200: { description: "{ entries: [JournalEntry] } - the phone decrypts them" }
 */
router.get('/on-this-day', validate(onThisDayQuerySchema), ctrl.onThisDay);

// Journal CRUD
/**
 * @swagger
 * /journal:
 *   post:
 *     tags: [Journal]
 *     summary: Save an encrypted entry
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/JournalEntryInput' }
 *     responses:
 *       201: { description: The entry, with signed media links }
 *       400: { description: Unknown field (for example readable content), bad base64 or too large }
 *       403: { description: An attachment key is not one of your own uploads }
 *   get:
 *     tags: [Journal]
 *     summary: Your entries, newest first (cursor pagination)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: cursor, schema: { type: string } }
 *       - { in: query, name: limit, schema: { type: integer, minimum: 1, maximum: 50, default: 20 } }
 *     responses:
 *       200: { description: "{ entries: [JournalEntry], nextCursor, hasMore }" }
 */
router.post('/', validate(createEntrySchema), ctrl.create);
router.get('/', validate(entryQuerySchema), ctrl.list);

/**
 * @swagger
 * /journal/{id}:
 *   get:
 *     tags: [Journal]
 *     summary: One of your entries (404 for anyone else's)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200: { description: The entry }
 *       404: { description: Not found }
 *   patch:
 *     tags: [Journal]
 *     summary: Replace the ciphertext (and optionally the attachments) of your entry
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/JournalEntryInput' }
 *     responses:
 *       200: { description: The entry }
 *       404: { description: Not found }
 *   delete:
 *     tags: [Journal]
 *     summary: Delete your entry and its stored blobs (blob removal is best effort)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200: { description: Deleted }
 *       404: { description: Not found }
 */
router.get('/:id', validate(entryIdParamSchema), ctrl.getById);
router.patch('/:id', validate(updateEntrySchema), ctrl.update);
router.delete('/:id', validate(entryIdParamSchema), ctrl.remove);

export default router;
