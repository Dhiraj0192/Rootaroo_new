const { classifyAuthError } = require('../authErrors');

const err = (status, data) => ({ response: { status, data } });

describe('classifyAuthError', () => {
  it('a revoked device must wipe local secrets and sign out', () => {
    expect(classifyAuthError(err(401, { code: 'DEVICE_REVOKED' }))).toBe('device_revoked');
    expect(classifyAuthError(err(401, { error: { code: 'DEVICE_REVOKED' } }))).toBe('device_revoked');
  });

  it('a wrong backup password is not an expired session (no refresh, no sign-out)', () => {
    expect(classifyAuthError(err(401, { code: 'WRONG_BACKUP_SECRET', attemptsLeft: 4 }))).toBe('not_auth');
  });

  it('other 401s are expired sessions that try a refresh', () => {
    expect(classifyAuthError(err(401, { error: 'Invalid or expired token' }))).toBe('expired');
  });

  it('non-401 errors are not auth errors', () => {
    expect(classifyAuthError(err(403, {}))).toBe('not_auth');
    expect(classifyAuthError(new Error('Network Error'))).toBe('not_auth');
  });
});
