import type { Transaction } from 'sequelize';
import { VaultDocument, VaultDocumentKey } from '../../database/models';

async function deleteHouseholdFileKeys(userId: string, householdId: string, transaction?: Transaction): Promise<void> {
  const documents = await VaultDocument.findAll({ where: { householdId, scope: 'household' }, attributes: ['id'], transaction });
  if (documents.length === 0) return;
  await VaultDocumentKey.destroy({ where: { userId, documentId: documents.map((d) => d.id) }, transaction });
}

/**
 * Called when someone stops being a member of a household (removed, left, or the
 * household is deleted). Changing role (including becoming a child) keeps access. They lose their sealed key for every
 * shared file of that household. Their personal files are not touched. A copy they
 * already opened on their phone cannot be taken back (docs/e2e/vault.md).
 * Pass the transaction of the membership change so no grant can slip in between.
 */
export async function onMemberLostVaultAccess(userId: string, householdId: string, transaction?: Transaction): Promise<void> {
  await deleteHouseholdFileKeys(userId, householdId, transaction);
}

/**
 * Called when someone joins a household: any key row left over from an earlier
 * membership is deleted, so access only ever comes from a fresh grant by a current member.
 */
export async function onMemberGainedVaultAccess(userId: string, householdId: string, transaction?: Transaction): Promise<void> {
  await deleteHouseholdFileKeys(userId, householdId, transaction);
}
