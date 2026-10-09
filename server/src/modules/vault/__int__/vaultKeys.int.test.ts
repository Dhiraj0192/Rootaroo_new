import { v4 as uuidv4 } from 'uuid';
import { setupAssociations, AccountKey, VaultDocument, VaultDocumentKey } from '../../../database/models';
import { resetDb, closeIntResources } from '../../../test/int/db';
import { createHouseholdWithAdmin } from '../../../test/factories';

beforeAll(() => setupAssociations());
beforeEach(() => resetDb());
afterAll(() => closeIntResources());

async function makeDocument(householdId: string, uploadedBy: string) {
  return VaultDocument.create({
    id: uuidv4(), householdId, uploadedBy, sealedMeta: 'c2VhbGVk', scope: 'household',
    sizeBytes: 10, s3Key: `vault/${uploadedBy}/${uuidv4()}`,
  });
}

describe('vault key tables (real database)', () => {
  it('a person has at most one account key', async () => {
    const { admin } = await createHouseholdWithAdmin({ cohort: 'test' });
    await AccountKey.create({ userId: admin.id, publicKey: 'pk-1', keyVersion: 1 });
    await expect(AccountKey.create({ userId: admin.id, publicKey: 'pk-2', keyVersion: 1 })).rejects.toThrow();
    expect(await AccountKey.count({ where: { userId: admin.id } })).toBe(1);
  });

  it('a document has at most one sealed key per person', async () => {
    const { household, admin } = await createHouseholdWithAdmin({ cohort: 'test' });
    const doc = await makeDocument(household.id, admin.id);
    await VaultDocumentKey.create({ documentId: doc.id, userId: admin.id, wrappedKey: 'w1' });
    await expect(VaultDocumentKey.create({ documentId: doc.id, userId: admin.id, wrappedKey: 'w2' })).rejects.toThrow();
  });

  it('deleting a document removes its sealed keys', async () => {
    const { household, admin } = await createHouseholdWithAdmin({ cohort: 'test' });
    const doc = await makeDocument(household.id, admin.id);
    await VaultDocumentKey.create({ documentId: doc.id, userId: admin.id, wrappedKey: 'w1' });
    await doc.destroy();
    expect(await VaultDocumentKey.count({ where: { documentId: doc.id } })).toBe(0);
  });
});
