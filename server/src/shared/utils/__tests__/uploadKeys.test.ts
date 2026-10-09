import { env } from '../../../config/env';
import { userUploadFolder, assertOwnUploadKey, storageKeyFromOwnUrl } from '../uploadKeys';
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

  it('outside links are Google photos only, not any https site', () => {
    for (const url of ['https://example.com/me.jpg', 'https://googleusercontent.com.evil.test/a', 'http://lh3.googleusercontent.com/a']) {
      expect(() => assertOwnUploadKey(url, me, ['avatars'], { allowExternalUrl: true })).toThrow(ForbiddenError);
    }
  });
});

describe('storageKeyFromOwnUrl', () => {
  const saved = { bucket: env.s3.bucket, cdn: env.cloudfront.domain };
  beforeEach(() => { env.s3.bucket = 'rootaroo-prod'; env.cloudfront.domain = 'd123.cloudfront.net'; });
  afterEach(() => { env.s3.bucket = saved.bucket; env.cloudfront.domain = saved.cdn; });

  it('reads the key back out of our S3 and CloudFront links', () => {
    expect(storageKeyFromOwnUrl(`https://rootaroo-prod.s3.us-east-1.amazonaws.com/avatars/${me}/a.jpg?X-Amz-Signature=x`)).toBe(`avatars/${me}/a.jpg`);
    expect(storageKeyFromOwnUrl(`https://s3.us-east-1.amazonaws.com/rootaroo-prod/avatars/${me}/a.jpg`)).toBe(`avatars/${me}/a.jpg`);
    expect(storageKeyFromOwnUrl(`https://d123.cloudfront.net/avatars/${me}/a.jpg?Signature=x&Key-Pair-Id=k`)).toBe(`avatars/${me}/a.jpg`);
  });

  it('is null for anything that is not ours', () => {
    for (const url of ['https://lh3.googleusercontent.com/a/photo', 'https://other-bucket.s3.us-east-1.amazonaws.com/avatars/x', `avatars/${me}/a.jpg`, 'not a url']) {
      expect(storageKeyFromOwnUrl(url)).toBeNull();
    }
  });
});
