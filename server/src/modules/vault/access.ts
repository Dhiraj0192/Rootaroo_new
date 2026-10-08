import { VaultDocument, VaultDocumentKey } from '../../database/models';

/**
 * Called when someone stops being an adult member of a household (removed, left,
 * made a child, or the household is deleted): they lose their sealed key for every
 * shared file of that household. Their personal files are not touched. A copy they
 * already opened on their phone cannot be taken back (docs/e2e/vault.md).
 */
export async function onMemberLostVaultAccess(userId: string, householdId: string): Promise<void> {
  const documents = await VaultDocument.findAll({ where: { householdId, scope: 'household' }, attributes: ['id'] });
  if (documents.length === 0) return;
  await VaultDocumentKey.destroy({ where: { userId, documentId: documents.map((d) => d.id) } });
}
