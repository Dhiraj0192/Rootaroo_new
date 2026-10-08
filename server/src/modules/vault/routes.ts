import { Router } from 'express';
import { authenticate } from '../../shared/middleware/auth';
import { requireEntitlement } from '../billing/entitlement';
import { validate } from '../../shared/middleware/validate';
import * as ctrl from './controller';
import { vaultUpload } from './controller';
import {
  createVaultDocumentSchema,
  updateVaultDocumentSchema,
  changeScopeSchema,
  grantKeysSchema,
  documentIdParamSchema,
  vaultDocumentQuerySchema,
} from './validation';

const router = Router();

router.use(authenticate);
router.use(requireEntitlement);

/**
 * @swagger
 * components:
 *   schemas:
 *     VaultDocument:
 *       type: object
 *       description: An end-to-end encrypted file. The server holds ciphertext, the sealed name and type, the size and dates.
 *       properties:
 *         id: { type: string, format: uuid }
 *         householdId: { type: string, format: uuid }
 *         scope: { type: string, enum: [personal, household] }
 *         sealedMeta: { type: string, description: "Base64, at most 2 KB: file name and type, sealed on the phone" }
 *         sizeBytes: { type: integer }
 *         createdAt: { type: string, format: date-time }
 *         uploadedBy:
 *           type: object
 *           properties:
 *             id: { type: string, format: uuid }
 *             displayName: { type: string }
 *         mySealedKey: { type: string, nullable: true, description: "The file key sealed to your account key (base64, at most 256 bytes). Null while an adult still has to grant it to you." }
 *         pending: { type: boolean, description: "True when mySealedKey is null" }
 *         downloadUrl: { type: string, nullable: true, description: "Signed link to the encrypted file; only when you hold a key" }
 *     VaultSealedKey:
 *       type: object
 *       additionalProperties: false
 *       required: [userId, sealedKey]
 *       properties:
 *         userId: { type: string, format: uuid }
 *         sealedKey: { type: string, description: "Base64, at most 256 bytes" }
 */

// Static routes first, or the UUID param routes would swallow them.
/**
 * @swagger
 * /vault:
 *   post:
 *     tags: [Vault]
 *     summary: Upload an encrypted file
 *     description: |
 *       Multipart. `file` is ciphertext (application/octet-stream, at most 20 MB). `meta` is a JSON string
 *       { scope, sealedMeta, sizeBytes, keys: [{ userId, sealedKey }] }. Your own key is required. A personal file takes
 *       exactly your key. A household file may be sealed to any current adult member who has an account key; adults left
 *       out see the file as pending until another adult grants it. Children cannot be sealed to (400).
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [file, meta]
 *             properties:
 *               file: { type: string, format: binary }
 *               meta: { type: string, description: JSON string }
 *     responses:
 *       201: { description: Created }
 *       400: { description: A key is missing, duplicated, or for someone who is not an adult member with an account key }
 *       403: { description: Quota exceeded, or a child tried to add to the household vault }
 */
router.post('/', vaultUpload, validate(createVaultDocumentSchema), ctrl.uploadDocumentCtrl);

/**
 * @swagger
 * /vault:
 *   get:
 *     tags: [Vault]
 *     summary: My personal files and, for adults, the household's shared files
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: cursor, schema: { type: string } }
 *       - { in: query, name: limit, schema: { type: integer, minimum: 1, maximum: 50 } }
 *     responses:
 *       200:
 *         description: "{ documents: VaultDocument[], nextCursor, hasMore }"
 */
router.get('/', validate(vaultDocumentQuerySchema), ctrl.listDocumentsCtrl);

/**
 * @swagger
 * /vault/summary:
 *   get:
 *     tags: [Vault]
 *     summary: How much of the 2 GB quota I have used
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: "{ usedBytes, limitBytes, documentCount }" }
 */
router.get('/summary', ctrl.getStorageUsageCtrl);

/**
 * @swagger
 * /vault/members:
 *   get:
 *     tags: [Vault]
 *     summary: Adults of my household who have an account key (to seal files to)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: "[{ userId, displayName, publicKey }], including me" }
 */
router.get('/members', ctrl.listMembersCtrl);

/**
 * @swagger
 * /vault/pending-grants:
 *   get:
 *     tags: [Vault]
 *     summary: Household files I can open that some adult cannot yet
 *     description: My phone seals each file key to the listed public keys and sends them to POST /vault/{id}/keys.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: "[{ documentId, mySealedKey, missing: [{ userId, publicKey }] }]" }
 */
router.get('/pending-grants', ctrl.listPendingGrantsCtrl);

/**
 * @swagger
 * /vault/{id}:
 *   get:
 *     tags: [Vault]
 *     summary: One file
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200: { description: VaultDocument }
 *       404: { description: Not visible to me (a child, another household, or someone else's personal file) }
 */
router.get('/:id', validate(documentIdParamSchema), ctrl.getDocumentByIdCtrl);

/**
 * @swagger
 * /vault/{id}:
 *   patch:
 *     tags: [Vault]
 *     summary: Rename (replace the sealed name and type); uploader only
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [sealedMeta]
 *             properties:
 *               sealedMeta: { type: string, description: "Base64, at most 2 KB" }
 *     responses:
 *       200: { description: VaultDocument }
 *       403: { description: Not the uploader }
 */
router.patch('/:id', validate(updateVaultDocumentSchema), ctrl.renameDocumentCtrl);

/**
 * @swagger
 * /vault/{id}/scope:
 *   patch:
 *     tags: [Vault]
 *     summary: Switch between Personal and Household; uploader only
 *     description: To personal removes everyone else's key. To household adds the given keys (same rules as upload).
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [scope]
 *             properties:
 *               scope: { type: string, enum: [personal, household] }
 *               keys: { type: array, items: { $ref: '#/components/schemas/VaultSealedKey' } }
 *     responses:
 *       200: { description: VaultDocument }
 *       403: { description: Not the uploader }
 *       409: { description: Someone listed already has a key }
 */
router.patch('/:id/scope', validate(changeScopeSchema), ctrl.changeScopeCtrl);

/**
 * @swagger
 * /vault/{id}/keys:
 *   post:
 *     tags: [Vault]
 *     summary: Grant a household file to adults who do not have a key yet
 *     description: Caller must hold a key for the file (403 otherwise). Each target must be a current adult member with an account key (400) and no key yet (409).
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [grants]
 *             properties:
 *               grants: { type: array, items: { $ref: '#/components/schemas/VaultSealedKey' } }
 *     responses:
 *       200: { description: Granted }
 */
router.post('/:id/keys', validate(grantKeysSchema), ctrl.grantKeysCtrl);

/**
 * @swagger
 * /vault/{id}:
 *   delete:
 *     tags: [Vault]
 *     summary: Delete a file; the uploader or a household admin
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200: { description: Deleted from storage and the database }
 *       403: { description: Neither the uploader nor an admin }
 */
router.delete('/:id', validate(documentIdParamSchema), ctrl.deleteDocumentCtrl);

/**
 * @swagger
 * /vault/{id}/hard:
 *   delete:
 *     tags: [Vault]
 *     summary: Permanently delete a household file (admin only, FR-130)
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200: { description: Deleted }
 *       403: { description: Not an admin }
 */
router.delete('/:id/hard', validate(documentIdParamSchema), ctrl.hardDeleteDocumentCtrl);

export default router;
