import {
  uploadDocument,
  listDocuments,
  getDocumentById,
  listVaultMembers,
  listPendingGrants,
  grantKeys,
  renameDocument,
  changeScope,
  deleteDocument,
  getStorageUsage,
} from '../service';
import { NotFoundError, ForbiddenError, ValidationError, ConflictError } from '../../../shared/utils/errors';
import fs from 'node:fs';
import path from 'node:path';

const userId = '550e8400-e29b-41d4-a716-446655440001';
const otherUserId = '660e8400-e29b-41d4-a716-446655440002';
const adminUserId = '770e8400-e29b-41d4-a716-446655440003';
const childId = '110e8400-e29b-41d4-a716-446655440006';
const outsiderId = '220e8400-e29b-41d4-a716-446655440007';
const householdId = '880e8400-e29b-41d4-a716-446655440004';
const documentId = '990e8400-e29b-41d4-a716-446655440005';

jest.mock('../../../database/models', () => {
  const mockModel = (name: string) => {
    const cls: any = jest.fn().mockName(name);
    cls.create = jest.fn();
    cls.bulkCreate = jest.fn();
    cls.findAll = jest.fn();
    cls.findOne = jest.fn();
    cls.findByPk = jest.fn();
    cls.destroy = jest.fn();
    cls.sum = jest.fn();
    return cls;
  };
  return {
    sequelize: { transaction: jest.fn(async (cb) => cb({})) },
    VaultDocument: mockModel('VaultDocument'),
    VaultDocumentKey: mockModel('VaultDocumentKey'),
    AccountKey: mockModel('AccountKey'),
    User: mockModel('User'),
    HouseholdMember: mockModel('HouseholdMember'),
  };
});

jest.mock('../../../shared/utils/s3', () => ({
  uploadBuffer: jest.fn(),
  deleteObject: jest.fn(),
  getSignedUrl: jest.fn((key: string | null) => Promise.resolve(key ? `https://signed.example.com/${key}` : null)),
}));

import { sequelize, VaultDocument, VaultDocumentKey, AccountKey, User, HouseholdMember } from '../../../database/models';
import { uploadBuffer, deleteObject, getSignedUrl } from '../../../shared/utils/s3';

const roles: Record<string, string> = { [userId]: 'member', [otherUserId]: 'member', [adminUserId]: 'admin', [childId]: 'child' };
const sealed = 'c2VhbGVkLWtleQ==';
const meta = 'c2VhbGVkLW1ldGE=';

const mockDoc = (overrides: any = {}) => ({
  id: documentId,
  householdId,
  scope: 'household',
  sealedMeta: meta,
  sizeBytes: 1024,
  s3Key: `vault/${userId}/abc`,
  uploadedBy: userId,
  createdAt: new Date('2026-07-12T10:00:00Z'),
  get: (key: string) => (key === 'uploader' ? { id: overrides.uploadedBy ?? userId, displayName: 'Test User' } : null),
  save: jest.fn(),
  destroy: jest.fn(),
  reload: jest.fn(),
  ...overrides,
});

/** The `or` list of a findAll where-clause (Sequelize keys it by a symbol). */
function orOf(where: any): unknown[] {
  const sym = Object.getOwnPropertySymbols(where).find((s) => s.toString() === 'Symbol(or)')!;
  return where[sym];
}

describe('Vault Service', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    (sequelize.transaction as jest.Mock).mockImplementation(async (cb: any) => cb({}));
    (HouseholdMember.findOne as jest.Mock).mockImplementation(({ where }: any) =>
      Promise.resolve(roles[where.userId] ? { householdId, userId: where.userId, role: roles[where.userId] } : null),
    );
    (HouseholdMember.findAll as jest.Mock).mockResolvedValue(
      [userId, otherUserId, adminUserId].map((id) => ({ userId: id, role: roles[id] })),
    );
    (AccountKey.findAll as jest.Mock).mockResolvedValue(
      [userId, otherUserId, adminUserId].map((id) => ({ userId: id, publicKey: `pk-${id}` })),
    );
    (User.findAll as jest.Mock).mockResolvedValue(
      [userId, otherUserId, adminUserId].map((id) => ({ id, displayName: `name-${id}` })),
    );
    (VaultDocument.sum as jest.Mock).mockResolvedValue(0);
    (uploadBuffer as jest.Mock).mockResolvedValue({ key: `vault/${userId}/abc` });
    (deleteObject as jest.Mock).mockResolvedValue(undefined);
    (getSignedUrl as jest.Mock).mockImplementation((key: string | null) => Promise.resolve(key ? `https://signed.example.com/${key}` : null));
    (VaultDocument.create as jest.Mock).mockResolvedValue(mockDoc());
    (VaultDocument.findByPk as jest.Mock).mockResolvedValue(mockDoc());
    (VaultDocumentKey.findAll as jest.Mock).mockResolvedValue([]);
  });

  describe('uploadDocument', () => {
    const ciphertext = Buffer.alloc(1024, 7);
    const body = (over: any = {}) => ({
      scope: 'household' as const,
      sealedMeta: meta,
      sizeBytes: 1024,
      keys: [{ userId, sealedKey: sealed }, { userId: otherUserId, sealedKey: sealed }],
      ...over,
    });

    it('stores a household file under the uploader folder with a key per recipient', async () => {
      const result = await uploadDocument(userId, body(), ciphertext);
      expect(uploadBuffer).toHaveBeenCalledWith(expect.any(Buffer), `vault/${userId}`, 'application/octet-stream');
      expect(VaultDocumentKey.bulkCreate).toHaveBeenCalledWith(
        [
          expect.objectContaining({ documentId, userId, wrappedKey: sealed }),
          expect.objectContaining({ documentId, userId: otherUserId, wrappedKey: sealed }),
        ],
        expect.anything(),
      );
      expect(result).toEqual(expect.objectContaining({ id: documentId, scope: 'household', sealedMeta: meta, householdId }));
      expect(result).not.toHaveProperty('name');
    });

    it('allows adults without a key yet to be left out (they become pending)', async () => {
      await expect(uploadDocument(userId, body({ keys: [{ userId, sealedKey: sealed }] }), ciphertext)).resolves.toBeDefined();
    });

    it('requires the uploader own key', async () => {
      await expect(uploadDocument(userId, body({ keys: [{ userId: otherUserId, sealedKey: sealed }] }), ciphertext))
        .rejects.toThrow(ValidationError);
      expect(uploadBuffer).not.toHaveBeenCalled();
    });

    it('personal files take exactly the uploader key', async () => {
      await expect(uploadDocument(userId, body({ scope: 'personal' }), ciphertext)).rejects.toThrow(ValidationError);
      await expect(uploadDocument(userId, body({ scope: 'personal', keys: [{ userId, sealedKey: sealed }] }), ciphertext))
        .resolves.toBeDefined();
    });

    it('refuses a key for a child, an outsider or someone without an account key', async () => {
      for (const target of [childId, outsiderId]) {
        await expect(uploadDocument(userId, body({ keys: [{ userId, sealedKey: sealed }, { userId: target, sealedKey: sealed }] }), ciphertext))
          .rejects.toThrow(ValidationError);
      }
      (AccountKey.findAll as jest.Mock).mockResolvedValue([{ userId, publicKey: 'pk' }]);
      await expect(uploadDocument(userId, body(), ciphertext)).rejects.toThrow(ValidationError);
      expect(uploadBuffer).not.toHaveBeenCalled();
    });

    it('refuses duplicate recipients', async () => {
      await expect(uploadDocument(userId, body({ keys: [{ userId, sealedKey: sealed }, { userId, sealedKey: sealed }] }), ciphertext))
        .rejects.toThrow(ValidationError);
    });

    it('a child can only upload personal files', async () => {
      await expect(uploadDocument(childId, body({ keys: [{ userId: childId, sealedKey: sealed }] }), ciphertext))
        .rejects.toThrow(ForbiddenError);
    });

    it('rejects files over 20MB and uploads over the quota', async () => {
      const big = Buffer.alloc(21 * 1024 * 1024);
      await expect(uploadDocument(userId, body({ sizeBytes: big.length }), big)).rejects.toThrow(ForbiddenError);
      (VaultDocument.sum as jest.Mock).mockResolvedValue(2 * 1024 * 1024 * 1024);
      await expect(uploadDocument(userId, body(), ciphertext)).rejects.toThrow(ForbiddenError);
    });

    it('refuses a declared size that differs from the uploaded bytes (400) before storing anything', async () => {
      await expect(uploadDocument(userId, body({ sizeBytes: 5 }), ciphertext)).rejects.toThrow(ValidationError);
      expect(uploadBuffer).not.toHaveBeenCalled();
      expect(VaultDocument.create).not.toHaveBeenCalled();
    });

    it('stores and counts the real ciphertext length', async () => {
      await uploadDocument(userId, body(), ciphertext);
      expect(VaultDocument.create).toHaveBeenCalledWith(
        expect.objectContaining({ sizeBytes: ciphertext.length }),
        expect.anything(),
      );
    });

    it('sums usage and inserts in one transaction that first locks the uploader row', async () => {
      const txn = { id: 'txn-upload' };
      (sequelize.transaction as jest.Mock).mockImplementation(async (cb: any) => cb(txn));
      await uploadDocument(userId, body(), ciphertext);

      const lock = (User.findByPk as jest.Mock).mock.invocationCallOrder[0];
      const sum = (VaultDocument.sum as jest.Mock).mock.invocationCallOrder.at(-1)!;
      const create = (VaultDocument.create as jest.Mock).mock.invocationCallOrder[0];
      expect(User.findByPk).toHaveBeenCalledWith(userId, expect.objectContaining({ transaction: txn, lock: true }));
      expect((VaultDocument.sum as jest.Mock).mock.calls.at(-1)![1]).toEqual(expect.objectContaining({ transaction: txn }));
      expect(lock).toBeLessThan(sum);
      expect(sum).toBeLessThan(create);
    });

    it('re-checks the quota under the lock, and removes the stored file when it is exceeded', async () => {
      // Passes the cheap early check, then a parallel upload has used the space by the time the lock is held.
      (VaultDocument.sum as jest.Mock).mockResolvedValueOnce(0).mockResolvedValueOnce(2 * 1024 * 1024 * 1024);
      await expect(uploadDocument(userId, body(), ciphertext)).rejects.toThrow(ForbiddenError);
      expect(VaultDocument.create).not.toHaveBeenCalled();
      expect(deleteObject).toHaveBeenCalledWith(`vault/${userId}/abc`);
    });

    it('removes the stored file when the database write fails', async () => {
      (VaultDocument.create as jest.Mock).mockRejectedValue(new Error('db down'));
      await expect(uploadDocument(userId, body(), ciphertext)).rejects.toThrow('db down');
      expect(deleteObject).toHaveBeenCalledWith(`vault/${userId}/abc`);
    });
  });

  describe('listDocuments', () => {
    it('shows my personal files plus household files for an adult, with my sealed key and a link', async () => {
      (VaultDocument.findAll as jest.Mock).mockResolvedValue([mockDoc({ id: 'd1' }), mockDoc({ id: 'd2' })]);
      (VaultDocumentKey.findAll as jest.Mock).mockResolvedValue([{ documentId: 'd1', userId, wrappedKey: 'mine' }]);

      const result = await listDocuments(userId, { limit: 20 });

      expect(orOf((VaultDocument.findAll as jest.Mock).mock.calls[0][0].where)).toEqual([
        { scope: 'personal', uploadedBy: userId },
        { scope: 'household', householdId },
      ]);
      expect(result.documents[0]).toEqual(expect.objectContaining({
        id: 'd1', mySealedKey: 'mine', pending: false, downloadUrl: expect.stringContaining('https://signed'),
      }));
      // Vault links are short-lived and never the cached CDN link, so they stop working soon after access is lost.
      expect(getSignedUrl).toHaveBeenCalledWith(expect.any(String), { ttlSeconds: 300, noCdn: true });
      expect(result.documents[1]).toEqual(expect.objectContaining({ id: 'd2', mySealedKey: null, pending: true, downloadUrl: null }));
      expect(result.documents[0].uploadedBy).toEqual({ id: userId, displayName: 'Test User' });
      expect(result.hasMore).toBe(false);
    });

    it('never asks for household files when the caller is a child', async () => {
      (VaultDocument.findAll as jest.Mock).mockResolvedValue([]);
      await listDocuments(childId, {});
      expect(orOf((VaultDocument.findAll as jest.Mock).mock.calls[0][0].where)).toEqual([{ scope: 'personal', uploadedBy: childId }]);
    });

    it('paginates with a cursor', async () => {
      const docs = [1, 2, 3].map((n) => mockDoc({ id: `d${n}`, createdAt: new Date(2026, 0, 10 - n) }));
      (VaultDocument.findAll as jest.Mock).mockResolvedValue(docs);
      const result = await listDocuments(userId, { limit: 2 });
      expect(result.documents).toHaveLength(2);
      expect(result.hasMore).toBe(true);
      expect(result.nextCursor).toBe(docs[1].createdAt.toISOString());
    });
  });

  describe('getDocumentById', () => {
    it('returns a visible document', async () => {
      (VaultDocument.findOne as jest.Mock).mockResolvedValue(mockDoc());
      (VaultDocumentKey.findAll as jest.Mock).mockResolvedValue([{ documentId, userId, wrappedKey: 'mine' }]);
      const result = await getDocumentById(documentId, userId);
      expect(result).toEqual(expect.objectContaining({ id: documentId, mySealedKey: 'mine', pending: false }));
    });

    it('404s when it is not visible to the caller', async () => {
      (VaultDocument.findOne as jest.Mock).mockResolvedValue(null);
      await expect(getDocumentById(documentId, childId)).rejects.toThrow(NotFoundError);
    });
  });

  describe('listVaultMembers', () => {
    it('lists adults with their public keys', async () => {
      const result = await listVaultMembers(userId);
      expect(result).toEqual(expect.arrayContaining([{ userId, displayName: `name-${userId}`, publicKey: `pk-${userId}` }]));
      expect(result).toHaveLength(3);
    });

    it('leaves out adults with no account key yet', async () => {
      (AccountKey.findAll as jest.Mock).mockResolvedValue([{ userId, publicKey: 'pk' }]);
      expect(await listVaultMembers(userId)).toHaveLength(1);
    });
  });

  describe('listPendingGrants', () => {
    it('lists documents I can open where an adult with a key still lacks one', async () => {
      (VaultDocumentKey.findAll as jest.Mock)
        .mockResolvedValueOnce([{ documentId, userId, wrappedKey: 'mine' }])
        .mockResolvedValueOnce([
          { documentId, userId, wrappedKey: 'mine' },
          { documentId, userId: otherUserId, wrappedKey: 'theirs' },
        ]);
      (VaultDocument.findAll as jest.Mock).mockResolvedValue([mockDoc()]);

      const result = await listPendingGrants(userId);

      expect(result).toEqual([
        { documentId, mySealedKey: 'mine', missing: [{ userId: adminUserId, publicKey: `pk-${adminUserId}` }] },
      ]);
    });

    it('omits documents where everyone already has a key', async () => {
      const all = [userId, otherUserId, adminUserId].map((id) => ({ documentId, userId: id, wrappedKey: 'k' }));
      (VaultDocumentKey.findAll as jest.Mock).mockResolvedValueOnce([all[0]]).mockResolvedValueOnce(all);
      (VaultDocument.findAll as jest.Mock).mockResolvedValue([mockDoc()]);
      expect(await listPendingGrants(userId)).toEqual([]);
    });

    it('is empty for a child', async () => {
      expect(await listPendingGrants(childId)).toEqual([]);
    });
  });

  describe('grantKeys', () => {
    beforeEach(() => {
      (VaultDocument.findByPk as jest.Mock).mockResolvedValue(mockDoc());
      (VaultDocumentKey.findOne as jest.Mock).mockResolvedValue({ documentId, userId, wrappedKey: 'mine' });
    });

    it('runs in one transaction: locks the file, re-checks my key, locks each target membership, then inserts', async () => {
      const txn = { id: 'txn-grant' };
      (sequelize.transaction as jest.Mock).mockImplementation(async (cb: any) => cb(txn));
      await grantKeys(documentId, userId, [{ userId: otherUserId, sealedKey: sealed }]);

      expect(VaultDocument.findByPk).toHaveBeenCalledWith(documentId, expect.objectContaining({ transaction: txn, lock: true }));
      expect(VaultDocumentKey.findOne).toHaveBeenCalledWith(expect.objectContaining({ where: { documentId, userId }, transaction: txn, lock: true }));
      const memberCall = (HouseholdMember.findAll as jest.Mock).mock.calls.find((c) => c[0].lock === true)!;
      expect(memberCall[0]).toEqual(expect.objectContaining({ transaction: txn, lock: true }));
      expect(memberCall[0].where).toEqual(expect.objectContaining({ householdId: householdId, userId: [otherUserId] }));

      const order = (m: jest.Mock, i = 0) => m.mock.invocationCallOrder[i];
      const memberOrder = (HouseholdMember.findAll as jest.Mock).mock.invocationCallOrder[(HouseholdMember.findAll as jest.Mock).mock.calls.indexOf(memberCall)];
      expect(order(VaultDocument.findByPk as jest.Mock)).toBeLessThan(order(VaultDocumentKey.findOne as jest.Mock));
      expect(order(VaultDocumentKey.findOne as jest.Mock)).toBeLessThan(memberOrder);
      expect(memberOrder).toBeLessThan(order(VaultDocumentKey.bulkCreate as jest.Mock));
      expect(VaultDocumentKey.bulkCreate).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ transaction: txn }));
    });

    it('refuses when the target was removed or demoted by the time the membership is locked', async () => {
      // Lock sees no adult row for the target: removal or demotion won the race.
      (HouseholdMember.findAll as jest.Mock).mockResolvedValue([]);
      await expect(grantKeys(documentId, userId, [{ userId: otherUserId, sealedKey: sealed }])).rejects.toThrow(ValidationError);
      expect(VaultDocumentKey.bulkCreate).not.toHaveBeenCalled();
    });

    it('refuses when my own key was deleted by the time the transaction looks again', async () => {
      (VaultDocumentKey.findOne as jest.Mock).mockResolvedValue(null);
      await expect(grantKeys(documentId, userId, [{ userId: otherUserId, sealedKey: sealed }])).rejects.toThrow(ForbiddenError);
      expect(VaultDocumentKey.bulkCreate).not.toHaveBeenCalled();
    });

    it('seals the file for an adult who has none', async () => {
      (VaultDocumentKey.findAll as jest.Mock).mockResolvedValue([{ documentId, userId, wrappedKey: 'mine' }]);
      await grantKeys(documentId, userId, [{ userId: otherUserId, sealedKey: sealed }]);
      expect(VaultDocumentKey.bulkCreate).toHaveBeenCalledWith(
        [expect.objectContaining({ documentId, userId: otherUserId, wrappedKey: sealed })],
        expect.anything(),
      );
    });

    it('is forbidden for someone who cannot open the file', async () => {
      (VaultDocumentKey.findOne as jest.Mock).mockResolvedValue(null);
      await expect(grantKeys(documentId, otherUserId, [{ userId: adminUserId, sealedKey: sealed }])).rejects.toThrow(ForbiddenError);
    });

    it('404s for a file that does not exist', async () => {
      (VaultDocument.findByPk as jest.Mock).mockResolvedValue(null);
      await expect(grantKeys(documentId, userId, [{ userId: otherUserId, sealedKey: sealed }])).rejects.toThrow(NotFoundError);
    });

    it('refuses personal files', async () => {
      (VaultDocument.findByPk as jest.Mock).mockResolvedValue(mockDoc({ scope: 'personal' }));
      await expect(grantKeys(documentId, userId, [{ userId: otherUserId, sealedKey: sealed }])).rejects.toThrow(ValidationError);
    });

    it('409s when the target already has a key', async () => {
      (VaultDocumentKey.findAll as jest.Mock).mockResolvedValue([{ documentId, userId: otherUserId, wrappedKey: 'x' }]);
      await expect(grantKeys(documentId, userId, [{ userId: otherUserId, sealedKey: sealed }])).rejects.toThrow(ConflictError);
    });

    it('400s for a child or an outsider', async () => {
      for (const target of [childId, outsiderId]) {
        await expect(grantKeys(documentId, userId, [{ userId: target, sealedKey: sealed }])).rejects.toThrow(ValidationError);
      }
      expect(VaultDocumentKey.bulkCreate).not.toHaveBeenCalled();
    });
  });

  describe('renameDocument', () => {
    it('lets the uploader replace the sealed name', async () => {
      const doc = mockDoc();
      (VaultDocument.findOne as jest.Mock).mockResolvedValue(doc);
      const result = await renameDocument(documentId, userId, 'bmV3');
      expect(doc.sealedMeta).toBe('bmV3');
      expect(doc.save).toHaveBeenCalled();
      expect(result.id).toBe(documentId);
    });

    it('is uploader only, even for an admin', async () => {
      (VaultDocument.findOne as jest.Mock).mockResolvedValue(mockDoc());
      await expect(renameDocument(documentId, adminUserId, 'bmV3')).rejects.toThrow(ForbiddenError);
    });

    it('404s when not visible', async () => {
      (VaultDocument.findOne as jest.Mock).mockResolvedValue(null);
      await expect(renameDocument(documentId, userId, 'bmV3')).rejects.toThrow(NotFoundError);
    });
  });

  describe('changeScope', () => {
    it('to personal drops every key except the uploader', async () => {
      const doc = mockDoc();
      (VaultDocument.findOne as jest.Mock).mockResolvedValue(doc);
      await changeScope(documentId, userId, { scope: 'personal' });
      expect(doc.scope).toBe('personal');
      expect(VaultDocumentKey.destroy).toHaveBeenCalledTimes(1);
      const arg = (VaultDocumentKey.destroy as jest.Mock).mock.calls[0][0];
      expect(arg.where.documentId).toBe(documentId);
      const ne = Object.getOwnPropertySymbols(arg.where.userId).map((sym) => arg.where.userId[sym]);
      expect(ne).toEqual([userId]);
    });

    it('to personal locks the file row before deleting the keys, so a concurrent grant waits and then sees personal', async () => {
      const txn = { id: 'txn-scope' };
      (sequelize.transaction as jest.Mock).mockImplementation(async (cb: any) => cb(txn));
      const doc = mockDoc();
      (VaultDocument.findOne as jest.Mock).mockResolvedValue(doc);

      await changeScope(documentId, userId, { scope: 'personal' });

      expect(doc.reload).toHaveBeenCalledWith(expect.objectContaining({ transaction: txn, lock: true }));
      expect((doc.reload as jest.Mock).mock.invocationCallOrder[0])
        .toBeLessThan((VaultDocumentKey.destroy as jest.Mock).mock.invocationCallOrder[0]);
      expect(VaultDocumentKey.destroy).toHaveBeenCalledWith(expect.objectContaining({ transaction: txn }));
    });

    it('to household adds the given keys', async () => {
      const doc = mockDoc({ scope: 'personal' });
      (VaultDocument.findOne as jest.Mock).mockResolvedValue(doc);
      (VaultDocumentKey.findAll as jest.Mock).mockResolvedValue([{ documentId, userId, wrappedKey: 'mine' }]);
      await changeScope(documentId, userId, { scope: 'household', keys: [{ userId: otherUserId, sealedKey: sealed }] });
      expect(doc.scope).toBe('household');
      expect(VaultDocumentKey.bulkCreate).toHaveBeenCalledWith(
        [expect.objectContaining({ userId: otherUserId, wrappedKey: sealed })],
        expect.anything(),
      );
    });

    it('is uploader only', async () => {
      (VaultDocument.findOne as jest.Mock).mockResolvedValue(mockDoc());
      await expect(changeScope(documentId, adminUserId, { scope: 'personal' })).rejects.toThrow(ForbiddenError);
      expect(VaultDocumentKey.destroy).not.toHaveBeenCalled();
    });

    it('refuses to share with a child', async () => {
      (VaultDocument.findOne as jest.Mock).mockResolvedValue(mockDoc({ scope: 'personal' }));
      await expect(changeScope(documentId, userId, { scope: 'household', keys: [{ userId: childId, sealedKey: sealed }] }))
        .rejects.toThrow(ValidationError);
    });
  });

  describe('deleteDocument', () => {
    it('lets the uploader delete', async () => {
      const doc = mockDoc();
      (VaultDocument.findOne as jest.Mock).mockResolvedValue(doc);
      await deleteDocument(documentId, userId);
      expect(deleteObject).toHaveBeenCalledWith(doc.s3Key);
      expect(doc.destroy).toHaveBeenCalledWith({ force: true, transaction: expect.anything() });
      expect(VaultDocumentKey.destroy).toHaveBeenCalledWith({ where: { documentId }, transaction: expect.anything() });
    });

    it('lets a household admin delete a household file', async () => {
      const doc = mockDoc({ uploadedBy: otherUserId });
      (VaultDocument.findOne as jest.Mock).mockResolvedValue(doc);
      await deleteDocument(documentId, adminUserId);
      expect(deleteObject).toHaveBeenCalled();
      expect(doc.destroy).toHaveBeenCalled();
    });

    it('refuses a plain member who did not upload it', async () => {
      (VaultDocument.findOne as jest.Mock).mockResolvedValue(mockDoc({ uploadedBy: otherUserId }));
      await expect(deleteDocument(documentId, userId)).rejects.toThrow(ForbiddenError);
      expect(deleteObject).not.toHaveBeenCalled();
    });

    it('only widens the lookup to the whole household for an admin', async () => {
      (VaultDocument.findOne as jest.Mock).mockResolvedValue(mockDoc());
      await deleteDocument(documentId, userId);
      expect(orOf((VaultDocument.findOne as jest.Mock).mock.calls[0][0].where)).toHaveLength(1);
      await deleteDocument(documentId, adminUserId);
      expect(orOf((VaultDocument.findOne as jest.Mock).mock.calls[1][0].where)).toEqual(
        expect.arrayContaining([{ householdId }]),
      );
    });

    it('404s for a document nobody can reach', async () => {
      (VaultDocument.findOne as jest.Mock).mockResolvedValue(null);
      await expect(deleteDocument(documentId, userId)).rejects.toThrow(NotFoundError);
    });
  });

  describe('getStorageUsage', () => {
    it('sums what the caller uploaded', async () => {
      (VaultDocument.findAll as jest.Mock).mockResolvedValue([{ sizeBytes: 500 }, { sizeBytes: 1500 }]);
      expect(await getStorageUsage(userId)).toEqual({ usedBytes: 2000, limitBytes: 2 * 1024 * 1024 * 1024, documentCount: 2 });
    });
  });
});

describe('ADVERSARIAL: the server never decrypts', () => {
  it('vault service.ts contains no decryption routines or crypto imports', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../service.ts'), 'utf-8');
    const code = source.split('\n').filter((line) => !line.trimStart().startsWith('//')).join('\n');
    for (const pattern of [
      /\bsubtle\b/, /AES-GCM/, /RSA-OAEP/, /\.decrypt\b/, /unwrapKey/, /importKey/, /deriveKey/,
      /createCipheriv/, /createDecipheriv/, /from 'crypto'/, /require\(['"]crypto['"]\)/, /from 'node:crypto'/,
    ]) {
      expect(code).not.toMatch(pattern);
    }
  });
});
