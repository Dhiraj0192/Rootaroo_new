import React, { useCallback, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  StatusBar,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { format, parse } from 'date-fns';
import { colors, fonts, radius, spacing, withAlpha } from '../shared/theme';
import { getJournalRepo } from '../shared/journal/journalRepo';
import { MAX_SCORE, moodById } from '../shared/constants/journalMoods';
import GlassCard from '../shared/components/GlassCard';
import { useTabBarDockHeight } from '../shared/hooks/useTabBarDockHeight';

const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const CHART_HEIGHT = 74;

/** `yyyy-MM` shifted by `delta` months. */
function shiftMonth(monthKey, delta) {
  const [year, month] = monthKey.split('-').map(Number);
  const d = new Date(Date.UTC(year, month - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

function currentMonthKey() {
  return format(new Date(), 'yyyy-MM');
}

/**
 * One bar per day that recorded a mood. Height is the mood's score against the
 * scale's maximum, so the chart's baseline means "worst day", not "no entry" —
 * days without a mood are simply absent rather than drawn as zero.
 */
function MoodChart({ moodDays }) {
  if (moodDays.length === 0) {
    return <Text style={styles.chartEmpty}>No moods recorded this month yet.</Text>;
  }
  const best = Math.max(...moodDays.map((d) => d.score));
  return (
    <View style={styles.chart}>
      {moodDays.map((day) => {
        // The month's best days are the ones worth picking out in gold; the
        // rest recede so the shape of the month reads at a glance.
        const isBest = day.score === best;
        return (
          <View
            key={day.date}
            style={[
              styles.bar,
              {
                height: Math.max((day.score / MAX_SCORE) * CHART_HEIGHT, 8),
                backgroundColor: isBest ? colors.goldGlow : withAlpha(colors.white, 0.16),
              },
            ]}
          />
        );
      })}
    </View>
  );
}

/**
 * A month grid starting Monday. Leading blanks come from the server's
 * `firstWeekday` so the client never has to re-derive where the 1st sits.
 */
function EntryCalendar({ history, todayKey }) {
  const cells = useMemo(() => {
    const moodByDate = new Map(Object.entries(history.moodDays));
    const written = new Set(history.entryDates);
    const list = [];
    for (let i = 0; i < history.firstWeekday; i += 1) list.push({ key: `blank-${i}`, blank: true });
    for (let day = 1; day <= history.daysInMonth; day += 1) {
      const date = `${history.month}-${String(day).padStart(2, '0')}`;
      list.push({
        key: date,
        date,
        written: written.has(date),
        mood: moodByDate.get(date) || null,
        isToday: date === todayKey,
      });
    }
    return list;
  }, [history, todayKey]);

  return (
    <View style={styles.calendar}>
      <View style={styles.weekdayRow}>
        {WEEKDAYS.map((letter, index) => (
          <Text key={`${letter}-${index}`} style={styles.weekday}>
            {letter}
          </Text>
        ))}
      </View>
      <View style={styles.calendarGrid}>
        {cells.map((cell) => {
          if (cell.blank) return <View key={cell.key} style={styles.calendarCellSpacer} />;
          const mood = moodById(cell.mood);
          return (
            <View
              key={cell.key}
              style={[
                styles.calendarCell,
                cell.written && styles.calendarCellWritten,
                mood && {
                  backgroundColor: withAlpha(colors.goldGlow, 0.1 + (mood.score / MAX_SCORE) * 0.42),
                },
                cell.isToday && styles.calendarCellToday,
              ]}
            />
          );
        })}
      </View>
    </View>
  );
}

export default function JournalHistoryScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const dockHeight = useTabBarDockHeight();
  const [month, setMonth] = useState(currentMonthKey);
  const [history, setHistory] = useState(null);
  const [loading, setLoading] = useState(true);

  const todayKey = useMemo(() => format(new Date(), 'yyyy-MM-dd'), []);
  const thisMonth = currentMonthKey();

  const load = useCallback(async (target) => {
    setLoading(true);
    try {
      setHistory(await getJournalRepo().monthView(target));
    } catch {
      setHistory(null);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    load(month);
  }, [load, month]);

  const monthLabel = format(parse(`${month}-01`, 'yyyy-MM-dd', new Date()), 'MMMM yyyy');
  const moodBars = useMemo(
    () =>
      history
        ? Object.entries(history.moodDays)
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([date, mood]) => ({ date, score: moodById(mood)?.score ?? 0 }))
            .filter((d) => d.score > 0)
        : [],
    [history],
  );

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <StatusBar barStyle="light-content" backgroundColor={colors.canvas} />

      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          hitSlop={12}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <Ionicons name="chevron-back" size={22} color={colors.ink} />
        </TouchableOpacity>
        <Text style={styles.title}>History</Text>
        <View style={styles.monthNav}>
          <TouchableOpacity
            onPress={() => setMonth(shiftMonth(month, -1))}
            hitSlop={10}
            accessibilityLabel="Previous month"
          >
            <Ionicons name="chevron-back" size={14} color={colors.textMuted} />
          </TouchableOpacity>
          <Text style={styles.monthLabel}>{monthLabel}</Text>
          <TouchableOpacity
            onPress={() => setMonth(shiftMonth(month, 1))}
            hitSlop={10}
            // The journal has no future, so forward stops at the current month.
            disabled={month >= thisMonth}
            accessibilityLabel="Next month"
          >
            <Ionicons
              name="chevron-forward"
              size={14}
              color={month >= thisMonth ? colors.textFaint : colors.textMuted}
            />
          </TouchableOpacity>
        </View>
      </View>

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator color={colors.gold} />
        </View>
      ) : !history ? (
        <View style={styles.centered}>
          <Text style={styles.chartEmpty}>Could not load your history.</Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={[styles.scroll, { paddingBottom: dockHeight + spacing.xxxl }]}
          showsVerticalScrollIndicator={false}
        >
          <GlassCard style={styles.card} radius={radius.lg} tone="blue">
            <Text style={styles.cardLabel}>MOOD THIS MONTH</Text>
            <MoodChart moodDays={moodBars} />
            <View style={styles.chartFooter}>
              <Text style={styles.chartSummary}>
                {history.moodSummary || 'No mood yet'} · {history.goodDays}{' '}
                {history.goodDays === 1 ? 'good day' : 'good days'}
              </Text>
            </View>
          </GlassCard>

          <GlassCard style={[styles.card, styles.calendarCard]} radius={radius.lg}>
            <Text style={styles.cardLabel}>ENTRY CALENDAR</Text>
            <EntryCalendar history={history} todayKey={todayKey} />
          </GlassCard>

          <Text style={styles.sectionLabel}>TOP TAGS</Text>
          {history.topTags.length === 0 ? (
            <Text style={styles.chartEmpty}>Tag an entry and it will show up here.</Text>
          ) : (
            <View style={styles.tagRow}>
              {history.topTags.map((tag, index) => (
                <View key={tag.tag} style={[styles.tagChip, index === 0 && styles.tagChipTop]}>
                  <Text style={[styles.tagChipText, index === 0 && styles.tagChipTextTop]}>
                    {tag.tag} · {tag.count}
                  </Text>
                </View>
              ))}
            </View>
          )}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.canvas },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.md,
    paddingBottom: spacing.lg,
  },
  title: {
    flex: 1,
    fontSize: 27,
    lineHeight: 34,
    fontFamily: fonts.displayBold,
    color: colors.ink,
    letterSpacing: -0.3,
  },
  monthNav: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  monthLabel: { fontFamily: fonts.body, fontSize: 12.5, color: colors.textSecondary },

  scroll: { paddingHorizontal: spacing.xl },
  card: { padding: spacing.lg },
  calendarCard: { marginTop: spacing.md },
  cardLabel: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 10,
    letterSpacing: 1.1,
    color: colors.textMuted,
  },

  chart: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 6,
    height: CHART_HEIGHT,
    marginTop: spacing.lg,
  },
  bar: { flex: 1, borderRadius: radius.xs, maxWidth: 22 },
  chartEmpty: {
    fontFamily: fonts.body,
    fontSize: 12,
    color: colors.textMuted,
    marginTop: spacing.md,
  },
  chartFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.lg,
  },
  chartSummary: { flex: 1, fontFamily: fonts.body, fontSize: 11.5, color: colors.textSecondary },

  calendar: { marginTop: spacing.lg },
  weekdayRow: { flexDirection: 'row', marginBottom: spacing.sm },
  weekday: {
    flex: 1,
    textAlign: 'center',
    fontFamily: fonts.bodySemiBold,
    fontSize: 9.5,
    letterSpacing: 0.6,
    color: colors.textFaint,
  },
  calendarGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  // 7 columns; the 0.6% left over per cell is the gutter between them.
  calendarCellSpacer: { width: '13.6%', aspectRatio: 1, margin: '0.2%' },
  calendarCell: {
    width: '13.6%',
    aspectRatio: 1,
    margin: '0.2%',
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceDark,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  // An entry with no mood still marks the day — just without a mood's warmth.
  calendarCellWritten: { backgroundColor: withAlpha(colors.white, 0.13) },
  calendarCellToday: { borderColor: colors.goldGlow },

  sectionLabel: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 10,
    letterSpacing: 1.1,
    color: colors.textMuted,
    marginTop: spacing.xxl,
    marginBottom: spacing.md,
  },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  tagChip: {
    paddingHorizontal: spacing.md,
    height: 26,
    justifyContent: 'center',
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
  },
  tagChipTop: { backgroundColor: withAlpha(colors.goldGlow, 0.18) },
  tagChipText: { fontFamily: fonts.body, fontSize: 11.5, color: colors.inkDeep },
  tagChipTextTop: { color: colors.goldGlowSoft, fontFamily: fonts.bodySemiBold },
});
