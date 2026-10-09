import { onMemberLostVaultAccess, onMemberGainedVaultAccess } from '../access';

jest.mock('../../../database/models', () => ({
  VaultDocument: { findAll: jest.fn() },
  VaultDocumentKey: { destroy: jest.fn() },
}));
import { VaultDocument, VaultDocumentKey } from '../../../database/models';

describe('onMemberLostVaultAccess', () => {
  beforeEach(() => jest.resetAllMocks());

  it("removes that person's keys for the household files of that household only", async () => {
    (VaultDocument.findAll as jest.Mock).mockResolvedValue([{ id: 'd1' }, { id: 'd2' }]);
    await onMemberLostVaultAccess('u1', 'h1');
    expect(VaultDocument.findAll).toHaveBeenCalledWith({ where: { householdId: 'h1', scope: 'household' }, attributes: ['id'], transaction: undefined });
    expect(VaultDocumentKey.destroy).toHaveBeenCalledWith({ where: { userId: 'u1', documentId: ['d1', 'd2'] }, transaction: undefined });
  });

  it('does nothing when the household has no shared files', async () => {
    (VaultDocument.findAll as jest.Mock).mockResolvedValue([]);
    await onMemberLostVaultAccess('u1', 'h1');
    expect(VaultDocumentKey.destroy).not.toHaveBeenCalled();
  });

  it('runs both queries on the given transaction', async () => {
    const transaction = { id: 't' };
    (VaultDocument.findAll as jest.Mock).mockResolvedValue([{ id: 'd1' }]);
    await onMemberLostVaultAccess('u1', 'h1', transaction as never);
    expect(VaultDocument.findAll).toHaveBeenCalledWith(expect.objectContaining({ transaction }));
    expect(VaultDocumentKey.destroy).toHaveBeenCalledWith(expect.objectContaining({ transaction }));
  });
});

describe('onMemberGainedVaultAccess', () => {
  beforeEach(() => jest.resetAllMocks());

  it('deletes leftover keys so access only ever comes from a fresh grant', async () => {
    const transaction = { id: 't' };
    (VaultDocument.findAll as jest.Mock).mockResolvedValue([{ id: 'd1' }]);
    await onMemberGainedVaultAccess('u1', 'h1', transaction as never);
    expect(VaultDocumentKey.destroy).toHaveBeenCalledWith({ where: { userId: 'u1', documentId: ['d1'] }, transaction });
  });
});
