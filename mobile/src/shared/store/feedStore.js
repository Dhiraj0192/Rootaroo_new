import { create } from 'zustand';
import { feedApi } from '../api/feed';
import { readCache, writeCache } from '../cache/screenCache';

const FEED_CACHE_KEY = 'feed';

// Home (on focus and during the splash prefetch) and Feed (on mount) both
// ask for the first page at startup — they share one request, and one that
// just finished counts as fresh.
let firstPageRequest = null;
const FIRST_PAGE_FRESH_MS = 10000;

function cacheFirstPage(data) {
  writeCache(FEED_CACHE_KEY, {
    posts: data.posts,
    nextCursor: data.nextCursor,
    hasMore: data.hasMore,
  });
}

export const useFeedStore = create((set, get) => ({
  posts: [],
  cursor: null,
  hasMore: true,
  loading: false,
  refreshing: false,
  error: null,
  // When the base post list was last (re)fetched from scratch — presigned
  // S3 URLs expire after an hour server-side, so a post sitting in memory
  // since a much earlier fetch can go stale while newer posts (from
  // fetchMore or a realtime prependPost) stay fresh. See refreshIfStale.
  lastFetchedAt: null,

  fetchFeed: async (since) => {
    if (!since && firstPageRequest) return firstPageRequest;
    const { lastFetchedAt } = get();
    if (!since && lastFetchedAt && Date.now() - lastFetchedAt < FIRST_PAGE_FRESH_MS) return;
    // Cold start: show last session's first page while this one loads.
    const cached = get().posts.length === 0 ? readCache(FEED_CACHE_KEY) : null;
    set({
      loading: true,
      error: null,
      ...(cached
        ? {
            posts: cached.posts,
            cursor: cached.nextCursor,
            hasMore: cached.hasMore,
          }
        : {}),
    });
    const request = (async () => {
      try {
        const data = await feedApi.list({ limit: 20, since });
        if (!since) cacheFirstPage(data);
        set({
          posts: data.posts,
          cursor: data.nextCursor,
          hasMore: data.hasMore,
          loading: false,
          lastFetchedAt: Date.now(),
        });
      } catch (e) {
        set({ loading: false, error: e?.message || 'Failed to load feed' });
      }
    })();
    if (since) return request;
    firstPageRequest = request;
    try {
      await request;
    } finally {
      firstPageRequest = null;
    }
  },

  /** Call when the app returns to the foreground. Re-fetches the base feed
   * list (getting fresh signed URLs for every post) if it's been fetched
   * long enough ago that some of its URLs could plausibly have expired. */
  refreshIfStale: (maxAgeMs) => {
    const { lastFetchedAt, refreshing, loading } = get();
    if (refreshing || loading) return;
    if (lastFetchedAt && Date.now() - lastFetchedAt < maxAgeMs) return;
    get().refresh();
  },

  fetchMore: async () => {
    const { cursor, hasMore, loading } = get();
    if (!hasMore || loading) return;
    set({ loading: true });
    try {
      const data = await feedApi.list({ cursor: cursor || undefined, limit: 20 });
      set((state) => ({
        posts: [...state.posts, ...data.posts],
        cursor: data.nextCursor,
        hasMore: data.hasMore,
        loading: false,
      }));
    } catch {
      set({ loading: false });
    }
  },

  prependPost: (post) => {
    set((state) => {
      // Deduplicate — post already present (socket + creator both deliver it)
      if (state.posts.some((p) => p.id === post.id)) return state;
      return { posts: [post, ...state.posts] };
    });
  },

  removePost: (postId) => {
    set((state) => ({ posts: state.posts.filter((p) => p.id !== postId) }));
  },

  incrementCommentCount: (postId) => {
    set((state) => ({
      posts: state.posts.map((p) =>
        p.id === postId ? { ...p, commentCount: p.commentCount + 1 } : p,
      ),
    }));
  },

  toggleLike: async (postId) => {
    // Optimistic update
    set((state) => ({
      posts: state.posts.map((p) =>
        p.id === postId
          ? {
              ...p,
              isLikedByMe: !p.isLikedByMe,
              likeCount: p.isLikedByMe ? p.likeCount - 1 : p.likeCount + 1,
            }
          : p,
      ),
    }));
    // Persist to server; revert on failure
    try {
      const current = useFeedStore.getState().posts.find((p) => p.id === postId);
      if (current?.isLikedByMe) {
        await feedApi.like(postId);
      } else {
        await feedApi.unlike(postId);
      }
    } catch {
      // Revert optimistic update
      set((state) => ({
        posts: state.posts.map((p) =>
          p.id === postId
            ? {
                ...p,
                isLikedByMe: !p.isLikedByMe,
                likeCount: p.isLikedByMe ? p.likeCount - 1 : p.likeCount + 1,
              }
            : p,
        ),
      }));
    }
  },

  refresh: async () => {
    set({ refreshing: true });
    try {
      const data = await feedApi.list({ limit: 20 });
      cacheFirstPage(data);
      set({
        posts: data.posts,
        cursor: data.nextCursor,
        hasMore: data.hasMore,
        refreshing: false,
        lastFetchedAt: Date.now(),
      });
    } catch {
      set({ refreshing: false });
    }
  },
}));
