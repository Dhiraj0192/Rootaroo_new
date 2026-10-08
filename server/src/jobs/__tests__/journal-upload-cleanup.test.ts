import { Op } from 'sequelize';
import { cleanupUnattachedJournalUploads } from '../journal-upload-cleanup';
import { JournalUpload } from '../../database/models';
import { deleteObject } from '../../shared/utils/s3';

jest.mock('node-cron', () => ({ schedule: jest.fn() }));
jest.mock('../../database/models', () => ({
  JournalUpload: { findAll: jest.fn(), destroy: jest.fn() },
}));
jest.mock('../../shared/utils/s3', () => ({ deleteObject: jest.fn() }));
jest.mock('../../shared/utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const uploads = JournalUpload as any;
const del = deleteObject as jest.Mock;
const NOW = new Date('2026-10-10T12:00:00Z');

beforeEach(() => {
  jest.clearAllMocks();
  del.mockResolvedValue(undefined);
  uploads.destroy.mockResolvedValue(0);
});

describe('cleanupUnattachedJournalUploads', () => {
  it('looks only at uploads never attached and older than 24 hours', async () => {
    uploads.findAll.mockResolvedValue([]);
    await cleanupUnattachedJournalUploads(NOW);
    const where = uploads.findAll.mock.calls[0][0].where;
    expect(where.attachedAt).toBeNull();
    const cutoff = where.createdAt[Op.lt] as Date;
    expect(cutoff.toISOString()).toBe('2026-10-09T12:00:00.000Z');
  });

  it('deletes the object from storage and then the row', async () => {
    uploads.findAll.mockResolvedValue([{ key: 'journal/blobs/u/a' }, { key: 'journal/blobs/u/b' }]);
    const n = await cleanupUnattachedJournalUploads(NOW);
    expect(del).toHaveBeenCalledWith('journal/blobs/u/a');
    expect(del).toHaveBeenCalledWith('journal/blobs/u/b');
    expect(uploads.destroy).toHaveBeenCalledWith({ where: { key: ['journal/blobs/u/a', 'journal/blobs/u/b'] } });
    expect(n).toBe(2);
  });

  it('keeps the row (to retry tomorrow) when the storage delete fails', async () => {
    uploads.findAll.mockResolvedValue([{ key: 'k1' }, { key: 'k2' }]);
    del.mockRejectedValueOnce(new Error('s3 down'));
    const n = await cleanupUnattachedJournalUploads(NOW);
    expect(uploads.destroy).toHaveBeenCalledWith({ where: { key: ['k2'] } });
    expect(n).toBe(1);
  });

  it('does nothing when there are no stale uploads', async () => {
    uploads.findAll.mockResolvedValue([]);
    expect(await cleanupUnattachedJournalUploads(NOW)).toBe(0);
    expect(del).not.toHaveBeenCalled();
    expect(uploads.destroy).not.toHaveBeenCalled();
  });
});
