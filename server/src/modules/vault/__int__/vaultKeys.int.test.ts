import { v4 as uuidv4 } from 'uuid';
import { setupAssociations, VaultKey, VaultDocument, VaultDocumentKey } from '../../../database/models';
import { resetDb, closeIntResources } from '../../../test/int/db';
import { createHouseholdWithAdmin } from '../../../test/factories';

beforeAll(() => setupAssociations());
beforeEach(() => resetDb());
afterAll(() => closeIntResources());

describe('vault key tables (real database)', () => {
  it('saving a key twice updates the one row instead of adding a second', async () => {
    const { household, admin } = await createHouseholdWithAdmin({ cohort: 'test' });
    await VaultKey.upsert({ userId: admin.id, householdId: household.id, publicKey: 'pk-1', privateKeyEncrypted: 'none' });
    await VaultKey.upsert({ userId: admin.id, householdId: household.id, publicKey: 'pk-2', privateKeyEncrypted: 'none' });
    const rows = await VaultKey.findAll({ where: { userId: admin.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].publicKey).toBe('pk-2');
  });

  it('a document has at most one wrapped key per person', async () => {
    const { household, admin } = await createHouseholdWithAdmin({ cohort: 'test' });
    const doc = await VaultDocument.create({
      id: uuidv4(), householdId: household.id, uploadedBy: admin.id, name: 'x', mimeType: 'application/pdf',
      sizeBytes: 10, encryptedKey: 'k', iv: 'iv', s3Key: `vault/${household.id}/${uuidv4()}`,
    });
    await VaultDocumentKey.create({ documentId: doc.id, userId: admin.id, wrappedKey: 'w1' });
    await expect(VaultDocumentKey.create({ documentId: doc.id, userId: admin.id, wrappedKey: 'w2' })).rejects.toThrow();
  });

  it('deleting a document removes its wrapped keys', async () => {
    const { household, admin } = await createHouseholdWithAdmin({ cohort: 'test' });
    const doc = await VaultDocument.create({
      id: uuidv4(), householdId: household.id, uploadedBy: admin.id, name: 'x', mimeType: 'application/pdf',
      sizeBytes: 10, encryptedKey: 'k', iv: 'iv', s3Key: `vault/${household.id}/${uuidv4()}`,
    });
    await VaultDocumentKey.create({ documentId: doc.id, userId: admin.id, wrappedKey: 'w1' });
    await doc.destroy();
    expect(await VaultDocumentKey.count({ where: { documentId: doc.id } })).toBe(0);
  });
});
