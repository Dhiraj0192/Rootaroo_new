import type { KdfParams } from '../../database/models/KeyBackup';

export interface AccountKeyResponse {
  publicKey: string | null;
  holdsKey: boolean;
  hasBackup: boolean;
  keyVersion: number | null;
}

export interface TransferSessionResponse {
  sessionId: string;
  status: 'open' | 'sent' | 'done' | 'expired';
  expiresAt: string;
  newEphemeralPublicKey: string;
  oldEphemeralPublicKey: string | null;
  /** Only returned to the session's new phone. */
  payload: string | null;
}

export interface PutBackupBody {
  kind: 'password' | 'recovery_code';
  salt: string;
  kdf: KdfParams;
  authKey: string;
  blob: string;
}

export interface BackupStatusResponse {
  kind: 'password' | 'recovery_code';
  createdAt: string;
  attemptsLeft: number;
}

export interface RestoreParamsResponse {
  salt: string;
  kdf: KdfParams;
  kind: 'password' | 'recovery_code';
  attemptsLeft: number;
  restoreToken: string;
}
