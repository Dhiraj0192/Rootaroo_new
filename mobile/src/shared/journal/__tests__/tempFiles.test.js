const { isUnderDir, deleteTempFiles } = require('../tempFiles');

const CACHE = 'file:///data/user/0/app/cache/';

describe('isUnderDir', () => {
  it('accepts files inside the cache dir', () => {
    expect(isUnderDir(`${CACHE}ImagePicker/a.jpg`, CACHE)).toBe(true);
    expect(isUnderDir(`${CACHE}ImagePicker/a.jpg`, 'file:///data/user/0/app/cache')).toBe(true);
  });

  it("rejects the user's own library photos and look-alike or traversal paths", () => {
    expect(isUnderDir('content://media/external/images/1', CACHE)).toBe(false);
    expect(isUnderDir('file:///storage/emulated/0/DCIM/a.jpg', CACHE)).toBe(false);
    expect(isUnderDir('file:///data/user/0/app/cache-evil/a.jpg', CACHE)).toBe(false);
    expect(isUnderDir(`${CACHE}../files/secret.db`, CACHE)).toBe(false);
    expect(isUnderDir(`${CACHE}%2e%2e/files/secret.db`, CACHE)).toBe(false);
    expect(isUnderDir(undefined, CACHE)).toBe(false);
  });
});

describe('deleteTempFiles', () => {
  it('deletes only files under the cache dir', async () => {
    const remove = jest.fn(async () => {});
    await deleteTempFiles([`${CACHE}ImagePicker/a.jpg`, 'file:///storage/DCIM/keep.jpg', `${CACHE}b.jpg`], { cacheDir: CACHE, remove });
    expect(remove.mock.calls.map((c) => c[0])).toEqual([`${CACHE}ImagePicker/a.jpg`, `${CACHE}b.jpg`]);
  });

  it('keeps going and never throws when a file is already gone', async () => {
    const remove = jest.fn()
      .mockRejectedValueOnce(new Error('missing'))
      .mockResolvedValueOnce(undefined);
    await expect(deleteTempFiles([`${CACHE}a`, `${CACHE}b`], { cacheDir: CACHE, remove })).resolves.toBeUndefined();
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it('handles empty input', async () => {
    const remove = jest.fn();
    await deleteTempFiles(undefined, { cacheDir: CACHE, remove });
    expect(remove).not.toHaveBeenCalled();
  });
});
