import { uploadJournalBlobs } from '../upload';

describe('uploadJournalBlobs limits', () => {
  it('allows at most 5 files of 10 MB each per request', () => {
    const { limits } = uploadJournalBlobs as unknown as { limits: { files: number; fileSize: number } };
    expect(limits.files).toBe(5);
    expect(limits.fileSize).toBe(10 * 1024 * 1024);
  });
});
