import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  Modal,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
} from 'react-native';
import { colors, fonts, goldButton, withAlpha } from '../theme';
import { GoldFill } from './GoldButton';

// ─── Constants ───────────────────────────────────────────────────────────────

const ITEM_HEIGHT = 44;
const VISIBLE_ITEMS = 5;
const PICKER_HEIGHT = ITEM_HEIGHT * VISIBLE_ITEMS; // 220
const CENTER_OFFSET = ITEM_HEIGHT * 2;             // y=88 (top of selection strip)
const STRIP_BOTTOM = ITEM_HEIGHT * 3;              // y=132 (bottom of selection strip)

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Days in a given month/year (1-indexed month). */
function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

/** Clamp day to valid range for a given month/year. */
function clampDay(day, year, month) {
  const max = daysInMonth(year, month);
  return Math.min(Math.max(1, day), max);
}

/** Format a date as "20 July 2005". */
function formatDate(day, monthIndex, year) {
  return `${day} ${MONTH_NAMES[monthIndex]} ${year}`;
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function DatePickerModal({
  visible,
  value,
  minimumDate,
  maximumDate,
  onConfirm,
  onCancel,
}) {
  // Build year list: newest first (scroll down → go further back)
  const minYear = minimumDate.getFullYear();
  const maxYear = maximumDate.getFullYear();
  const years = Array.from(
    { length: maxYear - minYear + 1 },
    (_, i) => maxYear - i,
  );

  // ── Internal state ──────────────────────────────────────────────────────────
  const initialDay = value.getDate();
  const initialMonth = value.getMonth(); // 0-11
  const initialYear = value.getFullYear();

  const [selectedDay, setSelectedDay] = useState(initialDay);
  const [selectedMonth, setSelectedMonth] = useState(initialMonth);
  const [selectedYear, setSelectedYear] = useState(initialYear);

  // Derived day list for the current month/year
  const totalDays = daysInMonth(selectedYear, selectedMonth + 1);
  const days = Array.from({ length: totalDays }, (_, i) => i + 1);

  // Year index into `years` array
  const yearIndex = years.indexOf(selectedYear);

  // ── ScrollView refs ─────────────────────────────────────────────────────────
  const dayRef = useRef(null);
  const monthRef = useRef(null);
  const yearRef = useRef(null);

  // ── Scroll to position ──────────────────────────────────────────────────────
  const scrollToIndex = useCallback(
    (ref, index, animated = false) => {
      ref.current?.scrollTo({ y: index * ITEM_HEIGHT, animated });
    },
    [],
  );

  // On open, snap all columns to their correct position
  useEffect(() => {
    if (!visible) return;

    // Re-sync state from the `value` prop each time the modal opens
    const d = value.getDate();
    const m = value.getMonth();
    const y = value.getFullYear();

    setSelectedDay(d);
    setSelectedMonth(m);
    setSelectedYear(y);

    const yi = years.indexOf(y);

    setTimeout(() => {
      scrollToIndex(dayRef, d - 1);
      scrollToIndex(monthRef, m);
      scrollToIndex(yearRef, yi >= 0 ? yi : 0);
    }, 50);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // When month or year changes, validate the day and re-scroll the day column
  useEffect(() => {
    const maxDay = daysInMonth(selectedYear, selectedMonth + 1);
    if (selectedDay > maxDay) {
      setSelectedDay(maxDay);
      scrollToIndex(dayRef, maxDay - 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedMonth, selectedYear]);

  // ── Scroll-end handlers (snap to nearest item) ─────────────────────────────
  const handleDayScroll = (e) => {
    const index = Math.round(e.nativeEvent.contentOffset.y / ITEM_HEIGHT);
    const clamped = Math.max(0, Math.min(index, days.length - 1));
    setSelectedDay(clamped + 1);
  };

  const handleMonthScroll = (e) => {
    const index = Math.round(e.nativeEvent.contentOffset.y / ITEM_HEIGHT);
    const clamped = Math.max(0, Math.min(index, 11));
    setSelectedMonth(clamped);
  };

  const handleYearScroll = (e) => {
    const index = Math.round(e.nativeEvent.contentOffset.y / ITEM_HEIGHT);
    const clamped = Math.max(0, Math.min(index, years.length - 1));
    setSelectedYear(years[clamped]);
  };

  // ── Confirm ─────────────────────────────────────────────────────────────────
  const handleConfirm = () => {
    const safeDayNum = clampDay(selectedDay, selectedYear, selectedMonth + 1);
    const date = new Date(selectedYear, selectedMonth, safeDayNum);
    onConfirm(date);
  };

  // ── Render helpers ───────────────────────────────────────────────────────────

  function renderColumn(
    ref,
    items,
    selectedIndex,
    keyExtractor,
    labelExtractor,
    onScrollEnd,
  ) {
    return (
      <ScrollView
        ref={ref}
        style={styles.column}
        contentContainerStyle={styles.columnContent}
        showsVerticalScrollIndicator={false}
        snapToInterval={ITEM_HEIGHT}
        decelerationRate="fast"
        onMomentumScrollEnd={onScrollEnd}
        onScrollEndDrag={onScrollEnd}
        nestedScrollEnabled
      >
        {items.map((item, index) => {
          const isSelected = index === selectedIndex;
          return (
            <View key={keyExtractor(item)} style={styles.item}>
              <Text
                style={[
                  styles.itemText,
                  isSelected ? styles.itemTextSelected : styles.itemTextUnselected,
                ]}
                numberOfLines={1}
              >
                {labelExtractor(item)}
              </Text>
            </View>
          );
        })}
      </ScrollView>
    );
  }

  // Displayed day index (0-based into `days` array)
  const dayIndex = selectedDay - 1;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onCancel}
    >
      <View style={styles.overlay}>
        {/* Outer card — elevation/shadow layer, NO overflow:hidden */}
        <View style={styles.card}>
          {/* Inner container — clips children to border radius */}
          <View style={styles.cardInner}>

            {/* Header */}
            <View style={styles.header}>
              <Text style={styles.title}>Date of birth</Text>
              <Text style={styles.subtitle}>
                {formatDate(
                  clampDay(selectedDay, selectedYear, selectedMonth + 1),
                  selectedMonth,
                  selectedYear,
                )}
              </Text>
            </View>

            {/* Column labels */}
            <View style={styles.columnLabels}>
              <Text style={[styles.columnLabel, styles.columnLabelDay]}>Day</Text>
              <Text style={[styles.columnLabel, styles.columnLabelMonth]}>Month</Text>
              <Text style={[styles.columnLabel, styles.columnLabelYear]}>Year</Text>
            </View>

            {/* Picker area */}
            <View style={styles.pickerArea}>
              {/* Selection highlight strips */}
              <View pointerEvents="none" style={styles.highlightContainer}>
                <View style={[styles.highlightStrip, { top: CENTER_OFFSET }]} />
                <View style={[styles.highlightStrip, { top: STRIP_BOTTOM }]} />
              </View>

              {/* Columns */}
              {renderColumn(
                dayRef,
                days,
                dayIndex,
                (d) => String(d),
                (d) => String(d),
                handleDayScroll,
              )}
              {renderColumn(
                monthRef,
                MONTH_NAMES,
                selectedMonth,
                (m) => m,
                (m) => m,
                handleMonthScroll,
              )}
              {renderColumn(
                yearRef,
                years,
                yearIndex >= 0 ? yearIndex : 0,
                (y) => String(y),
                (y) => String(y),
                handleYearScroll,
              )}
            </View>

            {/* Actions */}
            <View style={styles.actions}>
              <TouchableOpacity
                style={styles.cancelBtn}
                onPress={onCancel}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                activeOpacity={0.6}
              >
                <Text style={styles.cancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.confirmBtn}
                onPress={handleConfirm}
                activeOpacity={0.85}
              >
                <GoldFill radius={22} />
                <Text style={styles.confirmText}>Done</Text>
              </TouchableOpacity>
            </View>

          </View>
        </View>
      </View>
    </Modal>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: withAlpha(colors.black, 0.5),
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },

  // Outer card — elevation/shadow only, no overflow clipping
  card: {
    width: '100%',
    borderRadius: 20,
    backgroundColor: colors.canvasSoft,
    borderWidth: 1,
    borderColor: colors.border,
    shadowColor: colors.black,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.25,
    shadowRadius: 16,
    elevation: 12,
  },

  // Inner card — clips contents to border radius
  cardInner: {
    borderRadius: 20,
    overflow: 'hidden',
    backgroundColor: colors.canvasSoft,
  },

  // Header
  header: {
    paddingHorizontal: 22,
    paddingTop: 22,
    paddingBottom: 10,
  },
  title: {
    fontSize: 17,
    fontFamily: fonts.displayBold,
    color: colors.ink,
    marginBottom: 2,
  },
  subtitle: {
    fontSize: 13,
    fontFamily: fonts.bodyMedium,
    color: colors.gold,
  },

  // Column label row
  columnLabels: {
    flexDirection: 'row',
    paddingHorizontal: 8,
    paddingBottom: 4,
  },
  columnLabel: {
    fontSize: 11,
    fontFamily: fonts.bodyMedium,
    color: withAlpha(colors.ink, 0.38),
    textAlign: 'center',
  },
  columnLabelDay: {
    flex: 1,
  },
  columnLabelMonth: {
    flex: 2,
  },
  columnLabelYear: {
    flex: 1.2,
  },

  // Picker container
  pickerArea: {
    flexDirection: 'row',
    height: PICKER_HEIGHT,
    paddingHorizontal: 8,
    position: 'relative',
  },

  // Highlight strips — absolute, full-width, amber line
  highlightContainer: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 1,
    pointerEvents: 'none',
  },
  highlightStrip: {
    position: 'absolute',
    left: 8,
    right: 8,
    height: 2,
    backgroundColor: colors.gold,
    opacity: 0.6,
  },

  // Individual column
  column: {
    flex: 1,
  },
  columnContent: {
    // Padding top & bottom so first/last item can center in the viewport
    paddingTop: ITEM_HEIGHT * 2,
    paddingBottom: ITEM_HEIGHT * 2,
  },

  // Each row item
  item: {
    height: ITEM_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 2,
  },
  itemText: {
    textAlign: 'center',
  },
  itemTextSelected: {
    fontSize: 18,
    fontFamily: fonts.bodyBold,
    color: colors.ink,
  },
  itemTextUnselected: {
    fontSize: 16,
    fontFamily: fonts.body,
    color: withAlpha(colors.ink, 0.35),
  },

  // Action row
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 18,
    borderTopWidth: 1,
    borderTopColor: withAlpha(colors.ink, 0.08),
    backgroundColor: colors.canvasSoft,
  },
  cancelBtn: {
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  cancelText: {
    fontSize: 14,
    fontFamily: fonts.bodyMedium,
    color: withAlpha(colors.ink, 0.45),
  },
  confirmBtn: {
    paddingHorizontal: 22,
    paddingVertical: 10,
    backgroundColor: colors.gold,
    borderRadius: 22,
    ...goldButton.glow,
  },
  confirmText: {
    fontSize: 14,
    fontFamily: fonts.bodySemiBold,
    color: colors.surfaceRaised,
  },
});
