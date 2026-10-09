import { uploadJournalBlobs } from '../upload';

describe('uploadJournalBlobs limits', () => {
  it('allows at most 5 files of 10 MB each per request', () => {
    const { limits } = uploadJournalBlobs as unknown as { limits: { files: number; fileSize: number } };
    expect(limits.files).toBe(5);
    expect(limits.fileSize).toBe(10 * 1024 * 1024);
  });

  it('refuses a non-ciphertext file as a 400, not a server error', () => {
    const { fileFilter } = uploadJournalBlobs as unknown as { fileFilter: (req: unknown, file: unknown, cb: (e: unknown, ok?: boolean) => void) => void };
    const cb = jest.fn();
    fileFilter({}, { mimetype: 'image/jpeg', originalname: 'a.jpg' }, cb);
    expect(cb.mock.calls[0][0]).toMatchObject({ statusCode: 400 });
  });
});
