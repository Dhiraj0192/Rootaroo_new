import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SectionList,
  TouchableOpacity,
  RefreshControl,
  StatusBar,
} from 'react-native';
import { showAlert } from '../shared/services/themedAlert';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { SvgXml } from 'react-native-svg';
import { taskApi } from '../shared/api/task';
import { readCache, writeCache } from '../shared/cache/screenCache';
import { useAuthStore } from '../shared/store/authStore';
import { useTabBarDockHeight } from '../shared/hooks/useTabBarDockHeight';
import { colors, spacing, fonts } from '../shared/theme';
import { SpotlightTourProvider, AttachStep } from 'react-native-spotlight-tour';
import TourTooltip from '../shared/components/TourTooltip';
import EmptyState from '../components/EmptyState';
import LoadingSkeleton from '../components/LoadingSkeleton';
import Avatar from '../components/Avatar';
import OfflineBanner from '../components/OfflineBanner';
const CHECK_SVG =
  '<svg width="28" height="28" viewBox="0 0 24 24" fill="none">' +
  `<path d="M5 13l4 4L19 7" stroke="${colors.inkMuted}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path>` +
  '</svg>';
const FILTER_TABS = [
  {
    key: 'ALL',
    label: 'All',
  },
  {
    key: 'MINE',
    label: 'Mine',
  },
  {
    key: 'OVERDUE',
    label: 'Overdue',
  },
];
const SECTION_META = {
  overdue: {
    title: 'Overdue',
    statusColor: colors.danger,
  },
  pending: {
    title: 'Pending',
    statusColor: colors.goldDeep,
  },
  completedToday: {
    title: 'Completed Today',
    statusColor: colors.success,
  },
};
function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

/** Assigned-to / assigned-by pair for a task row, each labeled. */
function rowMetaParts(task) {
  const assignee = task.assignees[0]?.displayName;
  const creator = task.createdBy?.displayName;
  return {
    to: assignee ? `To: ${assignee}` : null,
    by: creator ? `By: ${creator}` : null,
  };
}

/** Right-aligned status label for a task row. */
function rowStatus(task, key) {
  if (key === 'overdue') return 'Overdue';
  if (key === 'completedToday') return 'Done';
  const due = formatDate(task.dueDate);
  return due ? `Due ${due}` : 'No date';
}
export default function TaskListScreen({ navigation }) {
  // Last session's lists paint instantly; the focus fetch below refreshes them.
  const [grouped, setGrouped] = useState(
    () =>
      readCache('tasks') || {
        overdue: [],
        pending: [],
        completedToday: [],
      },
  );
  const [loading, setLoading] = useState(() => !readCache('tasks'));
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState('ALL');
  const user = useAuthStore((s) => s.user);
  const insets = useSafeAreaInsets();
  const dockHeight = useTabBarDockHeight();
  const canCreateTask = user?.role === 'admin' || user?.role === 'member';
  const showTasksTour = useAuthStore((s) => s.showTasksTour);
  const dismissTasksTour = useAuthStore((s) => s.dismissTasksTour);
  const triggerMoreTour = useAuthStore((s) => s.triggerMoreTour);
  const addTaskRef = useRef(null);
  const filterRowRef = useRef(null);
  const tourRef = useRef(null);
  const tourSteps = useMemo(() => {
    const meta = [
      ...(canCreateTask
        ? [{ ref: addTaskRef, title: 'Add a task', body: 'Tap here to assign a new to-do to your household.' }]
        : []),
      { ref: filterRowRef, title: 'Tasks & points', body: 'Completing a task, todo, or grocery run earns your household points — see who\'s leading on Home.' },
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
            continueLabel={isChainLast ? 'Continue to More' : undefined}
            onContinue={isChainLast ? () => {
              props.stop();
              navigation.navigate('MoreStack', { screen: 'MoreIndex' });
              triggerMoreTour();
            } : undefined}
          />
        );
      },
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canCreateTask]);
  useEffect(() => {
    if (!showTasksTour) return;
    let cancelled = false;
    const tryStart = () => {
      if (cancelled) return;
      if (tourRef.current) {
        tourRef.current.start();
        dismissTasksTour();
      } else {
        requestAnimationFrame(tryStart);
      }
    };
    tryStart();
    return () => {
      cancelled = true;
    };
  }, [showTasksTour, dismissTasksTour]);
  const loadTasks = useCallback(async () => {
    try {
      const data = await taskApi.list({
        group: 'status',
      });
      setGrouped(data);
      writeCache('tasks', data);
    } catch {
      showAlert('Error', 'Could not load tasks');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);
  useFocusEffect(
    useCallback(() => {
      loadTasks();
    }, [loadTasks]),
  );
  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    loadTasks();
  }, [loadTasks]);
  const applyFilter = useCallback(
    (tasks) => {
      if (filter === 'MINE') {
        return tasks.filter((t) => t.assignees.some((a) => a.id === user?.id));
      }
      return tasks;
    },
    [filter, user],
  );
  const sections = ['overdue', 'pending', 'completedToday']
    .map((key) => {
      let data = applyFilter(grouped[key]);
      if (filter === 'OVERDUE' && key !== 'overdue') data = [];
      return {
        ...SECTION_META[key],
        key,
        data,
      };
    })
    .filter((s) => s.data.length > 0);
  const totalCount =
    grouped.overdue.length + grouped.pending.length + grouped.completedToday.length;
  const renderSectionHeader = ({ section }) => (
    <View style={styles.sectionHeader}>
      <View
        style={[
          styles.sectionDot,
          {
            backgroundColor: section.statusColor,
          },
        ]}
      />
      <Text
        style={[
          styles.sectionTitle,
          {
            color: section.statusColor,
          },
        ]}
      >
        {section.title.toUpperCase()}
      </Text>
      <Text
        style={[
          styles.sectionCount,
          {
            color: section.statusColor,
          },
        ]}
      >
        {section.data.length}
      </Text>
    </View>
  );
  const renderTask = ({ item, section }) => (
    <TouchableOpacity
      style={styles.taskRow}
      onPress={() =>
        navigation.navigate('TaskDetail', {
          taskId: item.id,
        })
      }
      activeOpacity={0.6}
    >
      <View style={styles.taskRowTop}>
        {(() => {
          const person = item.assignees[0] || item.createdBy;
          return (
            <Avatar
              url={person?.avatarUrl}
              emoji={person?.avatarEmoji}
              name={person?.displayName || '?'}
              id={person?.id}
              size={30}
              style={styles.taskRowAvatar}
            />
          );
        })()}
        <View style={styles.taskRowLeft}>
          <Text style={styles.taskTitle} numberOfLines={1}>
            {item.title}
          </Text>
        </View>
        <Text
          style={[
            styles.taskStatus,
            {
              color: section.statusColor,
            },
          ]}
        >
          {rowStatus(item, section.key)}
        </Text>
      </View>
      {(() => {
        const { to, by } = rowMetaParts(item);
        if (!to && !by) return null;
        return (
          <View style={styles.taskMetaRow}>
            <Text style={styles.taskMeta} numberOfLines={1}>
              {to || ''}
            </Text>
            <Text style={styles.taskMeta} numberOfLines={1}>
              {by || ''}
            </Text>
          </View>
        );
      })()}
    </TouchableOpacity>
  );
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

      {/* ── Header: title + add task link (SCREEN 16) ── */}
      <View style={styles.header}>
        <Text style={styles.screenTitle}>Tasks</Text>
        {canCreateTask && (
          <AttachStep index={0} style={{ alignSelf: 'center' }}>
            <TouchableOpacity
              ref={addTaskRef}
              onPress={() => navigation.navigate('CreateTask')}
              hitSlop={8}
              activeOpacity={0.6}
            >
              <Text style={styles.addTaskLink}>Add task</Text>
            </TouchableOpacity>
          </AttachStep>
        )}
      </View>

      {/* ── Filter tabs: text row (SCREEN 16) ── */}
      <AttachStep index={canCreateTask ? 1 : 0} fill>
      <View style={styles.filterRow} ref={filterRowRef}>
        {FILTER_TABS.map((tab) => {
          const active = filter === tab.key;
          return (
            <TouchableOpacity key={tab.key} onPress={() => setFilter(tab.key)} activeOpacity={0.6}>
              <Text style={[styles.filterTab, active && styles.filterTabActive]}>{tab.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
      </AttachStep>

      {/* Offline banner */}
      <View style={styles.bannerWrap}>
        <OfflineBanner onRetry={handleRefresh} />
      </View>

      {/* ── Grouped task list (flat rows) ── */}
      <SectionList
        sections={sections}
        keyExtractor={(item) => item.id}
        renderItem={renderTask}
        renderSectionHeader={renderSectionHeader}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={colors.gold}
            colors={[colors.gold]}
          />
        }
        ListEmptyComponent={
          <EmptyState
            icon={<SvgXml xml={CHECK_SVG} width={28} height={28} />}
            title="All caught up"
            subtitle="No tasks assigned to the household right now."
            actionLabel="Add a task"
            onAction={() => navigation.navigate('CreateTask')}
          />
        }
        contentContainerStyle={
          totalCount === 0
            ? styles.emptyContainer
            : [styles.listContent, { paddingBottom: dockHeight + 24 }]
        }
        stickySectionHeadersEnabled={false}
        showsVerticalScrollIndicator={false}
      />
    </View>
    </SpotlightTourProvider>
  );
}
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.canvas,
    marginTop: 20,
    marginBottom: 90,
    paddingHorizontal: 8,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: colors.canvas,
  },
  // Header
  header: {
    height: 60,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.xxl,
  },
  screenTitle: {
    fontSize: 19,
    fontWeight: '700',
    fontFamily: fonts.displayBold,
    color: colors.ink,
  },
  addTaskLink: {
    fontSize: 14,
    fontWeight: '500',
    fontFamily: fonts.bodyMedium,
    color: colors.goldDeep,
  },
  // Filter tabs
  filterRow: {
    flexDirection: 'row',
    gap: 26,
    paddingHorizontal: spacing.xxl,
    paddingTop: 4,
    paddingBottom: 16,
  },
  filterTab: {
    fontSize: 14,
    fontWeight: '400',
    fontFamily: fonts.body,
    color: colors.textMuted,
  },
  filterTabActive: {
    fontWeight: '600',
    fontFamily: fonts.bodySemiBold,
    color: colors.ink,
  },
  // Section headers
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: spacing.xxl,
    paddingTop: spacing.xxl,
    paddingBottom: 6,
  },
  sectionDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: '700',
    fontFamily: fonts.bodyBold,
    letterSpacing: 1.4,
  },
  sectionCount: {
    fontSize: 11,
    fontWeight: '700',
    fontFamily: fonts.bodyBold,
    opacity: 0.7,
  },
  // Task rows
  taskRowAvatar: {
    marginTop: 2,
  },
  taskRow: {
    paddingVertical: 18,
    marginHorizontal: spacing.xxl,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  taskRowTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  taskRowLeft: {
    flex: 1,
  },
  taskTitle: {
    fontSize: 16,
    fontWeight: '600',
    fontFamily: fonts.displayBold,
    color: colors.ink,
  },
  taskMetaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 6,
  },
  taskMeta: {
    fontSize: 13,
    fontFamily: fonts.body,
    color: colors.textSecondary,
  },
  taskStatus: {
    fontSize: 13,
    fontWeight: '600',
    fontFamily: fonts.bodySemiBold,
  },
  // Empty
  listContent: {
    paddingBottom: 24,
  },
  emptyContainer: {
    flexGrow: 1,
    justifyContent: 'center',
  },
  bannerWrap: {
    paddingHorizontal: spacing.xxl,
    paddingTop: 4,
    paddingBottom: 8,
  },
  empty: {
    alignItems: 'center',
    paddingHorizontal: 40,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: '800',
    fontFamily: fonts.display,
    color: colors.ink,
    marginBottom: 8,
  },
  emptySubtitle: {
    fontSize: 14,
    fontFamily: fonts.body,
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
  },
});
