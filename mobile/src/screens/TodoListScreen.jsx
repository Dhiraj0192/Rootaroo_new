import React, { useCallback, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  StatusBar,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  useWindowDimensions,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import DateTimePicker from '@react-native-community/datetimepicker';
import { format, addDays, addWeeks, startOfWeek } from 'date-fns';
import { showAlert } from '../shared/services/themedAlert';
import { todoApi } from '../shared/api/todo';
import { homeRequests } from '../shared/cache/homePrefetch';
import { readCache, writeCache } from '../shared/cache/screenCache';
import { useAuthStore } from '../shared/store/authStore';
import { colors, fonts, goldButton, radius } from '../shared/theme';
import { GoldFill } from '../shared/components/GoldButton';
import ConfirmSheet from '../components/ConfirmSheet';
import { KEYBOARD_BEHAVIOR, keyboardScrollProps } from '../shared/components/KeyboardAware';
import { useTabBarDockHeight } from '../shared/hooks/useTabBarDockHeight';
import { Field, AssigneePickerSheet, BottomSheet, sheet } from '../shared/components/listSheet';

// The week strip pages a week at a time, this far either side of today.
const WEEKS_EACH_SIDE = 52;
const WEEK_OPTS = { weekStartsOn: 1 };
const SCREEN_GUTTER = 20;
const DAY_LABELS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

const dayKey = (date) => format(date, 'yyyy-MM-dd');

/** Which day a to-do sits on. Undated ones live on today — pending, or
 * finished today — so they neither vanish nor pile up forever. */
function belongsOn(item, key, todayKey) {
  if (item.dueDate) return item.dueDate === key;
  if (key !== todayKey) return false;
  return !item.isCompleted || (item.completedAt && dayKey(new Date(item.completedAt)) === todayKey);
}

// "Anytime" first, then by time of day.
function byTimeOfDay(a, b) {
  if (!a.dueTime && !b.dueTime) return 0;
  if (!a.dueTime) return -1;
  if (!b.dueTime) return 1;
  return a.dueTime.localeCompare(b.dueTime);
}

export default function TodoListScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const dockHeight = useTabBarDockHeight();
  const { width } = useWindowDimensions();
  // The strip pages by its own width, so it's inset rather than padded.
  const stripWidth = width - SCREEN_GUTTER * 2;
  const dayWidth = Math.min(44, Math.floor(stripWidth / 7) - 2);
  const user = useAuthStore((s) => s.user);
  const householdId = useAuthStore((s) => s.householdId);
  const isAdmin = user?.role === 'admin';

  const today = useMemo(() => new Date(), []);
  const todayKey = dayKey(today);
  const baseWeek = useMemo(() => startOfWeek(today, WEEK_OPTS), [today]);

  const [items, setItems] = useState(() => readCache('todos') || []);
  const [loading, setLoading] = useState(() => !readCache('todos'));
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState(today);
  const [quickTitle, setQuickTitle] = useState('');
  const [quickSaving, setQuickSaving] = useState(false);

  // Add / edit sheet
  const [showSheet, setShowSheet] = useState(false);
  const [editItem, setEditItem] = useState(null);
  const [title, setTitle] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [dueTime, setDueTime] = useState('');
  const [assignee, setAssignee] = useState(null);
  const [members, setMembers] = useState([]);
  const [saving, setSaving] = useState(false);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showTimePicker, setShowTimePicker] = useState(false);
  const [showAssigneeSheet, setShowAssigneeSheet] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);

  // ─── Data ─────────────────────────────────────────────────────────────

  const load = useCallback(async () => {
    try {
      const data = await todoApi.list();
      const all = [...(data?.pending || []), ...(data?.completed || [])];
      setItems(all);
      writeCache('todos', all);
    } catch {
      showAlert('Error', 'Could not load to-dos');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );
  const loadMembers = useCallback(async () => {
    if (!householdId) return;
    try {
      setMembers(await homeRequests.members(householdId));
    } catch {
      /* picker just shows nobody */
    }
  }, [householdId]);

  // ─── Derived ──────────────────────────────────────────────────────────

  const selectedKey = dayKey(selected);
  const dayItems = useMemo(
    () => items.filter((i) => belongsOn(i, selectedKey, todayKey)).sort(byTimeOfDay),
    [items, selectedKey, todayKey],
  );
  const leftCount = dayItems.filter((i) => !i.isCompleted).length;
  const busyDays = useMemo(() => {
    const set = new Set();
    items.forEach((i) => {
      if (i.isCompleted) return;
      set.add(i.dueDate || todayKey);
    });
    return set;
  }, [items, todayKey]);
  const weeks = useMemo(
    () =>
      Array.from({ length: WEEKS_EACH_SIDE * 2 + 1 }, (_, n) =>
        addWeeks(baseWeek, n - WEEKS_EACH_SIDE),
      ),
    [baseWeek],
  );

  // ─── Actions ──────────────────────────────────────────────────────────

  const canToggle = (item) =>
    !item.assignedTo || item.assignedTo.id === user?.id || isAdmin;
  const canDelete = (item) => item.assignedTo?.id === user?.id || isAdmin;

  const toggle = useCallback(
    async (item) => {
      // Flip locally first so the tick feels instant; the reload settles it.
      setItems((prev) =>
        prev.map((i) =>
          i.id === item.id
            ? {
                ...i,
                isCompleted: !i.isCompleted,
                completedAt: i.isCompleted ? null : new Date().toISOString(),
              }
            : i,
        ),
      );
      try {
        await todoApi.toggle(item.id);
      } catch {
        showAlert('Error', 'Could not update to-do');
      }
      load();
    },
    [load],
  );

  const onWeekSettled = useCallback(
    (e) => {
      const index = Math.round(e.nativeEvent.contentOffset.x / stripWidth);
      const weekStart = weeks[index];
      if (!weekStart) return;
      // Keep the same weekday selected in the new week.
      const offset = (selected.getDay() + 6) % 7;
      setSelected(addDays(weekStart, offset));
    },
    [stripWidth, weeks, selected],
  );

  const openSheet = useCallback(
    async (item) => {
      setEditItem(item || null);
      setTitle(item ? item.title : quickTitle.trim());
      setDueDate(item ? item.dueDate || '' : selectedKey);
      setDueTime(item?.dueTime || '');
      setAssignee(item?.assignedTo?.id ?? null);
      setShowSheet(true);
      loadMembers();
    },
    [quickTitle, selectedKey, loadMembers],
  );

  const quickAdd = useCallback(async () => {
    const trimmed = quickTitle.trim();
    if (!trimmed) {
      openSheet(null);
      return;
    }
    setQuickSaving(true);
    try {
      await todoApi.create({ title: trimmed, dueDate: selectedKey });
      setQuickTitle('');
      await load();
    } catch (e) {
      showAlert('Error', e?.response?.data?.error || 'Could not add to-do');
    } finally {
      setQuickSaving(false);
    }
  }, [quickTitle, selectedKey, load, openSheet]);

  const save = useCallback(async () => {
    const trimmed = title.trim();
    if (!trimmed) {
      showAlert('Required', 'Give the to-do a name');
      return;
    }
    setSaving(true);
    try {
      if (editItem) {
        await todoApi.update(editItem.id, {
          title: trimmed,
          dueDate: dueDate || null,
          dueTime: dueTime || null,
          assignedTo: assignee || null,
        });
      } else {
        await todoApi.create({
          title: trimmed,
          dueDate: dueDate || undefined,
          dueTime: dueTime || undefined,
          assignedTo: assignee || undefined,
        });
        setQuickTitle('');
      }
      setShowSheet(false);
      await load();
    } catch (e) {
      const res = e?.response?.data;
      showAlert(
        'Error',
        `Could not ${editItem ? 'update' : 'add'} to-do\n${res?.error || res?.message || e?.message || ''}`,
      );
    } finally {
      setSaving(false);
    }
  }, [title, dueDate, dueTime, assignee, editItem, load]);

  const deleteNow = useCallback(async () => {
    const target = confirmDelete;
    setConfirmDelete(null);
    setShowSheet(false);
    if (!target) return;
    try {
      await todoApi.delete(target.id);
      await load();
    } catch {
      showAlert('Error', 'Could not delete');
    }
  }, [confirmDelete, load]);

  // ─── Render pieces ────────────────────────────────────────────────────

  const renderWeek = ({ item: weekStart }) => (
    <View style={[styles.week, { width: stripWidth }]}>
      {DAY_LABELS.map((label, i) => {
        const day = addDays(weekStart, i);
        const key = dayKey(day);
        const isSelected = key === selectedKey;
        return (
          <TouchableOpacity
            key={key}
            style={[styles.day, { width: dayWidth }, isSelected && styles.daySelected]}
            onPress={() => setSelected(day)}
            activeOpacity={0.7}
          >
            <Text style={[styles.dayLabel, isSelected && styles.dayTextSelected]}>{label}</Text>
            <Text style={[styles.dayNum, isSelected && styles.dayTextSelected]}>
              {format(day, 'd')}
            </Text>
            <View
              style={[
                styles.dayDot,
                busyDays.has(key) && (isSelected ? styles.dayDotOnGold : styles.dayDotOn),
              ]}
            />
          </TouchableOpacity>
        );
      })}
    </View>
  );

  const renderRow = ({ item, index }) => {
    const done = item.isCompleted;
    const toggleable = canToggle(item);
    const who = item.assignedTo?.displayName?.split(' ')[0] || 'Everyone';
    const isLast = index === dayItems.length - 1;
    return (
      <View style={styles.row}>
        <Text style={styles.time} numberOfLines={1}>
          {item.dueTime || 'Anytime'}
        </Text>
        <View style={styles.rail}>
          <View style={[styles.railLine, isLast && styles.railLineLast]} />
          <View style={[styles.node, done && styles.nodeDone]} />
        </View>
        <TouchableOpacity
          style={[styles.card, done && styles.cardDone]}
          onPress={() => openSheet(item)}
          onLongPress={canDelete(item) ? () => setConfirmDelete(item) : undefined}
          delayLongPress={400}
          activeOpacity={0.8}
        >
          <TouchableOpacity
            style={[styles.check, done && styles.checkDone, !toggleable && styles.checkDisabled]}
            onPress={toggleable ? () => toggle(item) : undefined}
            disabled={!toggleable}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            {done ? <Text style={styles.checkMark}>✓</Text> : null}
          </TouchableOpacity>
          <View style={styles.cardBody}>
            <Text style={[styles.cardTitle, done && styles.cardTitleDone]} numberOfLines={2}>
              {item.title}
            </Text>
            <Text style={styles.cardMeta} numberOfLines={1}>
              {who}
            </Text>
          </View>
        </TouchableOpacity>
      </View>
    );
  };

  // ─── Main ─────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <ActivityIndicator size="large" color={colors.gold} style={{ flex: 1 }} />
      </View>
    );
  }

  const dayLabel = format(selected, 'EEE d');
  const canAdd = user?.role !== 'child';

  return (
    <KeyboardAvoidingView
      style={[styles.container, { paddingTop: insets.top }]}
      behavior={KEYBOARD_BEHAVIOR}
    >
      <StatusBar barStyle="light-content" backgroundColor={colors.canvas} />

      {/* ── Header: back, "Month Year", N left ── */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => navigation.goBack()}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Text style={styles.backIcon}>‹</Text>
        </TouchableOpacity>
        <Text style={styles.month} numberOfLines={1}>
          {format(selected, 'MMMM')}
          <Text style={styles.year}> {format(selected, 'yyyy')}</Text>
        </Text>
        <View style={styles.leftPill}>
          <Text style={styles.leftPillText}>{leftCount} left</Text>
        </View>
      </View>

      {/* ── Week strip — swipe for other weeks ── */}
      <FlatList
        data={weeks}
        keyExtractor={(w) => dayKey(w)}
        renderItem={renderWeek}
        extraData={`${selectedKey}|${busyDays.size}|${items.length}`}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        initialScrollIndex={WEEKS_EACH_SIDE}
        getItemLayout={(_, i) => ({ length: stripWidth, offset: stripWidth * i, index: i })}
        onMomentumScrollEnd={onWeekSettled}
        style={[styles.weekList, { width: stripWidth }]}
        initialNumToRender={3}
        windowSize={3}
      />
      <View style={styles.divider} />

      {/* ── Timeline for the selected day ── */}
      <FlatList
        data={dayItems}
        keyExtractor={(i) => i.id}
        renderItem={renderRow}
        style={styles.timeline}
        contentContainerStyle={
          dayItems.length === 0 ? styles.emptyWrap : styles.timelineContent
        }
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              load();
            }}
            tintColor={colors.gold}
            colors={[colors.gold]}
          />
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>Nothing planned for {dayLabel}</Text>
            {canAdd ? <Text style={styles.emptySub}>Add a task below</Text> : null}
          </View>
        }
        showsVerticalScrollIndicator={false}
      />

      {/* ── Add bar ── */}
      {canAdd ? (
        <View style={[styles.addBar, { marginBottom: dockHeight + 12 }]}>
          <TextInput
            style={styles.addInput}
            placeholder={`Add a task for ${dayLabel}…`}
            placeholderTextColor={colors.textMuted}
            value={quickTitle}
            onChangeText={setQuickTitle}
            onSubmitEditing={quickAdd}
            returnKeyType="done"
            maxLength={200}
          />
          <TouchableOpacity
            style={styles.addBtn}
            onPress={quickAdd}
            disabled={quickSaving}
            activeOpacity={0.85}
          >
            <GoldFill radius={12} disabled={quickSaving} />
            {quickSaving ? (
              <ActivityIndicator size="small" color={colors.canvas} />
            ) : (
              <Text style={styles.addBtnText}>+</Text>
            )}
          </TouchableOpacity>
        </View>
      ) : (
        <View style={{ height: dockHeight }} />
      )}

      {/* ── Add / edit sheet ── */}
      <BottomSheet visible={showSheet} onClose={() => setShowSheet(false)}>
        <View style={sheet.handle} />
        <Text style={sheet.title}>{editItem ? 'Edit to-do' : 'Add to-do'}</Text>
        <ScrollView
          style={sheet.scroll}
          showsVerticalScrollIndicator={false}
          {...keyboardScrollProps}
        >
          <Field label="To-do">
            <TextInput
              style={[styles.input, styles.inputFocused]}
              placeholder="Call the plumber"
              placeholderTextColor={colors.textMuted}
              value={title}
              onChangeText={setTitle}
              maxLength={200}
            />
          </Field>

          <Field label="Day">
            <View style={styles.chipRow}>
              {[
                ['Today', todayKey],
                ['Tomorrow', dayKey(addDays(today, 1))],
              ].map(([label, key]) => (
                <Chip
                  key={label}
                  label={label}
                  active={dueDate === key}
                  onPress={() => setDueDate(dueDate === key ? '' : key)}
                />
              ))}
              <Chip label="Pick a date" dashed onPress={() => setShowDatePicker(true)} />
            </View>
            <Text style={styles.chosen}>
              {dueDate ? format(new Date(`${dueDate}T00:00:00`), 'EEE, MMM d') : 'No day — shows on today'}
            </Text>
            {showDatePicker && (
              <DateTimePicker
                value={dueDate ? new Date(`${dueDate}T00:00:00`) : new Date()}
                mode="date"
                display={Platform.OS === 'ios' ? 'spinner' : 'default'}
                onChange={(_e, date) => {
                  setShowDatePicker(false);
                  if (date) setDueDate(dayKey(date));
                }}
              />
            )}
          </Field>

          <Field label="Time">
            <View style={styles.chipRow}>
              <Chip label="Anytime" active={!dueTime} onPress={() => setDueTime('')} />
              <Chip
                label={dueTime || 'Pick a time'}
                active={!!dueTime}
                dashed={!dueTime}
                onPress={() => setShowTimePicker(true)}
              />
            </View>
            {showTimePicker && (
              <DateTimePicker
                value={dueTime ? new Date(`2000-01-01T${dueTime}:00`) : new Date()}
                mode="time"
                is24Hour
                display={Platform.OS === 'ios' ? 'spinner' : 'default'}
                onChange={(_e, date) => {
                  setShowTimePicker(false);
                  if (date) setDueTime(format(date, 'HH:mm'));
                }}
              />
            )}
          </Field>

          <Field label="Assignee">
            <TouchableOpacity
              style={styles.input}
              onPress={() => setShowAssigneeSheet(true)}
              activeOpacity={0.7}
            >
              <Text style={assignee ? styles.inputValue : styles.inputPlaceholder}>
                {assignee
                  ? members.find((m) => m.userId === assignee)?.displayName ||
                    editItem?.assignedTo?.displayName ||
                    ''
                  : 'Everyone'}
              </Text>
            </TouchableOpacity>
          </Field>

          <TouchableOpacity
            style={[styles.saveBtn, saving && styles.saveBtnDisabled]}
            onPress={save}
            disabled={saving}
            activeOpacity={0.85}
          >
            <GoldFill radius={radius.pill} disabled={saving} />
            {saving ? (
              <ActivityIndicator size="small" color={colors.onAccent} />
            ) : (
              <Text style={styles.saveBtnText}>{editItem ? 'Save changes' : 'Add to-do'}</Text>
            )}
          </TouchableOpacity>
          {editItem && canDelete(editItem) ? (
            <TouchableOpacity
              style={styles.removeLink}
              onPress={() => setConfirmDelete(editItem)}
              activeOpacity={0.6}
            >
              <Text style={styles.removeLinkText}>Delete to-do</Text>
            </TouchableOpacity>
          ) : null}
        </ScrollView>
      </BottomSheet>

      <AssigneePickerSheet
        visible={showAssigneeSheet}
        members={members}
        selectedId={assignee}
        onSelect={setAssignee}
        onClose={() => setShowAssigneeSheet(false)}
      />

      <ConfirmSheet
        visible={!!confirmDelete}
        title={confirmDelete ? `Delete "${confirmDelete.title}"?` : ''}
        subtitle="This to-do will be permanently deleted."
        confirmLabel="Delete"
        onConfirm={deleteNow}
        onCancel={() => setConfirmDelete(null)}
      />
    </KeyboardAvoidingView>
  );
}

function Chip({ label, active, dashed, onPress }) {
  return (
    <TouchableOpacity
      style={[styles.chip, dashed && styles.chipDashed, active && styles.chipActive]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

const TIME_COL = 56;
const RAIL_COL = 26;
const NODE = 10;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.canvas,
  },
  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: SCREEN_GUTTER,
    paddingTop: 8,
    paddingBottom: 12,
  },
  backBtn: {
    width: 24,
    height: 32,
    justifyContent: 'center',
  },
  backIcon: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.ink,
    lineHeight: 22,
  },
  month: {
    flex: 1,
    fontSize: 18,
    fontFamily: fonts.displayBold,
    fontWeight: '700',
    color: colors.ink,
  },
  year: {
    fontFamily: fonts.body,
    fontWeight: '400',
    color: colors.textSecondary,
  },
  leftPill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 10,
    backgroundColor: colors.surface,
  },
  leftPillText: {
    fontSize: 12,
    fontFamily: fonts.bodyBold,
    fontWeight: '700',
    color: colors.gold,
    fontVariant: ['tabular-nums'],
  },
  // Week strip
  weekList: {
    flexGrow: 0,
    alignSelf: 'center',
  },
  week: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  day: {
    alignItems: 'center',
    paddingTop: 8,
    paddingBottom: 6,
    borderRadius: 12,
    gap: 4,
  },
  daySelected: {
    backgroundColor: colors.gold,
  },
  dayLabel: {
    fontSize: 11,
    fontFamily: fonts.body,
    color: colors.textSecondary,
  },
  dayNum: {
    fontSize: 15,
    fontFamily: fonts.displayBold,
    fontWeight: '700',
    color: colors.ink,
    fontVariant: ['tabular-nums'],
  },
  dayTextSelected: {
    color: colors.canvas,
  },
  dayDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: 'transparent',
  },
  dayDotOn: {
    backgroundColor: colors.gold,
  },
  dayDotOnGold: {
    backgroundColor: colors.canvas,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.divider,
    marginTop: 12,
  },
  // Timeline
  timeline: {
    flex: 1,
  },
  timelineContent: {
    paddingHorizontal: SCREEN_GUTTER,
    paddingTop: 18,
    paddingBottom: 18,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  time: {
    width: TIME_COL,
    paddingTop: 13,
    fontSize: 11,
    fontFamily: fonts.body,
    color: colors.textSecondary,
    fontVariant: ['tabular-nums'],
  },
  rail: {
    width: RAIL_COL,
    alignSelf: 'stretch',
    alignItems: 'center',
  },
  railLine: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 1,
    backgroundColor: colors.border,
  },
  railLineLast: {
    bottom: '40%',
  },
  node: {
    marginTop: 15,
    width: NODE,
    height: NODE,
    borderRadius: NODE / 2,
    borderWidth: 1.5,
    borderColor: colors.textMuted,
    backgroundColor: colors.canvas,
  },
  nodeDone: {
    borderColor: colors.inkMuted,
    backgroundColor: colors.inkMuted,
  },
  card: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    padding: 14,
    marginBottom: 14,
    borderRadius: 14,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.borderCool,
  },
  cardDone: {
    backgroundColor: colors.surface,
  },
  check: {
    width: 20,
    height: 20,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: colors.textMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkDone: {
    backgroundColor: colors.gold,
    borderColor: colors.gold,
  },
  checkDisabled: {
    opacity: 0.35,
  },
  checkMark: {
    fontSize: 11,
    fontWeight: '900',
    color: colors.canvas,
    lineHeight: 13,
  },
  cardBody: {
    flex: 1,
    gap: 4,
  },
  cardTitle: {
    fontSize: 14,
    fontFamily: fonts.bodyBold,
    fontWeight: '700',
    color: colors.ink,
    lineHeight: 19,
  },
  cardTitleDone: {
    textDecorationLine: 'line-through',
    color: colors.textMuted,
  },
  cardMeta: {
    fontSize: 11,
    fontFamily: fonts.body,
    color: colors.textSecondary,
  },
  // Empty day
  emptyWrap: {
    flexGrow: 1,
    justifyContent: 'center',
  },
  empty: {
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: SCREEN_GUTTER,
  },
  emptyTitle: {
    fontSize: 14,
    fontFamily: fonts.bodySemiBold,
    color: colors.ink,
  },
  emptySub: {
    fontSize: 12,
    fontFamily: fonts.body,
    color: colors.textMuted,
  },
  // Add bar
  addBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginHorizontal: SCREEN_GUTTER,
    paddingLeft: 18,
    paddingRight: 8,
    paddingVertical: 8,
    borderRadius: 18,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.borderCool,
  },
  addInput: {
    flex: 1,
    fontSize: 13,
    fontFamily: fonts.body,
    color: colors.ink,
    paddingVertical: 10,
  },
  addBtn: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: colors.gold,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    ...goldButton.glow,
  },
  addBtnText: {
    fontSize: 22,
    fontWeight: '500',
    color: colors.canvas,
    lineHeight: 24,
  },
  // Sheet form
  input: {
    height: 52,
    borderRadius: radius.card,
    backgroundColor: colors.canvas,
    borderWidth: 1.5,
    borderColor: colors.border,
    paddingHorizontal: 16,
    fontSize: 14,
    fontFamily: fonts.body,
    color: colors.ink,
    justifyContent: 'center',
  },
  inputFocused: {
    borderWidth: 2,
    borderColor: colors.gold,
  },
  inputValue: {
    fontSize: 14,
    fontFamily: fonts.bodyMedium,
    color: colors.ink,
  },
  inputPlaceholder: {
    fontSize: 14,
    fontFamily: fonts.body,
    color: colors.textMuted,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  chip: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipDashed: {
    borderStyle: 'dashed',
    backgroundColor: 'transparent',
  },
  chipActive: {
    borderStyle: 'solid',
    borderColor: colors.gold,
    backgroundColor: colors.goldLight,
  },
  chipText: {
    fontSize: 13,
    fontWeight: '600',
    fontFamily: fonts.bodySemiBold,
    color: colors.textSecondary,
  },
  chipTextActive: {
    color: colors.canvas,
  },
  chosen: {
    marginTop: 8,
    fontSize: 13,
    fontFamily: fonts.bodySemiBold,
    color: colors.goldDeep,
  },
  saveBtn: {
    height: 54,
    borderRadius: radius.pill,
    backgroundColor: colors.gold,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 8,
    ...goldButton.glow,
  },
  saveBtnDisabled: {
    opacity: 0.5,
  },
  saveBtnText: {
    fontSize: 15,
    fontWeight: '600',
    fontFamily: fonts.displayBold,
    color: colors.onAccent,
  },
  removeLink: {
    alignItems: 'center',
    paddingVertical: 12,
    marginTop: 4,
  },
  removeLinkText: {
    fontSize: 13,
    fontWeight: '500',
    fontFamily: fonts.bodyMedium,
    color: colors.danger,
  },
});
