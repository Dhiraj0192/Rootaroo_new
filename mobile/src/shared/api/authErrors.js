/** Machine-readable code from an API error body, whichever shape it arrived in. */
export function errorCode(error) {
  const data = error?.response?.data;
  return data?.code ?? data?.error?.code ?? null;
}

/**
 * What a failed request means for the session:
 *   device_revoked  this phone was signed out elsewhere: wipe local secrets, sign out
 *   expired         access token ran out: try a refresh
 *   not_auth        anything else (including a wrong backup password): leave it alone
 */
export function classifyAuthError(error) {
  if (error?.response?.status !== 401) return 'not_auth';
  const code = errorCode(error);
  if (code === 'DEVICE_REVOKED') return 'device_revoked';
  if (code === 'WRONG_BACKUP_SECRET') return 'not_auth';
  return 'expired';
}
