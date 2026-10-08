import { requireAdminApiKey } from '../adminApiKey';
import { env } from '../../../config/env';

describe('requireAdminApiKey', () => {
  const next = jest.fn();
  const res = { locals: {} } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    env.adminApiKey = 'correct-key';
  });

  it('should call next() when the header matches the configured key', () => {
    const req = { headers: { 'x-admin-api-key': 'correct-key' } } as any;

    requireAdminApiKey(req, res, next);

    expect(next).toHaveBeenCalledWith();
  });

  it('should throw when the header is missing', () => {
    const req = { headers: {} } as any;

    expect(() => requireAdminApiKey(req, res, next)).toThrow('Invalid or missing admin API key');
  });

  it('should throw when the header is wrong', () => {
    const req = { headers: { 'x-admin-api-key': 'wrong-key' } } as any;

    expect(() => requireAdminApiKey(req, res, next)).toThrow('Invalid or missing admin API key');
  });

  it('should reject an empty header even when ADMIN_API_KEY is unset', () => {
    env.adminApiKey = '';
    const req = { headers: { 'x-admin-api-key': '' } } as any;

    expect(() => requireAdminApiKey(req, res, next)).toThrow('Invalid or missing admin API key');
  });
});
