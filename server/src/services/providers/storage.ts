import type { StorageProvider } from '../types';

// Lazy so the AWS SDK clients are only built when storage is actually used.
const s3 = (): typeof import('../../shared/utils/s3') =>
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('../../shared/utils/s3');

export const s3Storage: StorageProvider = {
  name: 's3',
  uploadBuffer: (...args) => s3().uploadBuffer(...args),
  deleteObject: (key) => s3().deleteObject(key),
  downloadObjectBuffer: (key) => s3().downloadObjectBuffer(key),
  getSignedUrl: (key) => s3().getSignedUrl(key),
};
