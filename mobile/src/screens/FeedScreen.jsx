import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  FlatList,
  Dimensions,
  RefreshControl,
  Modal,
  Pressable,
  TextInput,
  ActivityIndicator,
  AppState,
} from 'react-native';
import { Image } from 'expo-image';
import { Video, ResizeMode } from 'expo-av';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { LinearGradient } from 'expo-linear-gradient';
import { StatusBar } from 'expo-status-bar';
import { SvgXml } from 'react-native-svg';
import { feedApi } from '../shared/api/feed';
import { homeRequests } from '../shared/cache/homePrefetch';
import { useFeedStore } from '../shared/store/feedStore';
import { useAuthStore } from '../shared/store/authStore';
import { loadSignupProgress } from '../shared/store/signupProgress';
import { SpotlightTourProvider, AttachStep } from 'react-native-spotlight-tour';
import TourTooltip from '../shared/components/TourTooltip';
import apiClient from '../shared/api/client';
import EmptyState from '../components/EmptyState';
import ErrorState from '../components/ErrorState';
import LoadingSkeleton from '../components/LoadingSkeleton';
import OfflineBanner from '../components/OfflineBanner';
import ConfirmSheet from '../components/ConfirmSheet';
import { KeyboardAvoider, keyboardScrollProps } from '../shared/components/KeyboardAware';
import { useTabBarDockHeight } from '../shared/hooks/useTabBarDockHeight';
import { colors, fonts, goldButton, radius, withAlpha } from '../shared/theme';
import { GoldFill } from '../shared/components/GoldButton';
import { GlassSheen } from '../shared/components/GlassCard';
const { width: SCREEN_WIDTH } = Dimensions.get('window');

// Import the family cover photo as placeholder for featured image
const FAMILY_COVER = require('../../assets/images/family-cover.png');
const DOTS_SVG =
  `<svg width="20" height="20" viewBox="0 0 24 24" fill="${colors.ink}">` +
  '<circle cx="5" cy="12" r="1.7"></circle>' +
  '<circle cx="12" cy="12" r="1.7"></circle>' +
  '<circle cx="19" cy="12" r="1.7"></circle>' +
  '</svg>';
const TAG_SVG =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none">' +
  `<path d="M20.6 13.4L13.4 20.6a2 2 0 01-2.8 0L4 14V4h10l6.6 6.6a2 2 0 010 2.8z" stroke="${colors.legacyGoldDark}" stroke-width="1.8" stroke-linejoin="round"></path>` +
  `<circle cx="8.5" cy="8.5" r="1.3" fill="${colors.legacyGoldDark}"></circle>` +
  '</svg>';
const CHAT_SVG =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none">' +
  `<path d="M21 12a8 8 0 01-8 8H4l2-3a8 8 0 1115-5z" stroke="${colors.textSecondary}" stroke-width="1.8" stroke-linejoin="round"></path>` +
  '</svg>';
const PHOTO_SVG =
  '<svg width="28" height="28" viewBox="0 0 24 24" fill="none">' +
  `<rect x="3" y="5" width="18" height="14" rx="2" stroke="${colors.inkMuted}" stroke-width="1.5"></rect>` +
  `<circle cx="8.5" cy="10" r="1.5" stroke="${colors.inkMuted}" stroke-width="1.5"></circle>` +
  `<path d="M21 16l-5-5-9 9" stroke="${colors.inkMuted}" stroke-width="1.5"></path>` +
  '</svg>';
const getServerBase = () => {
  const base = apiClient.defaults.baseURL || '';
  return base.replace(/\/api\/v1\/?$/, '');
};
function timeAgo(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Date.now() - then;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}
export default function FeedScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const dockHeight = useTabBarDockHeight();
  const {
    posts,
    loading,
    refreshing,
    error,
    fetchFeed,
    fetchMore,
    hasMore,
    refresh,
    refreshIfStale,
    lastFetchedAt,
    removePost,
    incrementCommentCount,
  } = useFeedStore();
  const currentUserId = useAuthStore((s) => s.user?.id);
  const householdId = useAuthStore((s) => s.householdId);
  const showFeedTour = useAuthStore((s) => s.showFeedTour);
  const dismissFeedTour = useAuthStore((s) => s.dismissFeedTour);
  const triggerChatTour = useAuthStore((s) => s.triggerChatTour);
  const fabRef = useRef(null);
  const titleBarRef = useRef(null);
  const tourRef = useRef(null);
  const tourSteps = useMemo(() => {
    const meta = [
      { ref: fabRef, title: 'Share something', body: 'Tap here to post a photo or update with your household.' },
      { ref: titleBarRef, title: 'Your Feed', body: 'Photos and updates your household shares show up here, all in one place.' },
    ];
    return meta.map(({ ref, title, body }, i) => ({
      before: () => {},
      render: (props) => {
        const isChainLast = i === meta.length - 1;
        return (
          <TourTooltip
            {...props}
            title={title}
            body={body}
            total={meta.length}
            continueLabel={isChainLast ? 'Continue to Chat' : undefined}
            onContinue={isChainLast ? () => {
              props.stop();
              navigation.navigate('ChatStack');
              triggerChatTour();
            } : undefined}
          />
        );
      },
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!showFeedTour) return;
    let cancelled = false;
    const tryStart = () => {
      if (cancelled) return;
      if (tourRef.current) {
        tourRef.current.start();
        dismissFeedTour();
      } else {
        requestAnimationFrame(tryStart);
      }
    };
    tryStart();
    return () => {
      cancelled = true;
    };
  }, [showFeedTour, dismissFeedTour]);
  const [activeMediaIndex, setActiveMediaIndex] = useState({});
  // Per-media-item load failures (expired signed URL, transient network
  // error) and a retry counter — expo-image shows nothing on a failed load
  // by default, indistinguishable from "still loading"; this makes a
  // failure visible and gives the user a way to try again without a full
  // pull-to-refresh.
  const [mediaErrors, setMediaErrors] = useState({});
  const [mediaRetryNonce, setMediaRetryNonce] = useState({});
  // A fresh fetch brings freshly signed URLs — give every image another go
  // (e.g. ones that failed from an old cached page shown at cold start).
  useEffect(() => {
    setMediaErrors({});
  }, [lastFetchedAt]);
  const [menuPost, setMenuPost] = useState(null);
  const [menuAnchor, setMenuAnchor] = useState(null);
  const dotsRefs = useRef({});

  // Inline commenting — draft text, in-flight state, and the most recent
  // comment shown under each post (Facebook-style), all keyed by postId.
  const [commentDrafts, setCommentDrafts] = useState({});
  const [commentSending, setCommentSending] = useState({});
  // The server ships each post's first comment as `previewComment`; this
  // only holds comments posted inline this session so they show at once.
  const [recentComments, setRecentComments] = useState({});

  // Family home card: cover photo + household message
  const [familyCover, setFamilyCover] = useState(null);
  const [householdName, setHouseholdName] = useState('');
  // Delete-post confirmation sheet
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  useEffect(() => {
    fetchFeed();
    loadSignupProgress()
      .then((p) => {
        if (p?.draft?.familyPhoto) setFamilyCover(p.draft.familyPhoto);
      })
      .catch(() => {});
    if (householdId) {
      homeRequests
        .household(householdId)
        .then((hh) => setHouseholdName(hh.name))
        .catch(() => {});
    }
  }, [fetchFeed, householdId]);
  // Presigned S3 URLs expire after an hour — a household left open in the
  // background past that (a gathering, an unattended phone) can end up
  // with a mix of stale and fresh post images. Re-fetch on foreground if
  // the base list is old enough that could plausibly have happened.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') refreshIfStale(45 * 60 * 1000);
    });
    return () => sub.remove();
  }, [refreshIfStale]);
  const onRefresh = useCallback(() => {
    refresh();
  }, [refresh]);
  const submitInlineComment = useCallback(
    async (postId) => {
      const text = (commentDrafts[postId] || '').trim();
      if (!text || commentSending[postId]) return;
      setCommentSending((prev) => ({ ...prev, [postId]: true }));
      try {
        const created = await feedApi.addComment(postId, text);
        setRecentComments((prev) => ({ ...prev, [postId]: created }));
        setCommentDrafts((prev) => ({ ...prev, [postId]: '' }));
        incrementCommentCount(postId);
      } catch (e) {
        alert('Could not post comment: ' + (e?.message || 'Try again'));
      } finally {
        setCommentSending((prev) => ({ ...prev, [postId]: false }));
      }
    },
    [commentDrafts, commentSending, incrementCommentCount],
  );
  const handleDeletePost = useCallback(
    async (postId) => {
      try {
        await feedApi.delete(postId);
        removePost(postId);
      } catch (e) {
        alert('Could not delete post: ' + (e?.message || 'Try again'));
      }
    },
    [removePost],
  );
  const handleReportPost = useCallback((postId) => {
    alert('Post reported. Thank you for keeping the community safe.');
  }, []);
  const openPostMenu = useCallback((post, x, y) => {
    setMenuPost(post);
    setMenuAnchor({
      x,
      y,
    });
  }, []);
  const closePostMenu = useCallback(() => {
    setMenuPost(null);
    setMenuAnchor(null);
  }, []);
  const handleMenuAction = useCallback(
    (action) => {
      if (!menuPost) return;
      setMenuPost(null);
      if (action === 'report' || menuPost.author?.id !== currentUserId) {
        handleReportPost(menuPost.id);
      } else {
        setConfirmDeleteId(menuPost.id);
      }
    },
    [menuPost, currentUserId, handleReportPost],
  );
  const avatarSrc = (post) => {
    const url = post.author?.avatarUrl;
    if (!url) return null;
    return {
      uri: url.startsWith('http') ? url : `${getServerBase()}${url}`,
    };
  };
  const mediaSrc = (post) => {
    const list = post.media || [];
    const url = list[0]?.thumbnailUrl || list[0]?.mediaUrl;
    if (!url) return null;
    return {
      uri: url.startsWith('http') ? url : `${getServerBase()}${url}`,
    };
  };
  const handleEndReached = useCallback(() => {
    if (hasMore && !loading) fetchMore();
  }, [hasMore, loading, fetchMore]);
  const initialsOf = (name) =>
    (name || '?')
      .split(' ')
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  const renderPost = ({ item }) => {
    const avatar = avatarSrc(item);
    const media = mediaSrc(item);
    const authorName = item.author?.displayName || 'Unknown';
    const isOwner = item.author?.id === currentUserId;
    const inlineComment = recentComments[item.id] || item.previewComment;
    const commentPreview =
      item.commentCount > 0
        ? `View ${item.commentCount} comment${item.commentCount > 1 ? 's' : ''}`
        : 'No comments yet';
    const feelings = (item.content || '').match(/Feeling: ([^\n]+)/)?.[1]?.trim();
    const bodyText = (item.content || '').replace(/^\s*Feeling: [^\n]*\n*/m, '').trim();
    const mediaIndex = activeMediaIndex[item.id] ?? 0;
    const eyebrow = feelings || item.activity || null;
    const metaLine = [timeAgo(item.createdAt), item.location].filter(Boolean).join(' · ');

    const dotsButton = (
      <TouchableOpacity
        style={styles.dotsButton}
        activeOpacity={0.6}
        ref={(ref) => {
          if (ref && !dotsRefs.current[item.id]) dotsRefs.current[item.id] = ref;
        }}
        onPress={() => {
          const ref = dotsRefs.current[item.id];
          if (ref && ref.measureInWindow) {
            ref.measureInWindow((x, y, w, h) => openPostMenu(item, x + w - 8, y + h + 6));
          } else {
            openPostMenu(item, SCREEN_WIDTH - 60, 200);
          }
        }}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      >
        <SvgXml xml={DOTS_SVG} width={18} height={18} />
      </TouchableOpacity>
    );

    return (
      <View style={styles.postCard}>
        {/* Media, with caption overlaid bottom-left — or the header row on top for text-only posts */}
        {media ? (
          <View style={styles.mediaWrap}>
            <ScrollView
              horizontal
              pagingEnabled
              showsHorizontalScrollIndicator={false}
              onMomentumScrollEnd={(e) => {
                const idx = Math.round(e.nativeEvent.contentOffset.x / (SCREEN_WIDTH - 24));
                setActiveMediaIndex((prev) => ({
                  ...prev,
                  [item.id]: idx,
                }));
              }}
            >
              {item.media.map((m, i) => {
                const mediaKey = m.id || i;
                const toAbsolute = (u) => (u && u.startsWith('http') ? u : u ? `${getServerBase()}${u}` : null);
                const posterUri = toAbsolute(m.thumbnailUrl);
                const hasError = !!mediaErrors[mediaKey];
                const retryKey = mediaRetryNonce[mediaKey] || 0;

                if (m.mediaType === 'video') {
                  // The video's PLAYABLE source is always the real video
                  // file — never the poster thumbnail, which is a plain
                  // JPEG expo-av can't play. posterSource shows a real
                  // frame instead of a blank/black box while the player
                  // hasn't started.
                  const videoUri = toAbsolute(m.mediaUrl);
                  return (
                    <Video
                      key={`${mediaKey}-${retryKey}`}
                      source={{ uri: videoUri }}
                      posterSource={posterUri ? { uri: posterUri } : undefined}
                      usePoster={!!posterUri}
                      style={[styles.postImage, { width: SCREEN_WIDTH - 24 }]}
                      resizeMode={ResizeMode.COVER}
                      shouldPlay={false}
                      isMuted
                      useNativeControls={false}
                    />
                  );
                }

                const uri = posterUri || toAbsolute(m.mediaUrl);
                return (
                  <Pressable
                    key={`${mediaKey}-${retryKey}`}
                    disabled={!hasError}
                    onPress={() => {
                      setMediaErrors((prev) => ({ ...prev, [mediaKey]: false }));
                      setMediaRetryNonce((prev) => ({ ...prev, [mediaKey]: (prev[mediaKey] || 0) + 1 }));
                    }}
                  >
                    <Image
                      // mediaUrl/thumbnailUrl are presigned S3 links that
                      // change on every fetch — key by the stable media id.
                      source={{ uri, cacheKey: m.id }}
                      style={[styles.postImage, { width: SCREEN_WIDTH - 24 }]}
                      contentFit="cover"
                      cachePolicy="disk"
                      transition={200}
                      priority={i === 0 ? 'high' : 'low'}
                      onError={() => setMediaErrors((prev) => ({ ...prev, [mediaKey]: true }))}
                    />
                    {hasError && (
                      <View style={[styles.postImage, { width: SCREEN_WIDTH - 24 }, styles.mediaErrorOverlay]}>
                        <Text style={styles.mediaErrorText}>Couldn't load · Tap to retry</Text>
                      </View>
                    )}
                  </Pressable>
                );
              })}
            </ScrollView>

            {item.media.length > 1 && (
              <View style={styles.pageDots}>
                {item.media.map((_, i) => (
                  <View
                    key={i}
                    style={[styles.pageDot, i === mediaIndex && styles.pageDotActive]}
                  />
                ))}
              </View>
            )}

            {bodyText ? (
              <>
                <LinearGradient
                  colors={['transparent', withAlpha(colors.shadow, 0.75)]}
                  style={styles.mediaCaptionScrim}
                  pointerEvents="none"
                />
                <View style={styles.mediaCaptionBlock} pointerEvents="none">
                  {eyebrow ? (
                    <Text style={styles.mediaEyebrow} numberOfLines={1}>
                      {eyebrow.toUpperCase()}
                    </Text>
                  ) : null}
                  <Text style={styles.mediaCaptionTitle} numberOfLines={2}>
                    {bodyText}
                  </Text>
                </View>
              </>
            ) : null}
          </View>
        ) : null}

        {/* Author footer bar — avatar, name, meta, menu */}
        <View style={media ? styles.postFooter : styles.postHeader}>
          <View style={styles.avatarCircle}>
            {avatar ? (
              <Image
                source={{ ...avatar, cacheKey: item.author?.id }}
                style={styles.avatarImage}
                cachePolicy="disk"
              />
            ) : (
              <Text style={styles.avatarText}>{initialsOf(authorName)}</Text>
            )}
          </View>
          <View style={styles.postHeaderInfo}>
            <Text style={styles.authorName}>{authorName}</Text>
            <Text style={styles.postTime}>{metaLine}</Text>
          </View>
          {!media && eyebrow ? (
            <View style={styles.headerFeeling}>
              <Text style={styles.headerFeelingText} numberOfLines={1}>
                {eyebrow}
              </Text>
            </View>
          ) : null}
          {dotsButton}
        </View>

        {/* Text-only caption (no media to overlay it on) */}
        {!media && bodyText ? (
          <Text style={styles.postText}>{bodyText}</Text>
        ) : null}

        {/* Tag row */}
        {item.taggedUsers && item.taggedUsers.length > 0 && (
          <View style={styles.infoRow}>
            <SvgXml xml={TAG_SVG} width={16} height={16} />
            <Text style={styles.infoRowText} numberOfLines={1}>
              {item.taggedUsers.map((t) => t.displayName).join(', ')}
            </Text>
          </View>
        )}

        {/* Comment row */}
        <View style={styles.actionsRow}>
          <TouchableOpacity
            style={styles.likeButton}
            activeOpacity={0.7}
            onPress={() => navigation.navigate('Comments', { postId: item.id })}
          >
            <SvgXml xml={CHAT_SVG} width={17} height={17} />
            <Text style={styles.likeText}>
              {item.commentCount} {item.commentCount === 1 ? 'comment' : 'comments'}
            </Text>
          </TouchableOpacity>
        </View>

        {/* Most recent comment — inline preview, Facebook-style */}
        {inlineComment ? (
          <TouchableOpacity
            style={styles.recentCommentRow}
            activeOpacity={0.7}
            onPress={() => navigation.navigate('Comments', { postId: item.id })}
          >
            <Text style={styles.recentCommentText} numberOfLines={2}>
              <Text style={styles.recentCommentAuthor}>
                {inlineComment.author?.displayName || 'Member'}{' '}
              </Text>
              {inlineComment.content}
            </Text>
            {item.commentCount > 1 ? (
              <Text style={styles.recentCommentViewAll}>
                View all {item.commentCount} comments
              </Text>
            ) : null}
          </TouchableOpacity>
        ) : null}

        {/* Comment input — post inline without leaving the feed */}
        <View style={styles.commentInputBar}>
          <View style={styles.commentInputAvatar}>
            <Text style={styles.commentInputAvatarText}>✎</Text>
          </View>
          <TextInput
            value={commentDrafts[item.id] || ''}
            onChangeText={(text) =>
              setCommentDrafts((prev) => ({
                ...prev,
                [item.id]: text,
              }))
            }
            placeholder="Add a comment…"
            placeholderTextColor={colors.textMuted}
            style={styles.commentInputField}
            returnKeyType="send"
            onSubmitEditing={() => submitInlineComment(item.id)}
            editable={!commentSending[item.id]}
          />
          {commentSending[item.id] ? (
            <ActivityIndicator size="small" color={colors.gold} />
          ) : (commentDrafts[item.id] || '').trim() ? (
            <TouchableOpacity
              onPress={() => submitInlineComment(item.id)}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Text style={styles.commentSendText}>Post</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </View>
    );
  };
  return (
    <SpotlightTourProvider
      ref={tourRef}
      steps={tourSteps}
      shape="rectangle"
      motion="slide"
      overlayColor={colors.shadow}
      overlayOpacity={0.82}
    >
    <View
      style={[
        styles.container,
        {
          paddingTop: insets.top,
        },
      ]}
    >
      <StatusBar style="light" />
      {/* Title bar: Feed — post creation lives in the "+" FAB below, no need to duplicate it here */}
      <AttachStep index={1} fill>
        <View style={styles.titleBar} ref={titleBarRef}>
          <Text style={styles.title}>Feed</Text>
        </View>
      </AttachStep>

      {loading && posts.length === 0 ? (
        <LoadingSkeleton variant="feed" />
      ) : error && posts.length === 0 ? (
        <ErrorState onRetry={fetchFeed} onGoHome={() => navigation.navigate('KnowsDashboard')} />
      ) : (
        <KeyboardAvoider style={styles.avoider}>
          <FlatList
            data={posts}
            keyExtractor={(post) => post.id}
            renderItem={({ item }) => <View>{renderPost({ item })}</View>}
            contentContainerStyle={[styles.postsContainer, { paddingBottom: dockHeight + 24 }]}
            showsVerticalScrollIndicator={false}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={onRefresh}
                tintColor={colors.gold}
              />
            }
            onEndReached={handleEndReached}
            onEndReachedThreshold={0.5}
            ListHeaderComponent={
              <View style={styles.bannerWrap}>
                <OfflineBanner onRetry={onRefresh} />
              </View>
            }
            ListEmptyComponent={
              <View style={styles.emptyWrap}>
                <EmptyState
                  icon={<SvgXml xml={PHOTO_SVG} width={28} height={28} />}
                  title="Nothing here yet"
                  subtitle="Share a photo or update with your household to get the feed going."
                  actionLabel="Create a post"
                  onAction={() => navigation.navigate('CreatePost')}
                />
              </View>
            }
            ListFooterComponent={
              loading && posts.length > 0 ? (
                <ActivityIndicator color={colors.gold} style={styles.feedFooterLoader} />
              ) : null
            }
            {...keyboardScrollProps}
          />
        </KeyboardAvoider>
      )}

      {/* Floating Action Button.
          AttachStep's own wrapper isn't positioned, so the FAB's
          position:absolute/right/bottom move onto AttachStep's `style`
          instead of the button's own style — otherwise the button would be
          absolutely positioned relative to its (tiny, content-sized)
          AttachStep wrapper instead of the screen, and lose its floating
          placement entirely. */}
      <AttachStep index={0} style={{ position: 'absolute', right: 24, bottom: dockHeight + 12 }}>
        <TouchableOpacity
          ref={fabRef}
          style={styles.fabButton}
          activeOpacity={0.8}
          onPress={() => navigation.navigate('CreatePost')}
        >
          <GoldFill radius={28} />
          <Text style={styles.fabIcon}>+</Text>
        </TouchableOpacity>
      </AttachStep>

      {/* 3-dot anchored dropdown menu — appears right under the button */}
      <Modal visible={!!menuPost} transparent animationType="fade" onRequestClose={closePostMenu}>
        <Pressable style={styles.menuBackdrop} onPress={closePostMenu}>
          {menuAnchor && (
            <View
              style={[
                styles.menuDropdown,
                {
                  top: menuAnchor.y,
                  right: SCREEN_WIDTH - menuAnchor.x,
                },
              ]}
            >
              <View style={styles.menuArrow} />
              <View style={styles.menuHeaderCompact}>
                <Text style={styles.menuPostAuthor} numberOfLines={1}>
                  {menuPost?.author?.displayName || ''}
                </Text>
                <Text style={styles.menuPostTime}>
                  {menuPost ? timeAgo(menuPost.createdAt) : ''}
                </Text>
              </View>
              {menuPost && menuPost.author?.id === currentUserId ? (
                <TouchableOpacity
                  style={styles.menuItem}
                  activeOpacity={0.6}
                  onPress={() => handleMenuAction('delete')}
                >
                  <Text style={styles.menuItemText}>Delete</Text>
                </TouchableOpacity>
              ) : (
                <TouchableOpacity
                  style={styles.menuItem}
                  activeOpacity={0.6}
                  onPress={() => handleMenuAction('report')}
                >
                  <Text style={styles.menuItemIcon}>🚩</Text>
                  <Text style={styles.menuItemText}>Report post</Text>
                </TouchableOpacity>
              )}
            </View>
          )}
        </Pressable>
      </Modal>

      {/* Delete post confirmation sheet */}
      <ConfirmSheet
        visible={!!confirmDeleteId}
        title="Delete this post?"
        subtitle="This removes it for everyone in the household. This can't be undone."
        confirmLabel="Delete"
        onConfirm={() => {
          const id = confirmDeleteId;
          setConfirmDeleteId(null);
          if (id) handleDeletePost(id);
        }}
        onCancel={() => setConfirmDeleteId(null)}
      />
    </View>
    </SpotlightTourProvider>
  );
}

// Styles
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.canvas,
    paddingHorizontal: 4,
  },
  avoider: {
    flex: 1,
  },
  header: {
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  timeText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.ink,
    fontFamily: fonts.bodySemiBold,
  },
  titleBar: {
    height: 56,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 24,
    backgroundColor: colors.canvas,
  },
  title: {
    fontSize: 28,
    fontWeight: '800',
    color: colors.ink,
    fontFamily: fonts.display,
    letterSpacing: -0.02 * 28,
  },
  postsContainer: {
    paddingTop: 4,
    paddingBottom: 24,
  },
  bannerWrap: {
    paddingHorizontal: 24,
    paddingTop: 4,
    paddingBottom: 8,
  },
  emptyWrap: {
    height: 340,
  },
  feedFooterLoader: {
    paddingVertical: 20,
  },
  featuredMemory: {
    position: 'relative',
    height: 220,
    marginHorizontal: 12,
    marginBottom: 20,
    borderRadius: 20,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
  },
  featuredImage: {
    width: '100%',
    height: '100%',
  },
  featuredOverlay: {
    ...StyleSheet.absoluteFillObject,
  },
  featuredTextBlock: {
    position: 'absolute',
    left: 20,
    right: 20,
    bottom: 20,
  },
  featuredEyebrow: {
    alignSelf: 'flex-start',
    marginBottom: 8,
  },
  featuredEyebrowText: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.goldSoft,
    letterSpacing: 1.2,
    fontFamily: fonts.bodyBold,
  },
  featuredTitle: {
    fontSize: 24,
    fontWeight: '800',
    color: colors.onAccent,
    fontFamily: fonts.display,
    marginBottom: 6,
    textShadowColor: withAlpha(colors.shadow, 0.5),
    textShadowOffset: {
      width: 0,
      height: 1,
    },
    textShadowRadius: 4,
  },
  featuredSub: {
    fontSize: 13,
    color: colors.onAccent,
    fontFamily: fonts.body,
    lineHeight: 18,
    opacity: 0.85,
  },
  menuBackdrop: {
    flex: 1,
    backgroundColor: withAlpha(colors.shadow, 0.25),
  },
  menuDropdown: {
    position: 'absolute',
    width: 220,
    backgroundColor: colors.canvas,
    borderRadius: radius.card,
    paddingVertical: 6,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: colors.border,
    shadowColor: colors.shadow,
    shadowOffset: {
      width: 0,
      height: 6,
    },
    shadowOpacity: 0.18,
    shadowRadius: 16,
    elevation: 10,
  },
  menuArrow: {
    position: 'absolute',
    top: -6,
    right: 14,
    width: 12,
    height: 12,
    backgroundColor: colors.canvas,
    transform: [
      {
        rotate: '45deg',
      },
    ],
    borderTopLeftRadius: 3,
  },
  menuHeaderCompact: {
    paddingVertical: 8,
    marginBottom: 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: withAlpha(colors.legacyNavy, 0.1),
  },
  menuPostAuthor: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.ink,
    fontFamily: fonts.bodySemiBold,
  },
  menuPostTime: {
    fontSize: 12,
    color: colors.textMuted,
    fontFamily: fonts.body,
    marginTop: 1,
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 4,
  },
  menuItemIcon: {
    fontSize: 16,
  },
  menuItemText: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.ink,
    fontFamily: fonts.bodyMedium,
  },
  likeButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  actionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 24,
    paddingHorizontal: 20,
    marginBottom: 12,
    marginTop: 2,
  },
  likeText: {
    fontSize: 13,
    color: colors.textSecondary,
    fontFamily: fonts.bodyMedium,
  },
  postCard: {
    backgroundColor: colors.surface,
    marginHorizontal: 12,
    marginBottom: 18,
    borderRadius: 20,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
    paddingBottom: 16,
  },
  postHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 10,
  },
  postFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 20,
    paddingVertical: 14,
    backgroundColor: colors.surfaceWarm,
  },
  avatarCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.borderCool,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  avatarImage: {
    width: 36,
    height: 36,
    borderRadius: 18,
  },
  avatarText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.inkMuted,
    fontFamily: fonts.bodySemiBold,
  },
  postHeaderInfo: {
    flex: 1,
  },
  dotsButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerFeeling: {
    backgroundColor: colors.goldTint,
    borderRadius: radius.card,
    paddingHorizontal: 10,
    paddingVertical: 5,
    maxWidth: 110,
    marginRight: 4,
  },
  headerFeelingText: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.goldSoft,
    fontFamily: fonts.bodySemiBold,
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 20,
    marginTop: 12,
    marginBottom: 4,
  },
  infoRowText: {
    fontSize: 13,
    color: colors.textSecondary,
    fontFamily: fonts.body,
    flexShrink: 1,
  },
  commentInputBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.canvas,
    borderRadius: 9999,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginHorizontal: 20,
    marginTop: 4,
  },
  commentInputAvatar: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: colors.borderCool,
    alignItems: 'center',
    justifyContent: 'center',
  },
  commentInputAvatarText: {
    fontSize: 12,
    color: colors.inkMuted,
  },
  commentInputField: {
    flex: 1,
    fontSize: 13,
    color: colors.ink,
    fontFamily: fonts.body,
    padding: 0,
    margin: 0,
  },
  commentSendText: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.gold,
    fontFamily: fonts.bodyBold,
  },
  recentCommentRow: {
    marginHorizontal: 20,
    marginTop: 8,
  },
  recentCommentText: {
    fontSize: 13,
    lineHeight: 18,
    color: colors.ink,
    fontFamily: fonts.body,
  },
  recentCommentAuthor: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '700',
    color: colors.ink,
    fontFamily: fonts.bodyBold,
  },
  recentCommentViewAll: {
    fontSize: 12,
    color: colors.textMuted,
    fontFamily: fonts.body,
    marginTop: 4,
  },
  mediaWrap: {
    position: 'relative',
  },
  mediaCaptionScrim: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 130,
  },
  mediaCaptionBlock: {
    position: 'absolute',
    left: 20,
    right: 20,
    bottom: 16,
  },
  mediaEyebrow: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.goldSoft,
    letterSpacing: 1,
    fontFamily: fonts.bodyBold,
    marginBottom: 6,
  },
  mediaCaptionTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: colors.onAccent,
    fontFamily: fonts.display,
    lineHeight: 25,
    textShadowColor: withAlpha(colors.shadow, 0.5),
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  pageDots: {
    position: 'absolute',
    bottom: 10,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 6,
  },
  pageDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: withAlpha(colors.white, 0.5),
  },
  pageDotActive: {
    backgroundColor: colors.surface,
    width: 16,
  },
  authorName: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.ink,
    fontFamily: fonts.bodyBold,
    marginBottom: 2,
  },
  postTime: {
    fontSize: 12,
    color: colors.textMuted,
    fontFamily: fonts.body,
  },
  postImage: {
    width: '100%',
    height: 300,
  },
  mediaErrorOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    backgroundColor: withAlpha(colors.ink, 0.55),
    alignItems: 'center',
    justifyContent: 'center',
  },
  mediaErrorText: {
    color: colors.surface,
    fontFamily: fonts.bodySemiBold,
    fontSize: 13,
  },
  postText: {
    fontSize: 15,
    color: colors.ink,
    fontFamily: fonts.body,
    lineHeight: 22,
    paddingHorizontal: 20,
    paddingBottom: 8,
  },
  taggedText: {
    fontSize: 13,
    color: colors.legacyGoldDark,
    fontFamily: fonts.bodyMedium,
    marginBottom: 14,
  },
  loading: {
    padding: 24,
    alignItems: 'center',
  },
  emptyState: {
    padding: 40,
    alignItems: 'center',
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.ink,
    fontFamily: fonts.bodyBold,
    marginBottom: 6,
  },
  emptySub: {
    fontSize: 13,
    color: colors.textSecondary,
    fontFamily: fonts.body,
    textAlign: 'center',
    marginBottom: 16,
  },
  retryButton: {
    backgroundColor: colors.gold,
    borderRadius: 9999,
    paddingHorizontal: 24,
    paddingVertical: 10,
    shadowOpacity: 0,
    shadowRadius: 0,
    elevation: 0,
  },
  retryText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.onAccent,
    fontFamily: fonts.bodySemiBold,
  },
  fabButton: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.gold,
    alignItems: 'center',
    justifyContent: 'center',
    ...goldButton.glow,
  },
  fabIcon: {
    fontSize: 24,
    fontWeight: '700',
    color: goldButton.onGold,
    fontFamily: 'PlusJakartaSans_700Bold',
  },
});
