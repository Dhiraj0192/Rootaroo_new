import React, { useCallback, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  StatusBar,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import Svg, { Circle } from 'react-native-svg';
import { format, isToday, isYesterday, parseISO } from 'date-fns';
import { colors, fonts, goldButton, radius, spacing, withAlpha } from '../shared/theme';
import { GoldFill } from '../shared/components/GoldButton';
import { journalApi } from '../shared/api/journal';
import { moodById, moodIcon } from '../shared/constants/journalMoods';
import GlassCard from '../shared/components/GlassCard';
import EmptyState from '../components/EmptyState';
import { useTabBarDockHeight } from '../shared/hooks/useTabBarDockHeight';

const RING_SIZE = 62;
const RING_STROKE = 5;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/**
 * The streak ring fills against the user's own best run, so the arc always
 * means "how close am I to my record" — a fixed 30-day denominator would leave
 * a 3-day streak looking like failure and a 40-day one pinned at full.
 * `bestStreak` is never smaller than `streak` (the server derives one from the
 * other), so the fraction cannot exceed 1.
 */
function StreakRing({ streak, bestStreak }) {
  const target = Math.max(bestStreak, 1);
  const progress = Math.min(streak / target, 1);
  return (
    <View style={styles.ringWrap}>
      <Svg width={RING_SIZE} height={RING_SIZE}>
        <Circle
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={RING_RADIUS}
          stroke={withAlpha(colors.white, 0.1)}
          strokeWidth={RING_STROKE}
          fill="none"
        />
        <Circle
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={RING_RADIUS}
          stroke={colors.goldGlow}
          strokeWidth={RING_STROKE}
          strokeLinecap="round"
          fill="none"
          strokeDasharray={`${RING_CIRCUMFERENCE} ${RING_CIRCUMFERENCE}`}
          strokeDashoffset={RING_CIRCUMFERENCE * (1 - progress)}
          // Start the arc at 12 o'clock instead of 3.
          transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
        />
      </Svg>
      <View style={styles.ringLabel} pointerEvents="none">
        <Text style={styles.ringNumber}>{streak}</Text>
        <Text style={styles.ringUnit}>DAYS</Text>
      </View>
    </View>
  );
}

/** One square in the last-7-days strip: written days carry their mood's tint. */
function DaySquare({ day, isLast }) {
  const mood = moodById(day.mood);
  return (
    <View
      style={[
        styles.daySquare,
        day.written && styles.daySquareWritten,
        day.written && mood && { backgroundColor: withAlpha(colors.goldGlow, 0.1 + (mood.score / 5) * 0.28) },
        isLast && styles.daySquareToday,
      ]}
    />
  );
}

/** "Today" / "Yesterday" / "Wed, Jul 15" — how a person names a recent day. */
function relativeDayLabel(date) {
  if (isToday(date)) return 'Today';
  if (isYesterday(date)) return 'Yesterday';
  return format(date, 'EEE, MMM d');
}

function EntryRow({ entry, onPress, isLast }) {
  const date = parseISO(entry.createdAt);
  const mood = moodById(entry.mood);
  return (
    <TouchableOpacity
      style={[styles.entryRow, isLast && styles.entryRowLast]}
      onPress={onPress}
      activeOpacity={0.75}
    >
      <View style={styles.entryMood}>
        <MaterialCommunityIcons
          name={moodIcon(entry.mood)}
          size={17}
          color={mood ? colors.goldGlowSoft : colors.textMuted}
        />
      </View>
      <View style={styles.entryBody}>
        <View style={styles.entryHeader}>
          <Text style={styles.entryDay}>{relativeDayLabel(date)}</Text>
          <Text style={styles.entryTime}>{format(date, 'h:mmaaa')}</Text>
        </View>
        <Text style={styles.entrySnippet} numberOfLines={2}>
          {entry.content?.trim() || 'Photo entry'}
        </Text>
      </View>
    </TouchableOpacity>
  );
}

export default function JournalScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const dockHeight = useTabBarDockHeight();
  const [stats, setStats] = useState(null);
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      // Stats and the recent list are independent reads; failing either one
      // should not blank the other, so they settle separately.
      const [statsResult, listResult] = await Promise.allSettled([
        journalApi.stats(),
        journalApi.list({ limit: 5 }),
      ]);
      if (statsResult.status === 'fulfilled') setStats(statsResult.value);
      if (listResult.status === 'fulfilled') setEntries(listResult.value.entries);
      setError(
        statsResult.status === 'rejected' && listResult.status === 'rejected'
          ? 'Could not load your journal.'
          : null,
      );
    } finally {
      setLoading(false);
    }
  }, []);

  // Re-read on focus: coming back from the composer or the detail screen must
  // show the entry that was just written, and the streak it just advanced.
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const today = useMemo(() => new Date(), []);
  const openComposer = (prompt) => navigation.navigate('JournalEditor', { prompt });

  if (loading) {
    return (
      <View style={[styles.screen, styles.centered, { paddingTop: insets.top }]}>
        <StatusBar barStyle="light-content" backgroundColor={colors.canvas} />
        <ActivityIndicator color={colors.gold} />
      </View>
    );
  }

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <StatusBar barStyle="light-content" backgroundColor={colors.canvas} />

      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.title}>Journal</Text>
          <Text style={styles.subtitle}>{format(today, 'EEEE, MMMM d')}</Text>
        </View>
        <View style={styles.headerActions}>
          <TouchableOpacity
            style={styles.historyBtn}
            onPress={() => navigation.navigate('JournalHistory')}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel="Journal history"
          >
            <Ionicons name="stats-chart-outline" size={18} color={colors.ink} />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.addBtn}
            onPress={() => openComposer()}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityLabel="New journal entry"
          >
            <GoldFill radius={17} />
            <Ionicons name="add" size={24} color={colors.canvas} />
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: dockHeight + spacing.xxxl }]}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.gold} />
        }
      >
        {error ? <Text style={styles.errorText}>{error}</Text> : null}

        {stats ? (
          <GlassCard style={styles.streakCard} radius={radius.xl} tone="blue">
            <View style={styles.cardLabelRow}>
              <Text style={styles.cardLabel}>WRITING STREAK</Text>
              <View style={styles.bestChip}>
                <Text style={styles.bestChipText}>BEST {stats.bestStreak}</Text>
              </View>
            </View>

            <View style={styles.streakBody}>
              <StreakRing streak={stats.streak} bestStreak={stats.bestStreak} />
              <View style={styles.streakCopy}>
                <Text style={styles.streakHeadline}>
                  {stats.wroteToday ? 'Today is written down' : 'Write today to keep it going'}
                </Text>
                <Text style={styles.streakMeta}>
                  {stats.entriesThisMonth} {stats.entriesThisMonth === 1 ? 'entry' : 'entries'} this
                  month · {stats.wordsThisMonth.toLocaleString()} words
                </Text>
              </View>
            </View>

            <View style={styles.dayStrip}>
              {stats.last7Days.map((day, index) => (
                <DaySquare key={day.date} day={day} isLast={index === stats.last7Days.length - 1} />
              ))}
            </View>
          </GlassCard>
        ) : null}

        {stats?.prompt ? (
          <TouchableOpacity activeOpacity={0.85} onPress={() => openComposer(stats.prompt)}>
            <GlassCard style={styles.promptCard} radius={radius.lg} tone="gold">
              <Text style={styles.promptLabel}>TODAY’S PROMPT</Text>
              <Text style={styles.promptText}>{stats.prompt}</Text>
              <View style={styles.promptCtaRow}>
                <Text style={styles.promptCta}>Start writing</Text>
                <Ionicons name="arrow-forward" size={12} color={colors.gold} />
              </View>
            </GlassCard>
          </TouchableOpacity>
        ) : null}

        <Text style={styles.sectionLabel}>RECENT ENTRIES</Text>

        {entries.length === 0 ? (
          <EmptyState
            dark
            icon={<Ionicons name="book-outline" size={26} color={colors.gold} />}
            title="Nothing written yet"
            subtitle="Your journal is private — only you can read what you put here."
            actionLabel="Write your first entry"
            onAction={() => openComposer(stats?.prompt)}
          />
        ) : (
          <View style={styles.entryList}>
            {entries.map((entry, index) => (
              <EntryRow
                key={entry.id}
                entry={entry}
                isLast={index === entries.length - 1}
                onPress={() => navigation.navigate('JournalEntry', { entryId: entry.id })}
              />
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.canvas },
  centered: { alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.md,
    paddingBottom: spacing.lg,
  },
  headerText: { flex: 1 },
  title: {
    fontSize: 27,
    lineHeight: 34,
    fontFamily: fonts.displayBold,
    color: colors.ink,
    letterSpacing: -0.3,
  },
  subtitle: {
    fontSize: 13,
    lineHeight: 18,
    fontFamily: fonts.body,
    color: colors.textSecondary,
    marginTop: 2,
  },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  historyBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  addBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.gold,
    ...goldButton.glow,
  },
  scroll: { paddingHorizontal: spacing.xl },
  errorText: {
    fontFamily: fonts.body,
    fontSize: 13,
    color: colors.danger,
    marginBottom: spacing.md,
  },

  /* Streak card */
  streakCard: { padding: spacing.lg },
  cardLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.lg,
  },
  cardLabel: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 10,
    letterSpacing: 1.1,
    color: colors.textMuted,
  },
  bestChip: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.xs,
    backgroundColor: colors.surfaceDark,
  },
  bestChipText: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 9,
    letterSpacing: 0.8,
    color: colors.textSecondary,
  },
  streakBody: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg },
  ringWrap: { width: RING_SIZE, height: RING_SIZE, alignItems: 'center', justifyContent: 'center' },
  ringLabel: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  ringNumber: {
    fontFamily: fonts.displayBold,
    fontSize: 21,
    lineHeight: 24,
    color: colors.ink,
  },
  ringUnit: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 7.5,
    letterSpacing: 1,
    color: colors.textMuted,
  },
  streakCopy: { flex: 1 },
  streakHeadline: {
    fontFamily: fonts.bodyBold,
    fontSize: 14,
    lineHeight: 19,
    color: colors.ink,
  },
  streakMeta: {
    fontFamily: fonts.body,
    fontSize: 11.5,
    lineHeight: 16,
    color: colors.textSecondary,
    marginTop: 4,
  },
  dayStrip: { flexDirection: 'row', gap: 6, marginTop: spacing.lg },
  daySquare: {
    flex: 1,
    height: 30,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceDark,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  daySquareWritten: { backgroundColor: withAlpha(colors.goldGlow, 0.22) },
  daySquareToday: { borderColor: withAlpha(colors.goldGlow, 0.55) },

  /* Prompt card */
  promptCard: {
    padding: spacing.lg,
    marginTop: spacing.md,
    borderColor: withAlpha(colors.goldGlow, 0.28),
  },
  promptLabel: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 10,
    letterSpacing: 1.1,
    color: colors.goldGlowDim,
  },
  promptText: {
    fontFamily: fonts.bodyBold,
    fontSize: 14,
    lineHeight: 20,
    color: colors.ink,
    marginTop: spacing.sm,
  },
  promptCtaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: spacing.md,
  },
  promptCta: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 12.5,
    color: colors.gold,
  },

  /* Recent entries */
  sectionLabel: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 10,
    letterSpacing: 1.1,
    color: colors.textMuted,
    marginTop: spacing.xxl,
    marginBottom: spacing.md,
  },
  entryList: {},
  entryRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.divider,
  },
  entryRowLast: { borderBottomWidth: 0 },
  entryMood: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderCool,
  },
  entryBody: { flex: 1 },
  entryHeader: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  entryDay: {
    fontFamily: fonts.bodyBold,
    fontSize: 13.5,
    color: colors.ink,
  },
  entryTime: {
    fontFamily: fonts.body,
    fontSize: 11,
    color: colors.textMuted,
  },
  entrySnippet: {
    fontFamily: fonts.body,
    fontSize: 12.5,
    lineHeight: 18,
    color: colors.textSecondary,
    marginTop: 3,
  },
});
