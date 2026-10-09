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
const PAGE_SIZE = 20;

async function repo() {
  const { getVaultRepo } = await import('../vault/vaultRepo');
  return getVaultRepo();
}

const messageOf = (error, fallback) => error?.response?.data?.message || error?.message || fallback;

/** Documents here are already decrypted by the vault repo; the server only sent ciphertext. */
export const useVaultStore = create()((set, get) => ({
  documents: [],
  cursor: null,
  hasMore: true,
  loading: false,
  refreshing: false,
  error: null,

  fetchDocuments: async (refresh = false) => {
    set(refresh ? { refreshing: true, error: null } : { loading: true, error: null });
    try {
      const result = await withTimeout((await repo()).list({ limit: PAGE_SIZE }), FETCH_TIMEOUT, 'Fetching documents');
      set({
        documents: result.documents,
        cursor: result.nextCursor,
        hasMore: !!result.nextCursor,
        loading: false,
        refreshing: false,
      });
    } catch (error) {
      set({ error: messageOf(error, 'Failed to load documents'), loading: false, refreshing: false });
    }
  },

  fetchMoreDocuments: async () => {
    const { cursor, hasMore, loading } = get();
    if (!hasMore || loading) return;
    set({ loading: true });
    try {
      const result = await withTimeout(
        (await repo()).list({ cursor: cursor || undefined, limit: PAGE_SIZE }),
        FETCH_TIMEOUT,
        'Fetching more documents'
      );
      set({
        documents: [...get().documents, ...result.documents],
        cursor: result.nextCursor,
        hasMore: !!result.nextCursor,
        loading: false,
      });
    } catch (error) {
      set({ error: messageOf(error, 'Failed to load more documents'), loading: false });
    }
  },

  prependDocument: (document) => set((s) => ({ documents: [document, ...s.documents.filter((d) => d.id !== document.id)] })),
  removeDocument: (id) => set((s) => ({ documents: s.documents.filter((d) => d.id !== id) })),
  updateDocument: (document) => set((s) => ({ documents: s.documents.map((d) => (d.id === document.id ? document : d)) })),
}));
