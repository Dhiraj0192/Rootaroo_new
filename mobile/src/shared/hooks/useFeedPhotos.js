import { useEffect, useMemo, useRef } from 'react';
import { useFeedStore } from '../store/feedStore';
import apiClient from '../api/client';

function absoluteUrl(url) {
  if (!url) return null;
  if (url.startsWith('http')) return url;
  const base = (apiClient.defaults.baseURL || '').replace(/\/api\/v1\/?$/, '');
  return `${base}${url}`;
}

/**
 * Every photo in the feed, flattened out of the shared feed store — the same
 * posts FeedScreen renders. Nothing is stored a second time: the Dashboard
 * carousel and the photo gallery both read this one list, so a post added
 * anywhere (including via the store's optimistic `prependPost`) shows up in
 * both without another round trip.
 *
 * Pass `autoLoad: false` from a screen that is only ever reached from one that
 * has already populated the store.
 */
export function useFeedPhotos({ autoLoad = true } = {}) {
  const posts = useFeedStore((s) => s.posts);
  const fetchFeed = useFeedStore((s) => s.fetchFeed);
  const stable = useRef({ key: null, photos: [] });

  useEffect(() => {
    if (autoLoad && posts.length === 0) fetchFeed();
  }, [autoLoad, posts.length, fetchFeed]);

  return useMemo(() => {
    const photos = [];
    posts.forEach((post) => {
      (post.media || []).forEach((m) => {
        const fullUri = absoluteUrl(m?.mediaUrl);
        // Thumbnails are for the grid/carousel; the full-screen viewer
        // still wants the original so it isn't stretching a 480px image
        // across the whole device — see PhotoGalleryScreen's Modal.
        const uri = absoluteUrl(m?.thumbnailUrl) || fullUri;
        if (!uri) return;
        photos.push({ id: m.id ?? `${post.id}:${uri}`, postId: post.id, uri, fullUri: fullUri || uri });
      });
    });
    // Refetches hand back a fresh `posts` array even when the photos are
    // identical. Keep the previous list in that case so consumers (the
    // carousel especially) are not reset on every focus.
    const key = photos.map((p) => p.uri).join('|');
    if (stable.current.key === key) return stable.current.photos;
    stable.current = { key, photos };
    return photos;
  }, [posts]);
}
