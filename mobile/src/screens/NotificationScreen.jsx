import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SectionList,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  StatusBar,
} from 'react-native';
import { showAlert } from '../shared/services/themedAlert';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Swipeable } from 'react-native-gesture-handler';
import { notificationApi } from '../shared/api/notification';
import { colors, fonts, goldButton, withAlpha } from '../shared/theme';
import { GoldFill } from '../shared/components/GoldButton';
import GlassCard from '../shared/components/GlassCard';

// ── Helpers ────────────────────────────────────────────────────────────────

function timeOfDay(ts) {
  const d = new Date(ts);
  let hours = d.getHours();
  const mins = d.getMinutes().toString().padStart(2, '0');
  const ampm = hours >= 12 ? 'pm' : 'am';
  hours = hours % 12;
  hours = hours ? hours : 12;
  return `${hours}:${mins}${ampm}`;
}
function dateLabel(ts) {
  const d = new Date(ts);
  const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.floor((startOfDay(new Date()) - startOfDay(d)) / 86400000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  return d.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
  });
}

// Directed-at-you notifications (assignments, direct pings) vs. household
// broadcasts (feed posts, calendar reminders, check-ins) — matches the real
// `type` values the backend persists (see notification/service.ts callers).
const MENTION_TYPES = ['task', 'todo', 'ping_request', 'ping_response'];
const TABS = [
  {
    key: 'ALL',
    label: 'All',
  },
  {
    key: 'UNREAD',
    label: 'Unread',
  },
  {
    key: 'MENTIONS',
    label: 'Mentions',
  },
];

// Per-type icon + tint — the same "glass chip" language the rest of the app
// uses for avatars/widgets, so the list scans by category at a glance.
const TYPE_META = {
  task: { icon: 'checkbox-outline', tint: colors.gold },
  todo: { icon: 'list-outline', tint: colors.gold },
  feed: { icon: 'images-outline', tint: colors.avatarSky },
  check_in: { icon: 'location-outline', tint: colors.avatarSage },
  ping_request: { icon: 'navigate-outline', tint: colors.avatarSage },
  ping_response: { icon: 'navigate-outline', tint: colors.avatarSage },
  calendar: { icon: 'calendar-outline', tint: colors.avatarLilac },
  expense_reminder: { icon: 'cash-outline', tint: colors.avatarTan },
  household_deletion_scheduled: { icon: 'warning-outline', tint: colors.dangerOnDark },
  household_deletion_cancelled: { icon: 'checkmark-circle-outline', tint: colors.gold },
};
const DEFAULT_TYPE_META = { icon: 'notifications-outline', tint: colors.textMuted };
function getTypeMeta(type) {
  return TYPE_META[type] || DEFAULT_TYPE_META;
}

function groupByDate(items) {
  const map = new Map();
  for (const item of items) {
    const key = dateLabel(item.createdAt);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return Array.from(map.entries()).map(([title, data]) => ({
    title,
    data,
  }));
}

// ── Type icon chip ───────────────────────────────────────────────────────

function NotifIcon({ type }) {
  const meta = getTypeMeta(type);
  return (
    <View style={[styles.iconChip, { backgroundColor: withAlpha(meta.tint, 0.16) }]}>
      <Ionicons name={meta.icon} size={17} color={meta.tint} />
    </View>
  );
}

// ── Component ──────────────────────────────────────────────────────────────

export default function NotificationScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const [all, setAll] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [cursor, setCursor] = useState(null);
  const [hasMore, setHasMore] = useState(true);
  const [activeTab, setActiveTab] = useState('ALL');
  const load = useCallback(
    async (reset = false) => {
      try {
        const data = await notificationApi.getHistory({
          cursor: reset ? undefined : cursor || undefined,
          limit: 30,
        });
        setAll((prev) => (reset ? data.notifications : [...prev, ...data.notifications]));
        setCursor(data.nextCursor);
        setHasMore(data.hasMore);
      } catch {
        showAlert('Error', 'Could not load notifications');
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [cursor],
  );
  useEffect(() => {
    load(true);
  }, []);
  const handleRefresh = () => {
    setRefreshing(true);
    setCursor(null);
    load(true);
  };
  const handleMarkRead = useCallback(async (id) => {
    try {
      await notificationApi.markAsRead(id);
      setAll((prev) =>
        prev.map((n) =>
          n.id === id
            ? {
                ...n,
                isRead: true,
              }
            : n,
        ),
      );
    } catch {
      /* silent */
    }
  }, []);
  const handleMarkAllRead = useCallback(async () => {
    try {
      await notificationApi.markAllAsRead();
      setAll((prev) => prev.map((n) => ({ ...n, isRead: true })));
    } catch {
      showAlert('Error', 'Could not mark all as read');
    }
  }, []);

  // ── Filter + group ─────────────────────────────────────────────────────
  const unreadTotal = all.filter((n) => !n.isRead).length;
  const filtered = (() => {
    if (activeTab === 'UNREAD') return all.filter((n) => !n.isRead);
    if (activeTab === 'MENTIONS') return all.filter((n) => MENTION_TYPES.includes(n.type));
    return all;
  })();
  const sections = groupByDate(filtered);

  // ── Loading ────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <View
        style={[
          styles.root,
          {
            paddingTop: insets.top,
          },
        ]}
      >
        <ActivityIndicator
          size="large"
          color={colors.gold}
          style={{
            flex: 1,
          }}
        />
      </View>
    );
  }

  // ── Render helpers ─────────────────────────────────────────────────────
  const renderSectionHeader = ({ section }) => (
    <Text style={styles.dateLabel}>{section.title}</Text>
  );
  const renderRightActions = (id) => (
    <TouchableOpacity
      style={styles.swipeAction}
      activeOpacity={0.85}
      onPress={() => handleMarkRead(id)}
    >
      <GoldFill radius={16} />
      <Ionicons name="checkmark-done" size={18} color={colors.navyDeep} />
      <Text style={styles.swipeActionText}>Mark read</Text>
    </TouchableOpacity>
  );
  const renderItem = ({ item }) => {
    const card = (
      <GlassCard
        radius={16}
        tone={!item.isRead ? 'gold' : 'neutral'}
        style={styles.card}
        onPress={() => handleMarkRead(item.id)}
      >
        <View style={styles.row}>
          <NotifIcon type={item.type} />
          <View style={styles.rowContent}>
            <Text
              style={[styles.rowTitle, !item.isRead && styles.rowTitleUnread]}
              numberOfLines={1}
            >
              {item.title}
            </Text>
            {item.body ? (
              <Text style={styles.rowBody} numberOfLines={2}>
                {item.body}
              </Text>
            ) : null}
          </View>

          <View style={styles.rowAside}>
            <Text style={styles.rowTime}>{timeOfDay(item.createdAt)}</Text>
            {!item.isRead && <View style={styles.unreadDot} />}
          </View>
        </View>
      </GlassCard>
    );
    // Read notifications have nothing left to swipe for — skip the gesture
    // wrapper so tapping through the list stays cheap.
    if (item.isRead) return <View style={styles.cardWrap}>{card}</View>;
    return (
      <Swipeable
        containerStyle={styles.cardWrap}
        renderRightActions={() => renderRightActions(item.id)}
        overshootRight={false}
      >
        {card}
      </Swipeable>
    );
  };
  return (
    <View
      style={[
        styles.root,
        {
          paddingTop: insets.top,
        },
      ]}
    >
      <StatusBar barStyle="light-content" backgroundColor={colors.canvas} />

      {/* ── Header ── */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => navigation.goBack()}
          activeOpacity={0.8}
          hitSlop={{
            top: 8,
            bottom: 8,
            left: 8,
            right: 8,
          }}
        >
          <Ionicons name="chevron-back" size={20} color={colors.ink} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Notifications</Text>
        {unreadTotal > 0 ? (
          <TouchableOpacity
            onPress={handleMarkAllRead}
            activeOpacity={0.7}
            hitSlop={{
              top: 8,
              bottom: 8,
              left: 8,
              right: 8,
            }}
          >
            <Text style={styles.markAllText}>Mark all read</Text>
          </TouchableOpacity>
        ) : (
          <View style={styles.headerSpacer} />
        )}
      </View>

      {/* ── Filter tabs ── */}
      <View style={styles.tabRow}>
        {TABS.map((tab) => {
          const active = activeTab === tab.key;
          return (
            <TouchableOpacity
              key={tab.key}
              style={[styles.tabChip, active && styles.tabChipActive]}
              onPress={() => setActiveTab(tab.key)}
              activeOpacity={0.7}
            >
              <Text style={[styles.tabChipText, active && styles.tabChipTextActive]}>
                {tab.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {/* ── List ── */}
      <SectionList
        sections={sections}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        renderSectionHeader={renderSectionHeader}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={colors.gold}
            colors={[colors.gold]}
          />
        }
        onEndReached={() => {
          if (hasMore) load();
        }}
        onEndReachedThreshold={0.3}
        stickySectionHeadersEnabled={false}
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={
          <View style={styles.empty}>
            <View style={styles.emptyIconWrap}>
              <Ionicons name="checkmark-done-circle-outline" size={40} color={colors.gold} />
            </View>
            <Text style={styles.emptyTitle}>All clear!</Text>
            <Text style={styles.emptySub}>No notifications here.</Text>
          </View>
        }
        contentContainerStyle={sections.length === 0 ? styles.emptyContainer : styles.listContent}
      />
    </View>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────

const GLASS_BORDER = withAlpha(colors.white, 0.09);

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.canvas,
  },
  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: 56,
    paddingHorizontal: 24,
  },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: withAlpha(colors.white, 0.06),
    borderWidth: 1,
    borderColor: GLASS_BORDER,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: '700',
    fontFamily: fonts.displayBold,
    color: colors.ink,
  },
  headerSpacer: {
    width: 36,
  },
  markAllText: {
    fontSize: 13,
    fontWeight: '700',
    fontFamily: fonts.bodySemiBold,
    color: colors.gold,
  },
  // Filter tabs — gold pill chips, matching the app's chip language
  tabRow: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 24,
    paddingTop: 4,
    paddingBottom: 16,
  },
  tabChip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: withAlpha(colors.white, 0.06),
    borderWidth: 1,
    borderColor: GLASS_BORDER,
  },
  tabChipActive: {
    backgroundColor: colors.goldGlow,
    borderColor: colors.goldGlow,
  },
  tabChipText: {
    fontSize: 13,
    fontWeight: '600',
    fontFamily: fonts.bodySemiBold,
    color: colors.textSecondary,
  },
  tabChipTextActive: {
    color: colors.navyDeep,
  },
  // Date group label
  dateLabel: {
    fontSize: 11,
    fontWeight: '700',
    fontFamily: fonts.bodySemiBold,
    letterSpacing: 0.5,
    color: colors.textMuted,
    paddingHorizontal: 24,
    paddingTop: 14,
    paddingBottom: 8,
  },
  // Notification card
  cardWrap: {
    marginHorizontal: 20,
    marginBottom: 10,
  },
  card: {
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  swipeAction: {
    width: 92,
    borderRadius: 16,
    backgroundColor: colors.gold,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    ...goldButton.glow,
  },
  swipeActionText: {
    fontSize: 11,
    fontWeight: '700',
    fontFamily: fonts.bodySemiBold,
    color: colors.navyDeep,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  iconChip: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  rowContent: {
    flex: 1,
  },
  rowTitle: {
    fontSize: 14,
    lineHeight: 18,
    fontWeight: '600',
    fontFamily: fonts.displayBold,
    color: colors.ink,
  },
  rowTitleUnread: {
    fontWeight: '700',
  },
  rowBody: {
    fontSize: 13,
    lineHeight: 18,
    fontFamily: fonts.body,
    color: colors.textSecondary,
    marginTop: 2,
  },
  rowAside: {
    alignItems: 'flex-end',
    flexShrink: 0,
  },
  rowTime: {
    fontSize: 12,
    fontFamily: fonts.body,
    color: colors.textMuted,
    marginBottom: 6,
  },
  unreadDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: colors.gold,
  },
  // Empty
  listContent: {
    paddingBottom: 60,
    paddingTop: 4,
  },
  emptyContainer: {
    flexGrow: 1,
    justifyContent: 'center',
  },
  empty: {
    alignItems: 'center',
    paddingHorizontal: 40,
  },
  emptyIconWrap: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: withAlpha(colors.goldGlow, 0.12),
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: '800',
    fontFamily: fonts.display,
    color: colors.ink,
    marginBottom: 8,
  },
  emptySub: {
    fontSize: 14,
    fontFamily: fonts.body,
    color: colors.textSecondary,
    textAlign: 'center',
  },
});
