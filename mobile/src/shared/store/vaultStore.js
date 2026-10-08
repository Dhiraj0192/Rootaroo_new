import { create } from 'zustand';

/**
 * Hard timeout so `loading` can never be stuck true. The auth refresh path
 * (client.ts) can queue requests behind a raw axios.post with no timeout, which
 * would otherwise leave the vault grid on "Loading…" forever.
 */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out`)), ms)
    ),
  ]);
}

const FETCH_TIMEOUT = 12000; // under the axios 15s timeout so we surface our own message

const fetchDocumentsImpl = async (set, get, refresh) => {
  if (refresh) {
    set({ refreshing: true, error: null });
  } else {
    set({ loading: true, error: null });
  }

  try {
    const { vaultApi } = await import('../api/vault');
    const result = await withTimeout(
      vaultApi.listDocuments({ limit: 20 }),
      FETCH_TIMEOUT,
      'Fetching documents'
    );
    set({
      documents: result.documents,
      cursor: result.nextCursor,
      hasMore: result.hasMore,
      loading: false,
      refreshing: false,
    });
  } catch (error) {
    set({
      error: error?.response?.data?.message || 'Failed to load documents',
      loading: false,
      refreshing: false,
    });
  }
};

const fetchMoreDocumentsImpl = async (set, get) => {
  const { cursor, hasMore, loading } = get();
  if (!hasMore || loading) return;

  set({ loading: true });
  try {
    const { vaultApi } = await import('../api/vault');
    const result = await withTimeout(
      vaultApi.listDocuments({ cursor: cursor || undefined, limit: 20 }),
      FETCH_TIMEOUT,
      'Fetching more documents'
    );
    set({
      documents: [...get().documents, ...result.documents],
      cursor: result.nextCursor,
      hasMore: result.hasMore,
      loading: false,
    });
  } catch (error) {
    set({
      error: error?.response?.data?.message || 'Failed to load more documents',
      loading: false,
    });
  }
};

const prependDocumentImpl = (document) => (state) => ({
  documents: [document, ...state.documents],
});

const removeDocumentImpl = (id) => (state) => ({
  documents: state.documents.filter((d) => d.id !== id),
});

const updateDocumentImpl = (document) => (state) => ({
  documents: state.documents.map((d) => (d.id === document.id ? document : d)),
});

const fetchStorageUsageImpl = async (set, get) => {
  set({ storageLoading: true });
  try {
    const { vaultApi } = await import('../api/vault');
    const usage = await vaultApi.getSummary();
    set({ storageUsage: usage, storageLoading: false });
  } catch (error) {
    set({ storageLoading: false });
  }
};

const initialState = {
  documents: [],
  cursor: null,
  hasMore: true,
  loading: false,
  refreshing: false,
  error: null,
  storageUsage: null,
  storageLoading: false,
  fetchDocuments: () => Promise.resolve(),
  fetchMoreDocuments: () => Promise.resolve(),
  prependDocument: () => {},
  removeDocument: () => {},
  updateDocument: () => {},
  fetchStorageUsage: () => Promise.resolve(),
};

export const useVaultStore = create()(
  (set, get) => ({
    ...initialState,

    fetchDocuments: (refresh = false) => fetchDocumentsImpl(set, get, refresh),
    fetchMoreDocuments: () => fetchMoreDocumentsImpl(set, get),
    prependDocument: (document) => set(prependDocumentImpl(document)),
    removeDocument: (id) => set(removeDocumentImpl(id)),
    updateDocument: (document) => set(updateDocumentImpl(document)),
    fetchStorageUsage: () => fetchStorageUsageImpl(set, get),
  })
);
