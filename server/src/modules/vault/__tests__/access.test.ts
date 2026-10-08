import { onMemberLostVaultAccess } from '../access';

jest.mock('../../../database/models', () => ({
  VaultDocument: { findAll: jest.fn() },
  VaultDocumentKey: { destroy: jest.fn() },
}));
import { VaultDocument, VaultDocumentKey } from '../../../database/models';

describe('onMemberLostVaultAccess', () => {
  beforeEach(() => jest.resetAllMocks());

  it('removes that person\'s keys for the household files of that household only', async () => {
    (VaultDocument.findAll as jest.Mock).mockResolvedValue([{ id: 'd1' }, { id: 'd2' }]);
    await onMemberLostVaultAccess('u1', 'h1');
    expect(VaultDocument.findAll).toHaveBeenCalledWith({ where: { householdId: 'h1', scope: 'household' }, attributes: ['id'] });
    expect(VaultDocumentKey.destroy).toHaveBeenCalledWith({ where: { userId: 'u1', documentId: ['d1', 'd2'] } });
  });

  it('does nothing when the household has no shared files', async () => {
    (VaultDocument.findAll as jest.Mock).mockResolvedValue([]);
    await onMemberLostVaultAccess('u1', 'h1');
    expect(VaultDocumentKey.destroy).not.toHaveBeenCalled();
  });
});
