import React, { memo, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Dimensions,
  Pressable,
  ScrollView,
  Modal,
  StatusBar,
  Share,
} from 'react-native';
import { Image } from 'expo-image';
import { showAlert } from '../services/themedAlert';
import { Video, ResizeMode } from 'expo-av';
import { colors, fonts, withAlpha } from '../theme';
import Avatar, { resolveUrl } from '../../components/Avatar';

const { width: SCREEN_W } = Dimensions.get('window');

/* ── Helpers ─────────────────────────────────── */

function elapsed(timestamp) {
  const diff = Date.now() - new Date(timestamp).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function parseFeeling(content) {
  if (!content) return { body: '', feeling: null };
  const match = content.match(/\n\nFeeling:\s*(.+)$/);
  if (!match) return { body: content, feeling: null };
  return {
    body: content.slice(0, match.index).trim(),
    feeling: match[1].trim(),
  };
}

/* ── Heart Icon ─────────────────────────────── */

function HeartIcon({ filled, size = 24 }) {
  return (
    <Text style={{ fontSize: size, color: filled ? colors.dangerHeart : colors.ink, lineHeight: size + 2 }}>
      {filled ? '♥' : '♡'}
    </Text>
  );
}

/* ── Comment Icon ───────────────────────────── */

function CommentIcon({ size = 22 }) {
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <View
        style={{
          width: size * 0.85,
          height: size * 0.7,
          borderRadius: size * 0.28,
          borderWidth: 1.6,
          borderColor: colors.ink,
        }}
      />
      <View
        style={{
          position: 'absolute',
          bottom: 1,
          left: size * 0.22,
          width: 0,
          height: 0,
          borderLeftWidth: 4,
          borderRightWidth: 4,
          borderTopWidth: 5,
          borderLeftColor: 'transparent',
          borderRightColor: 'transparent',
          borderTopColor: colors.ink,
        }}
      />
    </View>
  );
}

/* ── Media Carousel ─────────────────────────── */

function MediaCarousel({ media, onItemPress }) {
  const [page, setPage] = useState(0);
  const height = media.length === 1 ? SCREEN_W * 1.05 : SCREEN_W * 0.95;

  const onScroll = (e) => {
    const x = e.nativeEvent.contentOffset.x;
    setPage(Math.round(x / SCREEN_W));
  };

  return (
    <View>
      <ScrollView
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onScroll={onScroll}
        scrollEventThrottle={16}
        decelerationRate="fast"
      >
        {media.map((item) => {
          const isVideo = item.mediaType === 'video';
          // The video's PLAYABLE source is always the real video file —
          // never the poster thumbnail, which is a plain JPEG expo-av
          // can't play. Photos still prefer the thumbnail for the grid.
          const posterUri = resolveUrl(item.thumbnailUrl);
          const uri = isVideo ? resolveUrl(item.mediaUrl) : posterUri || resolveUrl(item.mediaUrl);
          return (
            <TouchableOpacity key={item.id} activeOpacity={0.95} onPress={() => onItemPress?.(item)} style={{ width: SCREEN_W, height }}>
              {uri ? (
                isVideo ? (
                  <Video
                    source={{ uri }}
                    posterSource={posterUri ? { uri: posterUri } : undefined}
                    usePoster={!!posterUri}
                    style={styles.mediaFill}
                    resizeMode={ResizeMode.COVER}
                    shouldPlay={false}
                    isMuted
                    useNativeControls={false}
                  />
                ) : (
                  <Image
                    // thumbnailUrl/mediaUrl are presigned S3 links that
                    // change on every fetch — key by the stable item id.
                    source={{ uri, cacheKey: item.id }}
                    style={styles.mediaFill}
                    contentFit="cover"
                    cachePolicy="disk"
                  />
                )
              ) : (
                <View style={styles.mediaMissing}>
                  <Text style={styles.mediaMissingText}>{isVideo ? 'Video' : 'Photo'}</Text>
                </View>
              )}
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {media.length > 1 && (
        <View style={styles.dots}>
          {media.map((m, i) => (
            <View key={m.id} style={[styles.dot, i === page && styles.dotOn]} />
          ))}
        </View>
      )}

      {media.length > 1 && (
        <View style={styles.countBadge}>
          <Text style={styles.countBadgeText}>
            {page + 1}/{media.length}
          </Text>
        </View>
      )}
    </View>
  );
}

/* ── PostCard ───────────────────────────────── */

const PostCard = memo(function PostCard({
  post,
  onOpen,
  onLike,
  onOptions,
  canDelete,
}) {
  const { body, feeling } = parseFeeling(post.content);
  const hasMedia = post.media.length > 0;
  const [viewerMedia, setViewerMedia] = useState(null);

  return (
    <View style={styles.post}>
      {/* Header */}
      <View style={styles.postHead}>
        <Avatar
          url={post.author.avatarUrl}
          emoji={post.author.avatarEmoji}
          name={post.author.displayName}
          id={post.author.id}
          size={38}
        />
        <Pressable style={styles.postMeta} onPress={onOpen}>
          <View style={styles.nameRow}>
            <Text style={styles.authorName} numberOfLines={1}>
              {post.author.displayName}
            </Text>
            {feeling ? (
              <Text style={styles.feelingInline} numberOfLines={1}>
                {' · '}
                {feeling}
              </Text>
            ) : null}
          </View>
          <Text style={styles.timestamp}>{elapsed(post.createdAt)}</Text>
        </Pressable>



        {post.isPinned && (
          <View style={styles.pinChip}>
            <Text style={styles.pinText}>Pinned</Text>
          </View>
        )}

        {canDelete && (
          <TouchableOpacity
            style={styles.moreBtn}
            onPress={() => onOptions?.(post.id)}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Text style={styles.moreDots}>{'···'}</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Caption always shows above media so text is read first */}
      {body ? (
        <Pressable onPress={onOpen} style={!hasMedia ? undefined : styles.captionBlock}>
          <Text style={hasMedia ? styles.caption : styles.captionSolo}>

            {body}
          </Text>
        </Pressable>
      ) : null}

      {/* Sub-header: activity, location, tagged users */}
      {post.activity ||
      post.location ||
      (post.taggedUsers && post.taggedUsers.length > 0) ? (
        <View style={styles.subHeader}>
          {post.activity ? (
            <View style={styles.activityBadge}>
              <Text style={styles.activityBadgeText}>{post.activity}</Text>
            </View>
          ) : null}
          {post.location ? (
            <Text style={styles.subHeaderText}>{'📍'} {post.location}</Text>
          ) : null}
          {post.taggedUsers && post.taggedUsers.length > 0 ? (
            <Text style={styles.subHeaderText}>
              {'👤'} with {post.taggedUsers.map((u) => u.displayName).join(', ')}
            </Text>
          ) : null}
        </View>
      ) : null}



      {hasMedia ? <MediaCarousel media={post.media} onItemPress={(item) => setViewerMedia(item)} /> : null}

      {/* Actions row: like + comment with count */}
      <View style={styles.actionsRow}>
        <View style={styles.actionsLeft}>
          {!hasMedia && (
            <TouchableOpacity
              style={styles.actionBtn}
              onPress={() => onLike(post.id, !post.isLikedByMe)}
              hitSlop={8}
              activeOpacity={0.7}
            >
              <HeartIcon filled={post.isLikedByMe} />
            </TouchableOpacity>
          )}
          {!hasMedia && post.likeCount > 0 && (
            <Text style={styles.actionCount}>{post.likeCount}</Text>
          )}
        </View>

        <TouchableOpacity style={styles.actionsRight} onPress={onOpen} activeOpacity={0.7} hitSlop={8}>
          <CommentIcon />
          {post.commentCount > 0 && (
            <Text style={styles.actionCount}>{post.commentCount}</Text>
          )}
        </TouchableOpacity>
      </View>

      {/* Separator */}
      {(post.likeCount > 0 || post.commentCount > 0) && (
        <View style={styles.actionSep} />
      )}

      {/* Full-screen media viewer */}
      <Modal visible={!!viewerMedia} transparent animationType="fade" onRequestClose={() => setViewerMedia(null)}>
        <View style={styles.viewerOverlay}>
          <StatusBar barStyle="light-content" />
          <View style={styles.viewerTopBar}>
            <TouchableOpacity onPress={() => setViewerMedia(null)} hitSlop={12}>
              <Text style={styles.viewerClose}>✕</Text>
            </TouchableOpacity>
            <TouchableOpacity
              hitSlop={12}
              onPress={async () => {
                if (!viewerMedia) return;
                const uri = resolveUrl(viewerMedia.mediaUrl);
                if (!uri) return;
                showAlert('Media', undefined, [
                  { text: 'Save / Share', onPress: async () => {
                    try {
                      await Share.share({ url: uri, message: uri });
                    } catch {
                      showAlert('Error', 'Could not share media');
                    }
                  } },
                  { text: 'Cancel', style: 'cancel' },
                ]);
              }}
            >
              <Text style={styles.viewerDots}>···</Text>
            </TouchableOpacity>
          </View>
          {viewerMedia && (() => {
            const isVideo = viewerMedia.mediaType === 'video';
            // Same rule as the grid above: video always plays the real
            // file, never the poster thumbnail.
            const uri = isVideo
              ? resolveUrl(viewerMedia.mediaUrl)
              : resolveUrl(viewerMedia.thumbnailUrl) || resolveUrl(viewerMedia.mediaUrl);
            return (
              <View style={styles.viewerContent}>
                {uri ? (
                  isVideo ? (
                    <Video source={{ uri }} style={styles.viewerMedia} resizeMode={ResizeMode.CONTAIN} shouldPlay useNativeControls />
                  ) : (
                    <Image
                      source={{ uri, cacheKey: viewerMedia.id }}
                      style={styles.viewerMedia}
                      contentFit="contain"
                      cachePolicy="disk"
                    />
                  )
                ) : (
                  <Text style={{ color: colors.onAccent, fontFamily: fonts.body }}>Unavailable</Text>
                )}
              </View>
            );
          })()}
        </View>
      </Modal>
    </View>
  );
});

export default PostCard;

/* ── Styles ─────────────────────────────────── */

const styles = StyleSheet.create({
  post: {
    backgroundColor: colors.surface,
    paddingBottom: 12,
    paddingHorizontal: 0,
  },
  postHead: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 22,
    paddingTop: 12,
    paddingBottom: 10,
    gap: 10,
  },
  postMeta: {
    flex: 1,
    minWidth: 0,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  authorName: {
    fontFamily: fonts.bodyBold,
    fontSize: 14,
    fontWeight: '700',
    color: colors.ink,
    flexShrink: 1,
  },
  feelingInline: {
    fontFamily: fonts.body,
    fontSize: 13,
    color: withAlpha(colors.ink, 0.45),
    marginLeft: 4,
    flexShrink: 1,
  },
  timestamp: {
    fontFamily: fonts.body,
    fontSize: 12,
    color: withAlpha(colors.ink, 0.38),
    marginTop: 1,
  },
  pinChip: {
    backgroundColor: withAlpha(colors.legacyGold, 0.15),
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 3,
  },
  pinText: {
    fontFamily: fonts.bodyBold,
    fontSize: 10,
    fontWeight: '700',
    color: colors.legacyGoldDark,
    letterSpacing: 0.3,
  },
  moreBtn: {
    paddingHorizontal: 4,
    paddingVertical: 2,
  },
  moreDots: {
    fontSize: 18,
    fontWeight: '700',
    color: withAlpha(colors.ink, 0.35),
    letterSpacing: 1,
  },

  mediaFill: {
    width: '100%',
    height: '100%',
  },
  mediaMissing: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  mediaMissingText: {
    fontFamily: fonts.bodySemiBold,
    color: withAlpha(colors.white, 0.4),
    fontWeight: '600',
  },
  dots: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 5,
    paddingTop: 10,
  },
  dot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: withAlpha(colors.ink, 0.18),
  },
  dotOn: {
    backgroundColor: colors.legacyGold,
    width: 14,
  },
  countBadge: {
    position: 'absolute',
    top: 12,
    right: 12,
    backgroundColor: withAlpha(colors.shadow, 0.55),
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  countBadgeText: {
    fontFamily: fonts.bodyBold,
    color: colors.onAccent,
    fontSize: 11,
    fontWeight: '700',
  },

  actionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 22,
    paddingTop: 10,
  },
  actionsLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  actionsRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  actionBtn: {
    padding: 2,
  },
  actionCount: {
    fontFamily: fonts.bodyBold,
    fontSize: 13,
    fontWeight: '700',
    color: colors.ink,
  },
  actionSep: {
    height: 1,
    backgroundColor: withAlpha(colors.ink, 0.08),
    marginHorizontal: 22,
    marginTop: 10,
  },

  captionSolo: {
    fontFamily: fonts.display,
    paddingHorizontal: 22,
    paddingBottom: 4,
    fontSize: 16,
    fontWeight: '800',
    lineHeight: 22,
    color: colors.ink,
  },
  captionBlock: {
    paddingHorizontal: 22,
    paddingTop: 6,
  },
  caption: {
    fontFamily: fonts.display,
    fontSize: 16,
    fontWeight: '800',
    lineHeight: 20,
    color: colors.ink,
    paddingHorizontal: 5,
    paddingBottom : 12,
  },
  captionAuthor: {
    fontWeight: '700',
  },


  subHeader: {
    paddingHorizontal: 22,
    paddingBottom: 16,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
  },
  activityBadge: {
    backgroundColor: withAlpha(colors.legacyGold, 0.18),
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  activityBadgeText: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 12,
    fontWeight: '600',
    color: colors.legacyGoldDark,
  },
  subHeaderText: {
    fontFamily: fonts.body,
    fontSize: 12,
    color: withAlpha(colors.ink, 0.45),
  },

  /* ── Full-screen media viewer ────────────────── */
  viewerOverlay: {
    flex: 1,
    backgroundColor: withAlpha(colors.black, 0.92),
    justifyContent: 'center',
    alignItems: 'center',
  },
  viewerTopBar: {
    position: 'absolute',
    top: 50,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    zIndex: 10,
  },
  viewerClose: {
    fontSize: 16,
    color: colors.onAccent,
    fontWeight: '600',
  },
  viewerDots: {
    fontSize: 16,
    color: colors.onAccent,
    fontWeight: '700',
    letterSpacing: 2,
  },
  viewerContent: {
    width: '100%',
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
  },
  viewerMedia: {
    width: '100%',
    height: '100%',
  },
});
