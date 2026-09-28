import { generateKeyPairSync } from 'crypto';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const mockEnv = {
  cloudfront: { domain: '', keyPairId: '', privateKey: '' },
};

jest.mock('../../../config/env', () => ({ env: mockEnv }));
jest.mock('../../../config/s3', () => ({ s3Client: {}, S3_BUCKET: 'test-bucket' }));
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('https://test-bucket.s3.amazonaws.com/presigned'),
}));
jest.mock('../logger');

import { getSignedUrl } from '../s3';

describe('getSignedUrl', () => {
  afterEach(() => {
    mockEnv.cloudfront = { domain: '', keyPairId: '', privateKey: '' };
    jest.useRealTimers();
  });

  it('returns null for an empty key', async () => {
    expect(await getSignedUrl(null)).toBeNull();
  });

  it('passes external URLs through unchanged', async () => {
    const url = 'https://lh3.googleusercontent.com/a/photo.jpg';
    expect(await getSignedUrl(url)).toBe(url);
  });

  it('falls back to S3 presigning when CloudFront is not configured', async () => {
    expect(await getSignedUrl('feed/images/a.jpg')).toBe('https://test-bucket.s3.amazonaws.com/presigned');
  });

  describe('with CloudFront configured', () => {
    beforeEach(() => {
      mockEnv.cloudfront = { domain: 'd123.cloudfront.net', keyPairId: 'KTEST123', privateKey };
    });

    it('returns a CloudFront-signed URL for the key', async () => {
      const url = await getSignedUrl('feed/images/a.jpg');

      expect(url).toMatch(/^https:\/\/d123\.cloudfront\.net\/feed\/images\/a\.jpg\?/);
      expect(url).toContain('Key-Pair-Id=KTEST123');
      expect(url).toContain('Signature=');
      expect(url).toContain('Expires=');
    });

    it('returns an identical URL for repeated calls within the same window', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-09-26T01:00:00Z'));
      const first = await getSignedUrl('feed/images/a.jpg');
      jest.setSystemTime(new Date('2026-09-26T05:59:00Z'));
      const second = await getSignedUrl('feed/images/a.jpg');

      expect(second).toBe(first);
    });

    it('stays valid for at least 6 hours after it is issued', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-09-26T05:59:00Z'));
      const url = (await getSignedUrl('feed/images/a.jpg'))!;
      const expires = Number(new URL(url).searchParams.get('Expires')) * 1000;

      expect(expires - Date.now()).toBeGreaterThanOrEqual(6 * 60 * 60 * 1000);
    });

    it('falls back to S3 presigning if CloudFront signing throws', async () => {
      mockEnv.cloudfront.privateKey = 'not-a-real-pem';

      // A key never signed before, so the per-window signature cache can't answer it.
      expect(await getSignedUrl('feed/images/never-signed.jpg')).toBe('https://test-bucket.s3.amazonaws.com/presigned');
    });
  });
});
