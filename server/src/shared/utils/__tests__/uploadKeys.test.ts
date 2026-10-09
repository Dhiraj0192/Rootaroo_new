import { userUploadFolder, assertOwnUploadKey } from '../uploadKeys';
import { ForbiddenError } from '../errors';

const me = '550e8400-e29b-41d4-a716-446655440001';
const other = '660e8400-e29b-41d4-a716-446655440002';

describe('userUploadFolder', () => {
  it('puts every upload under the uploader', () => {
    expect(userUploadFolder('journal/images', me)).toBe(`journal/images/${me}`);
  });
});

describe('assertOwnUploadKey', () => {
  it('accepts a key the caller uploaded in an allowed area', () => {
    expect(() => assertOwnUploadKey(`journal/images/${me}/a1.jpg`, me, ['journal/images'])).not.toThrow();
    expect(() => assertOwnUploadKey(`journal/thumbnails/${me}/a1.jpg`, me, ['journal/images', 'journal/thumbnails'])).not.toThrow();
  });

  it("rejects someone else's upload", () => {
    expect(() => assertOwnUploadKey(`journal/images/${other}/a1.jpg`, me, ['journal/images'])).toThrow(ForbiddenError);
  });

  it('rejects other areas, such as vault files', () => {
    expect(() => assertOwnUploadKey(`vault/household-1/${me}`, me, ['journal/images'])).toThrow(ForbiddenError);
    expect(() => assertOwnUploadKey(`journal/images/${me}/x.jpg`, me, ['chat/voice'])).toThrow(ForbiddenError);
  });

  it('rejects old keys without an owner folder', () => {
    expect(() => assertOwnUploadKey('journal/images/a1.jpg', me, ['journal/images'])).toThrow(ForbiddenError);
  });

  it('rejects path tricks', () => {
    expect(() => assertOwnUploadKey(`journal/images/${me}/../${other}/a1.jpg`, me, ['journal/images'])).toThrow(ForbiddenError);
    expect(() => assertOwnUploadKey(`journal/images/${me}/sub/a1.jpg`, me, ['journal/images'])).toThrow(ForbiddenError);
    expect(() => assertOwnUploadKey(`/journal/images/${me}/a1.jpg`, me, ['journal/images'])).toThrow(ForbiddenError);
    expect(() => assertOwnUploadKey(`journal/images/${me}/`, me, ['journal/images'])).toThrow(ForbiddenError);
  });

  it('allows outside web links only where the caller opts in (profile photos from Google or Apple)', () => {
    expect(() => assertOwnUploadKey('https://lh3.googleusercontent.com/a/photo', me, ['avatars'])).toThrow(ForbiddenError);
    expect(() => assertOwnUploadKey('https://lh3.googleusercontent.com/a/photo', me, ['avatars'], { allowExternalUrl: true })).not.toThrow();
    expect(() => assertOwnUploadKey('http://169.254.169.254/latest', me, ['avatars'], { allowExternalUrl: true })).toThrow(ForbiddenError);
  });
});
