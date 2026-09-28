import React, { useState, useCallback, useMemo, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  KeyboardAvoidingView,
  StatusBar,
  Modal,
  FlatList,
} from 'react-native';
import { showAlert } from '../shared/services/themedAlert';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { taskApi } from '../shared/api/task';
import { useAuthStore } from '../shared/store/authStore';
import { householdApi } from '../shared/api/household';
import { colors, fonts, goldButton, radius, withAlpha } from '../shared/theme';
import { GoldFill } from '../shared/components/GoldButton';
import Avatar from '../components/Avatar';
import { KEYBOARD_BEHAVIOR } from '../shared/components/KeyboardAware';
const POINTS_OPTIONS = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50];
// Legacy tasks may have a points value that predates the multiples-of-5
// picker — snap it to the closest option so editing always shows a value
// the dropdown can actually select.
function nearestPointsOption(n) {
  const num = Number(n);
  if (!Number.isFinite(num) || num <= 0) return POINTS_OPTIONS[0];
  return POINTS_OPTIONS.reduce((closest, opt) =>
    Math.abs(opt - num) < Math.abs(closest - num) ? opt : closest,
  );
}
const RECURRENCE_OPTIONS = [
  {
    label: 'None',
    value: 'none',
  },
  {
    label: 'Daily',
    value: 'daily',
  },
  {
    label: 'Weekly',
    value: 'weekly',
  },
  {
    label: 'Biweekly',
    value: 'biweekly',
  },
  {
    label: 'Monthly',
    value: 'monthly',
  },
];
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const DAY_LABELS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
function toISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function displayDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

// ─────────────────────────────────────────────
// Shared bottom-sheet picker shell
// ─────────────────────────────────────────────
function Sheet({ visible, title, onClose, insets, children }) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <TouchableOpacity style={sheet.overlay} activeOpacity={1} onPress={onClose} />
      <View
        style={[
          sheet.box,
          {
            paddingBottom: insets.bottom + 12,
          },
        ]}
      >
        <View style={sheet.header}>
          <TouchableOpacity
            onPress={onClose}
            hitSlop={{
              top: 8,
              bottom: 8,
              left: 8,
              right: 8,
            }}
          >
            <Text style={sheet.closeText}>Close</Text>
          </TouchableOpacity>
          <Text style={sheet.title}>{title}</Text>
          <View
            style={{
              minWidth: 44,
            }}
          />
        </View>
        {children}
      </View>
    </Modal>
  );
}

// ─────────────────────────────────────────────
// Calendar picker
// ─────────────────────────────────────────────
function CalendarPicker({ visible, selectedISO, onSelect, onClose, insets }) {
  const today = useMemo(() => {
    const t = new Date();
    t.setHours(0, 0, 0, 0);
    return t;
  }, []);
  const [cursor, setCursor] = useState(() => {
    if (selectedISO) {
      const d = new Date(selectedISO + 'T00:00:00');
      return {
        year: d.getFullYear(),
        month: d.getMonth(),
      };
    }
    return {
      year: today.getFullYear(),
      month: today.getMonth(),
    };
  });
  const selectedDate = selectedISO ? new Date(selectedISO + 'T00:00:00') : null;
  const grid = useMemo(() => {
    const firstDay = new Date(cursor.year, cursor.month, 1).getDay();
    const daysInMonth = new Date(cursor.year, cursor.month + 1, 0).getDate();
    const cells = Array(firstDay).fill(null);
    for (let d = 1; d <= daysInMonth; d++) cells.push(d);
    while (cells.length % 7 !== 0) cells.push(null);
    return cells;
  }, [cursor]);
  const prevMonth = () =>
    setCursor(({ year, month }) =>
      month === 0
        ? {
            year: year - 1,
            month: 11,
          }
        : {
            year,
            month: month - 1,
          },
    );
  const nextMonth = () =>
    setCursor(({ year, month }) =>
      month === 11
        ? {
            year: year + 1,
            month: 0,
          }
        : {
            year,
            month: month + 1,
          },
    );
  const handleDay = (day) => {
    onSelect(toISODate(new Date(cursor.year, cursor.month, day)));
    onClose();
  };
  const isPast = (day) => {
    const d = new Date(cursor.year, cursor.month, day);
    d.setHours(0, 0, 0, 0);
    return d < today;
  };
  const isSelected = (day) =>
    !!selectedDate &&
    selectedDate.getFullYear() === cursor.year &&
    selectedDate.getMonth() === cursor.month &&
    selectedDate.getDate() === day;
  const isToday = (day) =>
    today.getFullYear() === cursor.year &&
    today.getMonth() === cursor.month &&
    today.getDate() === day;
  return (
    <Sheet visible={visible} title="Pick a date" onClose={onClose} insets={insets}>
      <View style={cal.monthNav}>
        <TouchableOpacity style={cal.navBtn} onPress={prevMonth} hitSlop={8}>
          <Text style={cal.navArrow}>‹</Text>
        </TouchableOpacity>
        <Text style={cal.monthLabel}>
          {MONTH_NAMES[cursor.month]} {cursor.year}
        </Text>
        <TouchableOpacity style={cal.navBtn} onPress={nextMonth} hitSlop={8}>
          <Text style={cal.navArrow}>›</Text>
        </TouchableOpacity>
      </View>

      <View style={cal.dayLabels}>
        {DAY_LABELS.map((d) => (
          <Text key={d} style={cal.dayLabel}>
            {d}
          </Text>
        ))}
      </View>

      <View style={cal.grid}>
        {grid.map((day, i) => {
          if (day === null) return <View key={`e-${i}`} style={cal.cell} />;
          const past = isPast(day);
          const selected = isSelected(day);
          const todayCell = isToday(day);
          return (
            <TouchableOpacity
              key={`d-${day}`}
              style={[cal.cell, todayCell && cal.todayCell, selected && cal.selectedCell]}
              onPress={() => !past && handleDay(day)}
              activeOpacity={past ? 1 : 0.7}
              disabled={past}
            >
              <Text
                style={[
                  cal.cellText,
                  todayCell && cal.todayCellText,
                  selected && cal.selectedCellText,
                  past && cal.pastCellText,
                ]}
              >
                {day}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </Sheet>
  );
}

// ─────────────────────────────────────────────
// Recurrence picker
// ─────────────────────────────────────────────
function RecurrencePicker({ visible, value, onSelect, onClose, insets }) {
  return (
    <Sheet visible={visible} title="Repeats" onClose={onClose} insets={insets}>
      {RECURRENCE_OPTIONS.map((opt) => {
        const active = value === opt.value;
        return (
          <TouchableOpacity
            key={opt.value}
            style={styles.pickRow}
            onPress={() => {
              onSelect(opt.value);
              onClose();
            }}
            activeOpacity={0.7}
          >
            <Text style={[styles.pickRowText, active && styles.pickRowTextActive]}>
              {opt.label}
            </Text>
            {active && <Text style={styles.pickRowCheck}>✓</Text>}
          </TouchableOpacity>
        );
      })}
    </Sheet>
  );
}

// ─────────────────────────────────────────────
// Points picker — multiples of 5
// ─────────────────────────────────────────────
function PointsPicker({ visible, value, onSelect, onClose, insets }) {
  return (
    <Sheet visible={visible} title="Points" onClose={onClose} insets={insets}>
      {POINTS_OPTIONS.map((opt) => {
        const active = Number(value) === opt;
        return (
          <TouchableOpacity
            key={opt}
            style={styles.pickRow}
            onPress={() => {
              onSelect(opt);
              onClose();
            }}
            activeOpacity={0.7}
          >
            <Text style={[styles.pickRowText, active && styles.pickRowTextActive]}>{opt} pts</Text>
            {active && <Text style={styles.pickRowCheck}>✓</Text>}
          </TouchableOpacity>
        );
      })}
    </Sheet>
  );
}

// ─────────────────────────────────────────────
// Main screen — Add Task bottom sheet (SCREEN 17)
// ─────────────────────────────────────────────
export default function CreateTaskScreen({ route, navigation }) {
  const taskId = route.params?.taskId;
  const isEditing = !!taskId;
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [points, setPoints] = useState('5');
  const [recurrence, setRecurrence] = useState('none');
  const [posting, setPosting] = useState(false);
  const [members, setMembers] = useState([]);
  const [selectedAssignees, setSelectedAssignees] = useState([]);
  const [showCalendar, setShowCalendar] = useState(false);
  const [showAssigneePicker, setShowAssigneePicker] = useState(false);
  const [showRecurrence, setShowRecurrence] = useState(false);
  const [showPoints, setShowPoints] = useState(false);
  const insets = useSafeAreaInsets();
  const householdId = useAuthStore((s) => s.householdId);
  const userId = useAuthStore((s) => s.user?.id);
  const canPost = title.trim().length > 0 && !posting;
  const isSelfOnly = selectedAssignees.length === 1 && selectedAssignees[0] === userId;
  useEffect(() => {
    if (isSelfOnly) setPoints('5');
  }, [isSelfOnly]);
  useEffect(() => {
    if (householdId) {
      householdApi
        .getMembers(householdId)
        .then(setMembers)
        .catch(() => {});
    }
  }, [householdId]);
  useEffect(() => {
    if (!taskId) return;
    (async () => {
      try {
        const task = await taskApi.getById(taskId);
        setTitle(task.title);
        setDescription(task.description || '');
        setDueDate(task.dueDate || '');
        setPoints(String(nearestPointsOption(task.points ?? 5)));
        setRecurrence(task.recurrence);
        setSelectedAssignees(task.assignees.map((a) => a.id));
      } catch {
        showAlert('Error', 'Could not load task');
        navigation.goBack();
      }
    })();
  }, [taskId, navigation]);
  const handleCreate = useCallback(async () => {
    if (!title.trim()) return;
    setPosting(true);
    try {
      const parsedPoints = points ? parseInt(points, 10) : 1;
      const payload = {
        title: title.trim(),
        description: description.trim() || undefined,
        dueDate: dueDate || undefined,
        recurrence,
        assigneeIds: selectedAssignees.length > 0 ? selectedAssignees : undefined,
        points: Number.isFinite(parsedPoints) ? parsedPoints : 1,
      };
      if (isEditing && taskId) {
        await taskApi.update(taskId, payload);
      } else {
        await taskApi.create(payload);
      }
      navigation.goBack();
    } catch (e) {
      showAlert('Error', e?.message || 'Failed to save task');
    } finally {
      setPosting(false);
    }
  }, [
    title,
    description,
    dueDate,
    recurrence,
    points,
    selectedAssignees,
    isEditing,
    taskId,
    navigation,
  ]);
  const assigneeLabel =
    selectedAssignees.length > 0 ? `${selectedAssignees.length} selected` : 'Select';
  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={KEYBOARD_BEHAVIOR}
    >
      <StatusBar barStyle="light-content" backgroundColor="transparent" />
      <TouchableOpacity
        style={styles.backdrop}
        activeOpacity={1}
        onPress={() => navigation.goBack()}
      />

      <View style={styles.sheet}>
        <View style={styles.handle} />
        <Text style={styles.sheetTitle}>{isEditing ? 'Edit task' : 'Add task'}</Text>

        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.form}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Title */}
          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>Title</Text>
            <TextInput
              style={[styles.fieldInput, styles.fieldInputFocused]}
              value={title}
              onChangeText={setTitle}
              placeholder="Take out recycling"
              placeholderTextColor={colors.textMuted}
              maxLength={200}
              autoFocus
              returnKeyType="next"
            />
          </View>

          {/* Description */}
          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>Description</Text>
            <TextInput
              style={[styles.fieldInput, styles.fieldInputMulti]}
              value={description}
              onChangeText={setDescription}
              placeholder="Add details (optional)"
              placeholderTextColor={colors.textMuted}
              multiline
              maxLength={5000}
              textAlignVertical="top"
            />
          </View>

          {/* Due date | Assignee */}
          <View style={styles.row}>
            <View style={styles.fieldGroup}>
              <Text style={styles.fieldLabel}>Due date</Text>
              <TouchableOpacity
                style={styles.fieldInput}
                onPress={() => setShowCalendar(true)}
                activeOpacity={0.7}
              >
                <Text style={dueDate ? styles.fieldValue : styles.fieldPlaceholder}>
                  {dueDate ? displayDate(dueDate) : 'Select'}
                </Text>
              </TouchableOpacity>
            </View>

            <View style={styles.fieldGroup}>
              <Text style={styles.fieldLabel}>Assignee</Text>
              <TouchableOpacity
                style={styles.fieldInput}
                onPress={() => setShowAssigneePicker(true)}
                activeOpacity={0.7}
              >
                <Text
                  style={selectedAssignees.length ? styles.fieldValue : styles.fieldPlaceholder}
                >
                  {assigneeLabel}
                </Text>
              </TouchableOpacity>
            </View>
          </View>

          {/* Points | Repeats */}
          <View style={styles.row}>
            <View style={styles.fieldGroup}>
              <Text style={styles.fieldLabel}>Points</Text>
              <TouchableOpacity
                style={[styles.fieldInput, isSelfOnly && styles.fieldInputDisabled]}
                onPress={() => !isSelfOnly && setShowPoints(true)}
                activeOpacity={0.7}
                disabled={isSelfOnly}
              >
                <Text style={points ? styles.fieldValue : styles.fieldPlaceholder}>
                  {points ? `${points} pts` : 'Select'}
                </Text>
              </TouchableOpacity>
              {isSelfOnly && (
                <Text style={styles.fieldHelper}>
                  Points aren't awarded for tasks assigned only to yourself.
                </Text>
              )}
            </View>

            <View style={styles.fieldGroup}>
              <Text style={styles.fieldLabel}>Repeats</Text>
              <TouchableOpacity
                style={styles.fieldInput}
                onPress={() => setShowRecurrence(true)}
                activeOpacity={0.7}
              >
                <Text style={styles.fieldValue}>
                  {RECURRENCE_OPTIONS.find((r) => r.value === recurrence)?.label}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </ScrollView>

        {/* Submit */}
        <TouchableOpacity
          style={[styles.submitBtn, !canPost && styles.submitBtnDisabled]}
          onPress={handleCreate}
          disabled={!canPost}
          activeOpacity={0.85}
        >
          <GoldFill radius={radius.pill} disabled={!canPost} />
          {posting ? (
            <ActivityIndicator size="small" color={colors.onAccent} />
          ) : (
            <Text style={styles.submitBtnText}>{isEditing ? 'Save' : 'Add task'}</Text>
          )}
        </TouchableOpacity>
      </View>

      {/* Pickers */}
      <CalendarPicker
        visible={showCalendar}
        selectedISO={dueDate}
        onSelect={setDueDate}
        onClose={() => setShowCalendar(false)}
        insets={insets}
      />

      <RecurrencePicker
        visible={showRecurrence}
        value={recurrence}
        onSelect={setRecurrence}
        onClose={() => setShowRecurrence(false)}
        insets={insets}
      />

      <PointsPicker
        visible={showPoints}
        value={points}
        onSelect={(opt) => setPoints(String(opt))}
        onClose={() => setShowPoints(false)}
        insets={insets}
      />

      {/* Assignee picker */}
      <Sheet
        visible={showAssigneePicker}
        title="Assign to"
        onClose={() => setShowAssigneePicker(false)}
        insets={insets}
      >
        {members.length === 0 ? (
          <View style={styles.pickEmpty}>
            <Text style={styles.pickEmptyText}>No members found</Text>
          </View>
        ) : (
          <FlatList
            data={members}
            keyExtractor={(item) => item.userId}
            renderItem={({ item }) => {
              const sel = selectedAssignees.includes(item.userId);
              return (
                <TouchableOpacity
                  style={[styles.pickRow, sel && styles.pickRowActive]}
                  onPress={() =>
                    setSelectedAssignees((prev) =>
                      prev.includes(item.userId)
                        ? prev.filter((id) => id !== item.userId)
                        : [...prev, item.userId],
                    )
                  }
                  activeOpacity={0.7}
                >
                  <View style={styles.pickAvatar}>
                    <Avatar
                      url={item.avatarUrl}
                      emoji={item.avatarEmoji}
                      name={item.displayName}
                      id={item.userId}
                      size={40}
                    />
                  </View>
                  <View style={styles.pickInfo}>
                    <Text style={styles.pickName}>{item.displayName}</Text>
                    <Text style={styles.pickRole}>{item.role}</Text>
                  </View>
                  <View style={[styles.pickCheck, sel && styles.pickCheckOn]}>
                    {sel && <Text style={styles.pickCheckMark}>✓</Text>}
                  </View>
                </TouchableOpacity>
              );
            }}
          />
        )}
      </Sheet>
    </KeyboardAvoidingView>
  );
}

// ── Sheet picker shell styles ──
const sheet = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: withAlpha(colors.shadow, 0.55),
  },
  box: {
    backgroundColor: colors.canvasElevated,
    borderTopLeftRadius: 32,
    borderTopRightRadius: 32,
    borderWidth: 1,
    borderColor: colors.border,
    borderBottomWidth: 0,
    paddingTop: 6,
    maxHeight: '75%',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 24,
    paddingVertical: 14,
  },
  closeText: {
    fontSize: 15,
    fontWeight: '500',
    fontFamily: fonts.bodyMedium,
    color: colors.goldDeep,
    minWidth: 44,
  },
  title: {
    fontSize: 16,
    fontWeight: '600',
    fontFamily: fonts.displayBold,
    color: colors.ink,
  },
});

// ── Calendar styles ──
const cal = StyleSheet.create({
  monthNav: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 24,
    paddingVertical: 12,
  },
  navBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.surfaceWarm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  navArrow: {
    fontSize: 22,
    fontWeight: '600',
    color: colors.ink,
    lineHeight: 26,
  },
  monthLabel: {
    fontSize: 17,
    fontWeight: '700',
    fontFamily: fonts.displayBold,
    color: colors.ink,
  },
  dayLabels: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    marginBottom: 4,
  },
  dayLabel: {
    flex: 1,
    textAlign: 'center',
    fontSize: 12,
    fontWeight: '700',
    color: colors.textMuted,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  cell: {
    width: `${100 / 7}%`,
    aspectRatio: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cellText: {
    fontSize: 15,
    fontWeight: '500',
    fontFamily: fonts.bodyMedium,
    color: colors.ink,
  },
  todayCell: {
    borderWidth: 1.5,
    borderColor: colors.gold,
    borderRadius: 20,
  },
  todayCellText: {
    color: colors.gold,
    fontWeight: '700',
  },
  selectedCell: {
    backgroundColor: colors.gold,
    borderRadius: 20,
    borderWidth: 0,
  },
  selectedCellText: {
    color: colors.onAccent,
    fontWeight: '800',
  },
  pastCellText: {
    color: colors.textFaint,
  },
});

// ── Main screen styles ──
const styles = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'transparent',
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: withAlpha(colors.shadow, 0.55),
  },
  sheet: {
    backgroundColor: colors.canvasElevated,
    borderTopLeftRadius: 32,
    borderTopRightRadius: 32,
    borderWidth: 1,
    borderColor: colors.border,
    borderBottomWidth: 0,
    paddingTop: 14,
    paddingHorizontal: 24,
    paddingBottom: 120,
    marginBottom: -60,
    shadowColor: colors.shadow,
    shadowOffset: {
      width: 0,
      height: -8,
    },
    shadowOpacity: 0.14,
    shadowRadius: 40,
    elevation: 16,
    height: '85%',
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
    alignSelf: 'center',
    marginBottom: 22,
  },
  sheetTitle: {
    fontSize: 18,
    fontWeight: '600',
    fontFamily: fonts.displayBold,
    color: colors.ink,
    textAlign: 'center',
    marginBottom: 22,
  },
  scroll: {
    flex: 1,
  },
  form: {
    gap: 14,
    paddingBottom: 16,
  },
  row: {
    flexDirection: 'row',
    gap: 12,
  },
  fieldGroup: {
    flex: 1,
  },
  fieldLabel: {
    fontSize: 11,
    fontWeight: '600',
    fontFamily: fonts.bodySemiBold,
    letterSpacing: 0.4,
    color: colors.textSecondary,
    marginBottom: 7,
  },
  fieldInput: {
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
  fieldInputFocused: {
    borderWidth: 2,
    borderColor: colors.gold,
  },
  fieldInputMulti: {
    height: 68,
    paddingTop: 14,
    paddingBottom: 14,
    textAlignVertical: 'top',
  },
  fieldInputDisabled: {
    opacity: 0.5,
  },
  fieldHelper: {
    fontSize: 11,
    fontFamily: fonts.body,
    color: colors.textMuted,
    marginTop: 6,
  },
  fieldValue: {
    fontSize: 14,
    fontFamily: fonts.bodyMedium,
    color: colors.ink,
  },
  fieldPlaceholder: {
    fontSize: 14,
    fontFamily: fonts.body,
    color: colors.textMuted,
  },
  submitBtn: {
    height: 54,
    borderRadius: radius.pill,
    backgroundColor: colors.gold,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 20,
    ...goldButton.glow,
  },
  submitBtnDisabled: {
    opacity: 0.5,
  },
  submitBtnText: {
    fontSize: 15,
    fontWeight: '600',
    fontFamily: fonts.displayBold,
    color: colors.onAccent,
  },
  // Picker rows (assignee + recurrence)
  pickRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 24,
    gap: 12,
  },
  pickRowActive: {
    backgroundColor: colors.goldTint,
  },
  pickRowText: {
    flex: 1,
    fontSize: 15,
    fontWeight: '500',
    fontFamily: fonts.bodyMedium,
    color: colors.ink,
  },
  pickRowTextActive: {
    fontWeight: '600',
    fontFamily: fonts.bodySemiBold,
    color: colors.goldDeep,
  },
  pickRowCheck: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.goldDeep,
  },
  pickEmpty: {
    padding: 32,
    alignItems: 'center',
  },
  pickEmptyText: {
    fontSize: 14,
    color: colors.textSecondary,
  },
  pickAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.surfaceWarm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pickInfo: {
    flex: 1,
  },
  pickName: {
    fontSize: 15,
    fontWeight: '600',
    fontFamily: fonts.bodySemiBold,
    color: colors.ink,
  },
  pickRole: {
    fontSize: 12,
    fontWeight: '500',
    color: colors.textMuted,
    marginTop: 2,
    textTransform: 'capitalize',
  },
  pickCheck: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 2,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  pickCheckOn: {
    backgroundColor: colors.gold,
    borderColor: colors.gold,
  },
  pickCheckMark: {
    fontSize: 13,
    fontWeight: '800',
    color: colors.onAccent,
  },
});
