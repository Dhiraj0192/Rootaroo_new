export type VaultScope = 'personal' | 'household';

export interface SealedKeyInput {
  userId: string;
  /** Base64, at most 256 bytes: the file key sealed on the phone to this person's account key. */
  sealedKey: string;
}

export interface CreateVaultDocumentBody {
  scope: VaultScope;
  /** Base64, at most 2 KB: file name and type, sealed on the phone. */
  sealedMeta: string;
  sizeBytes: number;
  keys: SealedKeyInput[];
}

export interface ChangeScopeBody {
  scope: VaultScope;
  keys?: SealedKeyInput[];
}

export interface VaultUploader {
  id: string;
  displayName: string;
}

/** What is returned right after an upload. */
export interface VaultDocumentCreated {
  id: string;
  householdId: string;
  scope: VaultScope;
  sealedMeta: string;
  sizeBytes: number;
  createdAt: string;
  uploadedBy: VaultUploader;
}

export interface VaultDocumentResponse extends VaultDocumentCreated {
  /** The file key sealed to me, or null when no adult has granted it to me yet. */
  mySealedKey: string | null;
  pending: boolean;
  /** Signed link to the encrypted file; only present when I hold a key. */
  downloadUrl: string | null;
}

export interface PaginatedVaultDocuments {
  documents: VaultDocumentResponse[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface VaultMemberResponse {
  userId: string;
  displayName: string;
  publicKey: string;
}

export interface PendingGrantResponse {
  documentId: string;
  mySealedKey: string;
  missing: { userId: string; publicKey: string }[];
}

export interface VaultStorageUsageResponse {
  usedBytes: number;
  limitBytes: number;
  documentCount: number;
}
