import { Op, UniqueConstraintError } from 'sequelize';
import {
  sequelize,
  VaultDocument,
  VaultDocumentKey,
  AccountKey,
  HouseholdMember,
  User,
} from '../../database/models';
import { NotFoundError, ForbiddenError, ValidationError, ConflictError } from '../../shared/utils/errors';
import { uploadBuffer, deleteObject, getSignedUrl } from '../../shared/utils/s3';
import { userUploadFolder } from '../../shared/utils/uploadKeys';
import { isCurrentHouseholdAdmin, getUserHousehold as getUserHouseholdCore } from '../../shared/utils/household';
import type {
  CreateVaultDocumentBody,
  ChangeScopeBody,
  SealedKeyInput,
  VaultDocumentCreated,
  VaultDocumentResponse,
  PaginatedVaultDocuments,
  VaultMemberResponse,
  PendingGrantResponse,
  VaultStorageUsageResponse,
} from './types';

const MAX_STORAGE_BYTES = 2 * 1024 * 1024 * 1024; // 2GB
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB
const ADULT_ROLES = ['admin', 'member'];
const PENDING_GRANTS_LIMIT = 100;

export async function getUserHousehold(userId: string): Promise<string> {
  return getUserHouseholdCore(userId, 'You must belong to a household to use the vault');
}

interface Caller {
  householdId: string | null;
  isAdult: boolean;
  isAdmin: boolean;
}

/** Household and adult status, re-read from the database (never from the JWT role claim, F-06). */
async function getCaller(userId: string): Promise<Caller> {
  const membership = await HouseholdMember.findOne({ where: { userId } });
  if (!membership) return { householdId: null, isAdult: false, isAdmin: false };
  return { householdId: membership.householdId, isAdult: ADULT_ROLES.includes(membership.role), isAdmin: membership.role === 'admin' };
}

/** Files the caller may see: their own personal files, plus the household's shared files if they are an adult. */
function visibleToCaller(userId: string, caller: Caller): Record<string | symbol, unknown> {
  const options: unknown[] = [{ scope: 'personal', uploadedBy: userId }];
  if (caller.isAdult && caller.householdId) options.push({ scope: 'household', householdId: caller.householdId });
  return { [Op.or]: options };
}

async function findVisible(documentId: string, userId: string): Promise<VaultDocument> {
  const caller = await getCaller(userId);
  const document = await VaultDocument.findOne({
    where: { id: documentId, ...visibleToCaller(userId, caller) },
    include: [{ model: User, as: 'uploader' }],
  });
  if (!document) throw new NotFoundError('Document');
  return document;
}

function uploaderOf(doc: VaultDocument) {
  const uploader = doc.get('uploader') as User;
  return { id: uploader.id, displayName: uploader.displayName };
}

function toCreated(doc: VaultDocument): VaultDocumentCreated {
  return {
    id: doc.id,
    householdId: doc.householdId,
    scope: doc.scope,
    sealedMeta: doc.sealedMeta,
    sizeBytes: doc.sizeBytes,
    createdAt: doc.createdAt.toISOString(),
    uploadedBy: uploaderOf(doc),
  };
}

async function toResponse(doc: VaultDocument, mySealedKey: string | null): Promise<VaultDocumentResponse> {
  return {
    ...toCreated(doc),
    mySealedKey,
    pending: mySealedKey === null,
    downloadUrl: mySealedKey === null ? null : await getSignedUrl(doc.s3Key),
  };
}

async function toResponses(docs: VaultDocument[], userId: string): Promise<VaultDocumentResponse[]> {
  if (docs.length === 0) return [];
  const mine = await VaultDocumentKey.findAll({ where: { userId, documentId: docs.map((d) => d.id) } });
  const byDocument = new Map(mine.map((k) => [k.documentId, k.wrappedKey]));
  return Promise.all(docs.map((doc) => toResponse(doc, byDocument.get(doc.id) ?? null)));
}

async function checkStorageQuota(userId: string, additionalBytes: number): Promise<void> {
  const totalSize = await VaultDocument.sum('sizeBytes', {
    where: { uploadedBy: userId },
  }) || 0;

  if (totalSize + additionalBytes > MAX_STORAGE_BYTES) {
    throw new ForbiddenError(
      `Vault storage limit exceeded (${MAX_STORAGE_BYTES / (1024 * 1024 * 1024)}GB). Current: ${(totalSize / (1024 * 1024)).toFixed(1)}MB`
    );
  }
}

/** Every user must be a current adult member of the household with an account key; returns their public keys. */
async function adultsWithKeys(householdId: string, userIds: string[]): Promise<Map<string, string>> {
  const [members, accountKeys] = await Promise.all([
    HouseholdMember.findAll({ where: { householdId, userId: userIds, role: { [Op.in]: ADULT_ROLES } } }),
    AccountKey.findAll({ where: { userId: userIds } }),
  ]);
  const adults = new Set(members.map((m) => m.userId));
  const publicKeys = new Map(accountKeys.map((k) => [k.userId, k.publicKey]));
  for (const id of userIds) {
    if (!adults.has(id) || !publicKeys.has(id)) {
      throw new ValidationError('A file can only be shared with adult household members who have set up their private space');
    }
  }
  return publicKeys;
}

function assertNoDuplicates(keys: SealedKeyInput[]): void {
  if (new Set(keys.map((k) => k.userId)).size !== keys.length) {
    throw new ValidationError('Each person can be given a key only once');
  }
}

async function assertNoExistingKeys(documentId: string, keys: SealedKeyInput[]): Promise<void> {
  const existing = await VaultDocumentKey.findAll({ where: { documentId, userId: keys.map((k) => k.userId) } });
  const have = new Set(existing.map((k) => k.userId));
  if (keys.some((k) => have.has(k.userId))) {
    throw new ConflictError('Someone you are granting already has a key for this file');
  }
}

function keyRows(documentId: string, keys: SealedKeyInput[]) {
  return keys.map((k) => ({ documentId, userId: k.userId, wrappedKey: k.sealedKey }));
}

// ─── Upload Document ───

export async function uploadDocument(
  userId: string,
  body: CreateVaultDocumentBody,
  fileBuffer: Buffer
): Promise<VaultDocumentCreated> {
  const caller = await getCaller(userId);
  if (!caller.householdId) throw new ForbiddenError('You must belong to a household to use the vault');
  const householdId = caller.householdId;

  if (body.sizeBytes > MAX_FILE_SIZE || fileBuffer.length > MAX_FILE_SIZE) {
    throw new ForbiddenError(`File size exceeds ${MAX_FILE_SIZE / (1024 * 1024)}MB limit`);
  }

  assertNoDuplicates(body.keys);
  if (!body.keys.some((k) => k.userId === userId)) {
    throw new ValidationError('Your own key for the file is required');
  }
  if (body.scope === 'personal') {
    if (body.keys.length !== 1) throw new ValidationError('A personal file is sealed to you alone');
  } else {
    if (!caller.isAdult) throw new ForbiddenError('Only adults can add to the household vault');
    await adultsWithKeys(householdId, body.keys.map((k) => k.userId));
  }

  await checkStorageQuota(userId, body.sizeBytes);

  const uploadResult = await uploadBuffer(fileBuffer, userUploadFolder('vault', userId), 'application/octet-stream');

  let documentId: string;
  try {
    documentId = await sequelize.transaction(async (transaction) => {
      const doc = await VaultDocument.create({
        householdId,
        scope: body.scope,
        sealedMeta: body.sealedMeta,
        sizeBytes: body.sizeBytes,
        s3Key: uploadResult.key,
        uploadedBy: userId,
      }, { transaction });
      await VaultDocumentKey.bulkCreate(keyRows(doc.id, body.keys), { transaction });
      return doc.id;
    });
  } catch (error) {
    // The stored object would otherwise be orphaned with nothing pointing at it.
    await deleteObject(uploadResult.key).catch(() => undefined);
    throw error;
  }

  const fullDoc = await VaultDocument.findByPk(documentId, { include: [{ model: User, as: 'uploader' }] });
  if (!fullDoc) throw new Error('Failed to load created document');
  return toCreated(fullDoc);
}

// ─── List Documents ───

export async function listDocuments(
  userId: string,
  options: { cursor?: string; limit?: number }
): Promise<PaginatedVaultDocuments> {
  const caller = await getCaller(userId);
  const limit = Math.min(options.limit || 20, 50);

  const where: Record<string | symbol, unknown> = { ...visibleToCaller(userId, caller) };
  if (options.cursor) {
    where.createdAt = { [Op.lt]: new Date(options.cursor) };
  }

  const documents = await VaultDocument.findAll({
    where,
    include: [{ model: User, as: 'uploader' }],
    order: [['createdAt', 'DESC']],
    limit: limit + 1,
  });

  const hasMore = documents.length > limit;
  const page = hasMore ? documents.slice(0, limit) : documents;
  const nextCursor = hasMore ? page[page.length - 1].createdAt.toISOString() : null;

  return { documents: await toResponses(page, userId), nextCursor, hasMore };
}

// ─── Get Document By ID ───

export async function getDocumentById(documentId: string, userId: string): Promise<VaultDocumentResponse> {
  const document = await findVisible(documentId, userId);
  return (await toResponses([document], userId))[0];
}

// ─── Household members who can be sealed to ───

export async function listVaultMembers(userId: string): Promise<VaultMemberResponse[]> {
  const householdId = await getUserHousehold(userId);
  const members = await HouseholdMember.findAll({ where: { householdId, role: { [Op.in]: ADULT_ROLES } } });
  const ids = members.map((m) => m.userId);
  const [accountKeys, users] = await Promise.all([
    AccountKey.findAll({ where: { userId: ids } }),
    User.findAll({ where: { id: ids }, attributes: ['id', 'displayName'] }),
  ]);
  const names = new Map(users.map((u) => [u.id, u.displayName]));
  return accountKeys
    .filter((k) => ids.includes(k.userId))
    .map((k) => ({ userId: k.userId, displayName: names.get(k.userId) ?? '', publicKey: k.publicKey }));
}

// ─── Pending grants: files I can open that another adult cannot yet ───

export async function listPendingGrants(userId: string): Promise<PendingGrantResponse[]> {
  const caller = await getCaller(userId);
  if (!caller.householdId || !caller.isAdult) return [];
  const householdId = caller.householdId;

  const mine = await VaultDocumentKey.findAll({ where: { userId } });
  if (mine.length === 0) return [];
  const myKeys = new Map(mine.map((k) => [k.documentId, k.wrappedKey]));

  const documents = await VaultDocument.findAll({
    where: { id: [...myKeys.keys()], scope: 'household', householdId },
    attributes: ['id'],
    order: [['createdAt', 'ASC']],
    limit: PENDING_GRANTS_LIMIT,
  });
  if (documents.length === 0) return [];

  const members = await HouseholdMember.findAll({ where: { householdId, role: { [Op.in]: ADULT_ROLES } } });
  const accountKeys = await AccountKey.findAll({ where: { userId: members.map((m) => m.userId) } });
  const adults = accountKeys.filter((k) => members.some((m) => m.userId === k.userId));

  const allKeys = await VaultDocumentKey.findAll({ where: { documentId: documents.map((d) => d.id) } });
  const holders = new Map<string, Set<string>>();
  for (const k of allKeys) {
    if (!holders.has(k.documentId)) holders.set(k.documentId, new Set());
    holders.get(k.documentId)!.add(k.userId);
  }

  const result: PendingGrantResponse[] = [];
  for (const doc of documents) {
    const have = holders.get(doc.id) ?? new Set<string>();
    const missing = adults.filter((a) => !have.has(a.userId)).map((a) => ({ userId: a.userId, publicKey: a.publicKey }));
    if (missing.length > 0) result.push({ documentId: doc.id, mySealedKey: myKeys.get(doc.id)!, missing });
  }
  return result;
}

// ─── Grant keys to adults who are still pending ───

export async function grantKeys(documentId: string, userId: string, grants: SealedKeyInput[]): Promise<void> {
  const document = await VaultDocument.findByPk(documentId);
  if (!document) throw new NotFoundError('Document');

  const myKey = await VaultDocumentKey.findOne({ where: { documentId, userId } });
  if (!myKey) throw new ForbiddenError('You can only grant access to a file you can open');
  if (document.scope !== 'household') throw new ValidationError('Only household files can be shared');

  assertNoDuplicates(grants);
  await adultsWithKeys(document.householdId, grants.map((g) => g.userId));
  await assertNoExistingKeys(documentId, grants);

  try {
    await sequelize.transaction(async (transaction) => {
      await VaultDocumentKey.bulkCreate(keyRows(documentId, grants), { transaction });
    });
  } catch (error) {
    // Two phones granting the same person at once: the primary key catches the second.
    if (error instanceof UniqueConstraintError) {
      throw new ConflictError('Someone you are granting already has a key for this file');
    }
    throw error;
  }
}

// ─── Rename (replace the sealed name/type) ───

export async function renameDocument(documentId: string, userId: string, sealedMeta: string): Promise<VaultDocumentResponse> {
  const document = await findVisible(documentId, userId);
  if (document.uploadedBy !== userId) {
    throw new ForbiddenError('Only the uploader can rename this file');
  }
  document.sealedMeta = sealedMeta;
  await document.save();
  return (await toResponses([document], userId))[0];
}

// ─── Switch between Personal and Household (uploader only) ───

export async function changeScope(documentId: string, userId: string, body: ChangeScopeBody): Promise<VaultDocumentResponse> {
  const document = await findVisible(documentId, userId);
  if (document.uploadedBy !== userId) {
    throw new ForbiddenError('Only the uploader can change who this file is shared with');
  }

  if (body.scope === 'personal') {
    await sequelize.transaction(async (transaction) => {
      await VaultDocumentKey.destroy({ where: { documentId, userId: { [Op.ne]: userId } }, transaction });
      document.scope = 'personal';
      await document.save({ transaction });
    });
  } else {
    const caller = await getCaller(userId);
    if (!caller.isAdult || caller.householdId !== document.householdId) {
      throw new ForbiddenError('Only adults can share a file with the household');
    }
    // The uploader already holds a key; only other people need one added.
    const added = (body.keys ?? []).filter((k) => k.userId !== userId);
    assertNoDuplicates(added);
    if (added.length > 0) {
      await adultsWithKeys(document.householdId, added.map((k) => k.userId));
      await assertNoExistingKeys(documentId, added);
    }
    await sequelize.transaction(async (transaction) => {
      if (added.length > 0) await VaultDocumentKey.bulkCreate(keyRows(documentId, added), { transaction });
      document.scope = 'household';
      await document.save({ transaction });
    });
  }

  return (await toResponses([document], userId))[0];
}

// ─── Delete Document ───

async function purge(document: VaultDocument): Promise<void> {
  await deleteObject(document.s3Key);
  await sequelize.transaction(async (transaction) => {
    await VaultDocumentKey.destroy({ where: { documentId: document.id }, transaction });
    await document.destroy({ force: true, transaction });
  });
}

export async function deleteDocument(documentId: string, userId: string): Promise<void> {
  const caller = await getCaller(userId);
  const document = await VaultDocument.findOne({
    where: {
      id: documentId,
      [Op.or]: [
        visibleToCaller(userId, caller),
        // An admin can remove any file of the household, even a personal one they cannot
        // open, so storage and the uploader's quota can always be cleaned up.
        ...(caller.isAdmin ? [{ householdId: caller.householdId }] : []),
      ],
    },
  });
  if (!document) throw new NotFoundError('Document');

  // Uploader or household admin (role read from the database, not the JWT: F-06).
  // Only an admin's lookup can reach a file that is not theirs, so anyone else gets 404 first.
  if (document.uploadedBy !== userId && !caller.isAdmin) {
    throw new ForbiddenError('Only the uploader or an admin can delete this document');
  }

  await purge(document);
}

// ─── Storage Usage ───

export async function getStorageUsage(userId: string): Promise<VaultStorageUsageResponse> {
  await getUserHousehold(userId); // ensures caller belongs to a household

  const documents = await VaultDocument.findAll({
    where: { uploadedBy: userId },
    attributes: ['sizeBytes'],
  });

  const usedBytes = documents.reduce((sum, doc) => sum + doc.sizeBytes, 0);
  return { usedBytes, limitBytes: MAX_STORAGE_BYTES, documentCount: documents.length };
}

// ─── Hard Delete (admin only, FR-130) ───

export async function hardDeleteDocument(documentId: string, userId: string): Promise<void> {
  const householdId = await getUserHousehold(userId);

  // Permanent delete — never relies on the caller's JWT `role` claim alone (F-06).
  if (!(await isCurrentHouseholdAdmin(userId, householdId))) {
    throw new ForbiddenError('Only admins can permanently delete documents');
  }

  const document = await VaultDocument.findOne({ where: { id: documentId, householdId, scope: 'household' } });
  if (!document) throw new NotFoundError('Document');

  await purge(document);
}
