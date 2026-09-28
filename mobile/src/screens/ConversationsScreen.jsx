import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  Modal,
  TextInput,
  ActivityIndicator,
  StatusBar,
  RefreshControl,
  Image,
  ScrollView,
} from 'react-native';
import { showAlert } from '../shared/services/themedAlert';
import Svg, { Circle, Path } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { chatApi } from '../shared/api/chat';
import { homeRequests } from '../shared/cache/homePrefetch';
import { readCache, writeCache } from '../shared/cache/screenCache';
import { useAuthStore } from '../shared/store/authStore';
import { colors, withAlpha, fonts, goldButton, spacing, radius } from '../shared/theme';
import { GoldFill } from '../shared/components/GoldButton';
import EmptyState from '../components/EmptyState';
import ErrorState from '../components/ErrorState';
import LoadingSkeleton from '../components/LoadingSkeleton';
import OfflineBanner from '../components/OfflineBanner';
import { KeyboardAvoider } from '../shared/components/KeyboardAware';
import { useTabBarDockHeight } from '../shared/hooks/useTabBarDockHeight';
import { SpotlightTourProvider, AttachStep } from 'react-native-spotlight-tour';
import TourTooltip from '../shared/components/TourTooltip';
const AVATAR_COLORS = [colors.gold, colors.avatarTan, colors.avatarLilac, colors.avatarSage, colors.avatarSky];
const PAD = 24;
function initials(name) {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}
function formatTimestamp(dateStr) {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHrs = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffMin < 1) return 'Now';
  if (diffMin < 60) return `${diffMin}m`;
  if (diffHrs < 24) return `${diffHrs}h`;
  if (diffDays < 7) return `${diffDays}d`;
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}
function avatarColorFor(name) {
  const seed = (name || '?').charCodeAt(0) || 0;
  return AVATAR_COLORS[Math.abs(seed) % AVATAR_COLORS.length];
}
function getOtherParticipant(conversation, currentUserId) {
  return conversation.participants.find((p) => p.id !== currentUserId);
}

/* ──────────────────────────────────────────── */
/*  Header icons — hand-drawn, no icon library   */
/* ──────────────────────────────────────────── */

/* New message: a pencil, tip lower-left / cap upper-right */

/* Household chat: two overlapping people */
function PeopleIcon({ size = 20, color = colors.ink }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Circle cx="8" cy="8" r="3" fill={color} opacity={0.45} />
      <Path d="M2,20 A6,6 0 0 1 14,20 Z" fill={color} opacity={0.45} />
      <Circle cx="15.5" cy="9" r="3.5" fill={color} />
      <Path d="M8.5,21 A7,7 0 0 1 22.5,21 Z" fill={color} />
    </Svg>
  );
}

/* ──────────────────────────────────────────── */
/*  Conversation Item                           */
/* ──────────────────────────────────────────── */

function ConversationItem({ item, currentUserId, onPress }) {
  const isEveryone = item.type === 'household';
  const isGroup = item.type === 'group' || isEveryone;
  const otherUser = isGroup ? null : getOtherParticipant(item, currentUserId);
  const displayName = isGroup
    ? item.name || (isEveryone ? 'Everyone' : 'Group Chat')
    : otherUser?.displayName || 'Unknown';
  const avatarUrl = isGroup ? null : otherUser?.avatarUrl;
  const lastMessage =
    item.lastMessage?.content ||
    (item.lastMessage?.type === 'voice'
      ? '🎤 Voice message'
      : item.lastMessage?.type === 'image'
        ? '📷 Photo'
        : null);
  const timestamp = item.lastMessage?.createdAt || item.createdAt;
  const unreadCount = item.unreadCount || 0;
  // A group shows two overlapping member avatars; a DM shows the one person.
  const stack = isGroup ? (item.participants || []).slice(0, 2) : [];

  return (
    <TouchableOpacity style={styles.convCard} onPress={onPress} activeOpacity={0.75}>
      {isGroup ? (
        <View style={styles.convStack}>
          {stack.map((p, i) => (
            <View
              key={p.id}
              style={[
                styles.convStackAvatar,
                i === 1 && styles.convStackAvatarFront,
                { backgroundColor: avatarColorFor(p.displayName) },
              ]}
            >
              {p.avatarUrl ? (
                <Image source={{ uri: p.avatarUrl }} style={styles.convStackImage} />
              ) : (
                <Text style={styles.convStackText}>{initials(p.displayName || '?')}</Text>
              )}
            </View>
          ))}
        </View>
      ) : (
        <View style={[styles.convAvatar, { backgroundColor: avatarColorFor(displayName) }]}>
          {avatarUrl ? (
            <Image source={{ uri: avatarUrl }} style={styles.convAvatarImage} />
          ) : (
            <Text style={styles.convAvatarText}>{initials(displayName)}</Text>
          )}
        </View>
      )}

      <View style={styles.convBody}>
        <View style={styles.convTopRow}>
          <Text style={styles.convName} numberOfLines={1}>
            {displayName}
          </Text>
          {isGroup && (
            <View style={styles.convBadge}>
              <Text style={styles.convBadgeText}>{isEveryone ? 'EVERYONE' : 'GROUP'}</Text>
            </View>
          )}
          <View style={styles.convSpacer} />
          <Text style={styles.convTime}>{formatTimestamp(timestamp)}</Text>
        </View>
        <View style={styles.convBottomRow}>
          <Text
            style={[styles.convPreview, unreadCount > 0 && styles.convPreviewUnread]}
            numberOfLines={1}
          >
            {isGroup && item.lastMessage?.senderName ? `${item.lastMessage.senderName}: ` : ''}
            {lastMessage || 'No messages yet'}
          </Text>
          {unreadCount > 0 && (
            <View style={styles.convUnreadBadge}>
              <Text style={styles.convUnreadBadgeText}>
                {unreadCount > 9 ? '9+' : unreadCount}
              </Text>
            </View>
          )}
        </View>
      </View>
    </TouchableOpacity>
  );
}

/* ──────────────────────────────────────────── */
/*  Main Screen                                 */
/* ──────────────────────────────────────────── */

export default function ConversationsScreen() {
  const insets = useSafeAreaInsets();
  const dockHeight = useTabBarDockHeight();
  const nav = useNavigation();
  const user = useAuthStore((s) => s.user);
  const householdId = useAuthStore((s) => s.householdId);
  const showChatTour = useAuthStore((s) => s.showChatTour);
  const dismissChatTour = useAuthStore((s) => s.dismissChatTour);
  const triggerTasksTour = useAuthStore((s) => s.triggerTasksTour);
  const composeRef = useRef(null);
  const tourRef = useRef(null);
  const tourSteps = useMemo(() => {
    const meta = [
      {
        ref: composeRef,
        title: 'Start a chat',
        body: 'Message one person directly, or your whole household at once.',
      },
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
            continueLabel={isChainLast ? 'Continue to Tasks' : undefined}
            onContinue={isChainLast ? () => {
              props.stop();
              nav.navigate('TasksStack');
              triggerTasksTour();
            } : undefined}
          />
        );
      },
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!showChatTour) return;
    let cancelled = false;
    const tryStart = () => {
      if (cancelled) return;
      if (tourRef.current) {
        tourRef.current.start();
        dismissChatTour();
      } else {
        requestAnimationFrame(tryStart);
      }
    };
    tryStart();
    return () => {
      cancelled = true;
    };
  }, [showChatTour, dismissChatTour]);
  // Last session's list paints instantly; the focus fetch below refreshes it.
  const [conversations, setConversations] = useState(() => readCache('conversations') || []);
  const [loading, setLoading] = useState(() => !readCache('conversations'));
  const [refreshing, setRefreshing] = useState(false);
  const [fetchError, setFetchError] = useState(false);
  const [members, setMembers] = useState([]);
  const [householdName, setHouseholdName] = useState('');
  const [modalVisible, setModalVisible] = useState(false);
  const [creating, setCreating] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const currentUserId = user?.id || '';
  const otherMembers = members.filter((m) => m.userId !== currentUserId);

  /* ── Fetch conversations ── */

  const fetchConversations = useCallback(async () => {
    try {
      setFetchError(false);
      const data = await chatApi.listConversations();
      setConversations(data);
      writeCache('conversations', data);
    } catch {
      setFetchError(true);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);
  useFocusEffect(
    useCallback(() => {
      fetchConversations();
    }, [fetchConversations]),
  );

  // Fetch household members on mount for the member strip
  useEffect(() => {
    if (!householdId) return;
    homeRequests
      .members(householdId)
      .then(setMembers)
      .catch(() => {});
  }, [householdId]);

  // Fetch household name (used as the auto-name for the Everyone conversation)
  useEffect(() => {
    if (!householdId) return;
    homeRequests
      .household(householdId)
      .then((h) => setHouseholdName(h.name))
      .catch(() => {});
  }, [householdId]);
  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    fetchConversations();
  }, [fetchConversations]);

  /* ── DM: tap member to create immediately ── */

  const handleDMSelect = useCallback(
    async (member) => {
      setCreating(true);
      try {
        const conv = await chatApi.createConversation({
          type: 'dm',
          participantIds: [member.userId],
        });
        setModalVisible(false);
        nav.navigate('ChatScreen', {
          conversationId: conv.id,
          title: member.displayName,
          type: 'dm',
          participantCount: 2,
        });
      } catch (e) {
        showAlert(
          'Error',
          e?.response?.data?.error || e?.message || 'Could not create conversation',
        );
      } finally {
        setCreating(false);
      }
    },
    [nav],
  );

  /* ── Everyone: one persistent household-wide conversation ── */

  const handleMessageEveryone = useCallback(async () => {
    const existing = conversations.find((c) => c.type === 'household');
    if (existing) {
      setModalVisible(false);
      nav.navigate('ChatScreen', {
        conversationId: existing.id,
        title: existing.name || 'Everyone',
        type: 'household',
        participantCount: existing.participants?.length || otherMembers.length + 1,
      });
      return;
    }
    if (otherMembers.length === 0) return;
    setCreating(true);
    try {
      const conv = await chatApi.createConversation({
        type: 'household',
        participantIds: otherMembers.map((m) => m.userId),
        name: householdName || 'Everyone',
      });
      setModalVisible(false);
      nav.navigate('ChatScreen', {
        conversationId: conv.id,
        title: conv.name || 'Everyone',
        type: 'household',
        participantCount: otherMembers.length + 1,
      });
    } catch (e) {
      showAlert('Error', e?.response?.data?.error || e?.message || 'Could not open Everyone chat');
    } finally {
      setCreating(false);
    }
  }, [conversations, otherMembers, householdName, nav]);

  const handleMemberPress = useCallback(
    async (m) => {
      try {
        // Reuse the existing DM if there already is one.
        const existing = conversations.find(
          (c) => c.type === 'dm' && c.participants.some((p) => p.id === m.userId),
        );
        if (existing) {
          nav.navigate('ChatScreen', {
            conversationId: existing.id,
            title: m.displayName,
            type: 'dm',
            participantCount: 2,
          });
          return;
        }
        const conv = await chatApi.createConversation({
          type: 'dm',
          participantIds: [m.userId],
        });
        nav.navigate('ChatScreen', {
          conversationId: conv.id,
          title: m.displayName,
          type: 'dm',
          participantCount: 2,
        });
      } catch {
        showAlert('Error', 'Could not start conversation');
      }
    },
    [conversations, nav],
  );

  const conversationCountLabel = `${conversations.length} conversation${
    conversations.length === 1 ? '' : 's'
  }`;

  /* ── Navigate to conversation ── */

  const handleConversationPress = useCallback(
    (conv) => {
      const otherUser = getOtherParticipant(conv, currentUserId);
      nav.navigate('ChatScreen', {
        conversationId: conv.id,
        title: conv.name || otherUser?.displayName || 'Chat',
        type: conv.type,
        participantCount: conv.participants?.length || 2,
      });
    },
    [currentUserId, nav],
  );

  /* ── Render helpers ── */

  const renderConversationItem = useCallback(
    ({ item }) => (
      <ConversationItem
        item={item}
        currentUserId={currentUserId}
        onPress={() => handleConversationPress(item)}
      />
    ),
    [currentUserId, handleConversationPress],
  );
  const keyExtractor = useCallback((item) => item.id, []);

  /* ── Empty state ── */

  const ListEmptyComponent = fetchError ? (
    <ErrorState onRetry={handleRefresh} onGoHome={() => {}} />
  ) : (
    <EmptyState
      icon={
        <View style={styles.chatIcon}>
          <Text style={styles.chatIconText}>💬</Text>
        </View>
      }
      title="No conversations yet."
      subtitle="Start a new chat!"
    />
  );

  /* ── Loading state ── */

  if (loading) {
    return <LoadingSkeleton variant="list" />;
  }
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
      <StatusBar barStyle="light-content" backgroundColor={colors.canvas} />

      <View style={styles.bannerWrap}>
        <OfflineBanner onRetry={handleRefresh} />
      </View>

      {/* ── Everything above the list scrolls with it (ListHeaderComponent),
             so the header, household strip and RECENT label behave as one
             sheet rather than a fixed chrome band. ── */}
      <FlatList
        style={styles.listFlex}
        data={conversations}
        renderItem={renderConversationItem}
        keyExtractor={keyExtractor}
        contentContainerStyle={[
          conversations.length === 0 ? styles.listEmptyContent : styles.listContent,
          { paddingBottom: dockHeight + 16 },
        ]}
        ListHeaderComponent={
          <View>
            <View style={styles.header}>
              <View style={styles.headerText}>
                <Text style={styles.headerTitle}>Messages</Text>
                <Text style={styles.headerSub}>{conversationCountLabel}</Text>
              </View>
              <AttachStep index={0} style={{ alignSelf: 'center' }}>
                <TouchableOpacity
                  ref={composeRef}
                  style={styles.composeBtn}
                  activeOpacity={0.85}
                  accessibilityRole="button"
                  accessibilityLabel="New message"
                  onPress={() => {
                    setSearchQuery('');
                    setModalVisible(true);
                  }}
                >
                  <GoldFill radius={radius.card} />
                  <Text style={styles.composeIcon}>+</Text>
                </TouchableOpacity>
              </AttachStep>
            </View>

            {otherMembers.length > 0 && (
              <>
                <Text style={styles.sectionLabel}>HOUSEHOLD</Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.strip}
                >
                  {otherMembers.map((m) => (
                    <TouchableOpacity
                      key={m.userId}
                      style={styles.stripItem}
                      activeOpacity={0.75}
                      onPress={() => handleMemberPress(m)}
                    >
                      {m.avatarUrl ? (
                        <Image source={{ uri: m.avatarUrl }} style={styles.stripAvatar} />
                      ) : (
                        <View
                          style={[
                            styles.stripAvatar,
                            { backgroundColor: avatarColorFor(m.displayName) },
                          ]}
                        >
                          <Text style={styles.stripAvatarText}>{initials(m.displayName)}</Text>
                        </View>
                      )}
                      <Text style={styles.stripName} numberOfLines={1}>
                        {m.displayName.split(' ')[0]}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              </>
            )}

            {conversations.length > 0 && <Text style={styles.sectionLabel}>RECENT</Text>}
          </View>
        }
        ListEmptyComponent={ListEmptyComponent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={colors.gold}
            colors={[colors.gold]}
          />
        }
        showsVerticalScrollIndicator={false}
      />

      {/* ── New Message Sheet ── */}
      <Modal
        visible={modalVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        statusBarTranslucent
        onRequestClose={() => setModalVisible(false)}
        navigationBarTranslucent
      >
        <KeyboardAvoider style={[searchModal.container, { paddingTop: insets.top }]}>
          <StatusBar barStyle="light-content" backgroundColor={colors.surface} />

          {/* Sheet header */}
          <View style={searchModal.sheetHeader}>
            <TouchableOpacity
              onPress={() => setModalVisible(false)}
              hitSlop={10}
              style={searchModal.closeBtn}
              activeOpacity={0.7}
            >
              <Text style={searchModal.closeIcon}>{'✕'}</Text>
            </TouchableOpacity>
            <Text style={searchModal.sheetTitle}>New Message</Text>
            <View style={searchModal.closeBtn} />
          </View>

          {/* Search */}
          <View style={searchModal.searchBar}>
            <Text style={searchModal.searchIcon}>{'⌕'}</Text>
            <TextInput
              style={searchModal.searchInput}
              placeholder="Search household members"
              placeholderTextColor={colors.textFaint}
              value={searchQuery}
              onChangeText={setSearchQuery}
              autoFocus
            />
          </View>

          {/* Member list */}
          {otherMembers.length === 0 ? (
            <View style={searchModal.emptyBox}>
              <Text style={searchModal.emptyText}>No other members in your household.</Text>
            </View>
          ) : (
            <FlatList
              data={otherMembers.filter((m) => {
                if (!searchQuery.trim()) return true;
                const q = searchQuery.toLowerCase();
                return m.displayName.toLowerCase().includes(q) || m.email.toLowerCase().includes(q);
              })}
              keyExtractor={(item) => item.userId}
              style={searchModal.list}
              contentContainerStyle={{ paddingBottom: insets.bottom + spacing.xl }}
              ListHeaderComponent={
                <>
                  <TouchableOpacity
                    style={searchModal.everyoneRow}
                    onPress={handleMessageEveryone}
                    disabled={creating || otherMembers.length === 0}
                    activeOpacity={0.7}
                  >
                    <View style={searchModal.everyoneAv}>
                      <PeopleIcon size={20} color={colors.gold} />
                    </View>
                    <View style={searchModal.mNameCol}>
                      <Text style={searchModal.mName}>Message everyone</Text>
                      <Text style={searchModal.mRole}>Your whole household</Text>
                    </View>
                  </TouchableOpacity>
                  <Text style={searchModal.sectionLabel}>HOUSEHOLD MEMBERS</Text>
                </>
              }
              renderItem={({ item: member }) => (
                <TouchableOpacity
                  style={searchModal.mRow}
                  onPress={() => handleDMSelect(member)}
                  activeOpacity={0.7}
                >
                  <View style={searchModal.mRowLeft}>
                    <View
                      style={[
                        searchModal.mAv,
                        {
                          backgroundColor:
                            AVATAR_COLORS[
                              Math.abs(
                                (member.displayName || member.email || '?').charCodeAt(0),
                              ) % AVATAR_COLORS.length
                            ],
                        },
                      ]}
                    >
                      <Text style={searchModal.mAvText}>
                        {initials(member.displayName || member.email || '??')}
                      </Text>
                    </View>
                    <View style={searchModal.mNameCol}>
                      <Text style={searchModal.mName}>{member.displayName || member.email}</Text>
                      <Text style={searchModal.mRole}>
                        {member.role.charAt(0).toUpperCase() + member.role.slice(1)}
                      </Text>
                    </View>
                  </View>
                </TouchableOpacity>
              )}
            />
          )}

          {/* Creating overlay */}
          {creating && (
            <View style={searchModal.creatingOverlay}>
              <ActivityIndicator size="small" color={colors.gold} />
              <Text style={searchModal.creatingText}>Creating...</Text>
            </View>
          )}
        </KeyboardAvoider>
      </Modal>
    </View>
    </SpotlightTourProvider>
  );
}

/* ──────────────────────────────────────────── */
/*  Styles                                       */
/* ──────────────────────────────────────────── */

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.canvas },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  bannerWrap: { paddingHorizontal: PAD, paddingTop: 4, paddingBottom: 4 },

  /* ── Header ── */
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: PAD,
    paddingTop: 10,
    paddingBottom: 6,
  },
  headerText: { flex: 1 },
  headerTitle: {
    fontFamily: fonts.display,
    fontSize: 30,
    lineHeight: 37,
    color: colors.ink,
    letterSpacing: -0.6,
  },
  headerSub: {
    marginTop: 3,
    fontFamily: fonts.body,
    fontSize: 13,
    color: colors.textMuted,
  },
  composeBtn: {
    width: 44,
    height: 44,
    borderRadius: radius.card,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.gold,
    ...goldButton.glow,
  },
  composeIcon: {
    fontSize: 26,
    lineHeight: 30,
    fontFamily: fonts.body,
    color: goldButton.onGold,
  },

  /* ── Section labels ── */
  sectionLabel: {
    marginTop: 18,
    marginBottom: 10,
    paddingHorizontal: PAD,
    fontFamily: fonts.bodySemiBold,
    fontSize: 11,
    letterSpacing: 1.4,
    color: colors.textFaint,
  },

  /* ── Household strip ── */
  strip: { paddingHorizontal: PAD, gap: 18 },
  stripItem: { alignItems: 'center', width: 62, gap: 7 },
  stripAvatar: {
    width: 58,
    height: 58,
    borderRadius: 29,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stripAvatarText: {
    fontFamily: fonts.bodyBold,
    fontSize: 20,
    color: colors.onAccent,
  },
  stripName: {
    fontFamily: fonts.body,
    fontSize: 12,
    color: colors.textMuted,
    textAlign: 'center',
  },

  /* ── List ── */
  listFlex: { flex: 1 },
  listContent: { paddingBottom: 24 },
  listEmptyContent: { flexGrow: 1 },

  /* ── Conversation card ── */
  convCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 13,
    marginHorizontal: PAD,
    marginBottom: 10,
    paddingHorizontal: 14,
    paddingVertical: 13,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderCool,
    borderRadius: radius.xl,
  },
  convAvatar: {
    width: 46,
    height: 46,
    borderRadius: 23,
    alignItems: 'center',
    justifyContent: 'center',
  },
  convAvatarImage: { width: 46, height: 46, borderRadius: 23 },
  convAvatarText: {
    fontFamily: fonts.bodyBold,
    fontSize: 16,
    color: colors.onAccent,
  },
  // Two overlapping circles, back one peeking out from behind the front.
  convStack: { width: 46, height: 46 },
  convStackAvatar: {
    position: 'absolute',
    width: 34,
    height: 34,
    borderRadius: 17,
    top: 0,
    right: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  convStackAvatarFront: {
    top: 12,
    left: 0,
    right: undefined,
    borderWidth: 2,
    borderColor: colors.canvas,
  },
  convStackImage: { width: '100%', height: '100%', borderRadius: 17 },
  convStackText: {
    fontFamily: fonts.bodyBold,
    fontSize: 12,
    color: colors.onAccent,
  },
  convBody: { flex: 1 },
  convTopRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  convName: {
    flexShrink: 1,
    fontFamily: fonts.bodyBold,
    fontSize: 15.5,
    color: colors.ink,
  },
  convSpacer: { flex: 1 },
  convBadge: {
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: radius.xs + 2,
    backgroundColor: colors.goldTint,
  },
  convBadgeText: {
    fontFamily: fonts.bodyBold,
    fontSize: 9,
    letterSpacing: 0.7,
    color: colors.gold,
  },
  convTime: {
    fontFamily: fonts.bodyMedium,
    fontSize: 11.5,
    color: colors.textFaint,
  },
  convBottomRow: {
    marginTop: 4,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  convPreview: {
    flex: 1,
    fontFamily: fonts.body,
    fontSize: 13.5,
    color: colors.textSecondary,
  },
  convPreviewUnread: {
    fontFamily: fonts.bodySemiBold,
    color: colors.ink,
  },
  convUnreadBadge: {
    minWidth: 20,
    height: 20,
    paddingHorizontal: 6,
    borderRadius: 10,
    backgroundColor: colors.gold,
    alignItems: 'center',
    justifyContent: 'center',
  },
  convUnreadBadgeText: {
    fontFamily: fonts.bodyBold,
    fontSize: 11,
    color: colors.ink,
  },

  /* ── Empty state ── */
  emptyContainer: { alignItems: 'center', paddingHorizontal: 40 },
  chatIcon: {
    width: 64,
    height: 64,
    borderRadius: radius.cardLg,
    backgroundColor: colors.skeleton,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 26,
  },
  chatIconText: { fontSize: 28 },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.textSecondary,
    marginBottom: 6,
    textAlign: 'center',
  },
  emptySubtitle: {
    fontSize: 14,
    fontWeight: '400',
    color: colors.textFaint,
    textAlign: 'center',
  },
});

/* ──────────────────────────────────────────── */
/*  Modal styles                                 */
/* ──────────────────────────────────────────── */

const searchModal = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.canvas,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
  },
  closeBtn: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeIcon: {
    fontSize: 16,
    fontFamily: fonts.bodySemiBold,
    color: colors.textSecondary,
  },
  sheetTitle: {
    fontSize: 17,
    fontFamily: fonts.displayBold,
    color: colors.ink,
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
    paddingHorizontal: spacing.md,
    height: 42,
    backgroundColor: colors.surface,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
  },
  searchIcon: {
    fontSize: 16,
    color: colors.textFaint,
  },
  searchInput: {
    flex: 1,
    height: '100%',
    fontSize: 15,
    fontFamily: fonts.body,
    color: colors.ink,
  },
  sectionLabel: {
    fontSize: 12,
    fontFamily: fonts.bodySemiBold,
    color: colors.textFaint,
    letterSpacing: 0.6,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.sm,
  },
  list: {
    flex: 1,
  },
  emptyBox: {
    paddingVertical: 40,
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 14,
    fontFamily: fonts.body,
    color: colors.textFaint,
  },
  everyoneRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.lg,
  },
  everyoneAv: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.goldTint,
    justifyContent: 'center',
    alignItems: 'center',
  },
  mRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.lg,
  },
  mRowLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  mAv: {
    width: 44,
    height: 44,
    borderRadius: 22,
    justifyContent: 'center',
    alignItems: 'center',
  },
  mAvText: {
    fontSize: 15,
    fontFamily: fonts.bodyBold,
    color: colors.ink,
  },
  mNameCol: {},
  mName: {
    fontSize: 15,
    fontFamily: fonts.bodySemiBold,
    color: colors.ink,
  },
  mRole: {
    fontSize: 12,
    fontFamily: fonts.body,
    color: colors.textFaint,
    marginTop: 2,
  },
  creatingOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: withAlpha(colors.white, 0.8),
    justifyContent: 'center',
    alignItems: 'center',
    gap: 10,
  },
  creatingText: {
    fontSize: 14,
    fontFamily: fonts.bodySemiBold,
    color: colors.gold,
  },
});
