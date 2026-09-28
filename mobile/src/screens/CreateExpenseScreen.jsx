import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  StatusBar,
  KeyboardAvoidingView,
  Modal,
  FlatList,
  ScrollView,
} from 'react-native';
import { showAlert } from '../shared/services/themedAlert';
import DateTimePicker from '@react-native-community/datetimepicker';
import { expenseApi } from '../shared/api/expense';
import { householdApi } from '../shared/api/household';
import { useAuthStore } from '../shared/store/authStore';
import { useExpenseStore } from '../shared/store/expenseStore';
import { colors, fonts, goldButton, radius, withAlpha } from '../shared/theme';
import { GoldFill } from '../shared/components/GoldButton';
import Avatar from '../components/Avatar';
import { KEYBOARD_BEHAVIOR } from '../shared/components/KeyboardAware';
function formatDateLabel(dateStr) {
  if (!dateStr) return 'Today';
  const d = new Date(dateStr);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return 'Today';
  return d.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}
const SPLIT_OPTIONS = [
  {
    key: 'equal',
    label: 'Equal',
  },
  {
    key: 'custom',
    label: 'Custom',
  },
  {
    key: 'percent',
    label: 'Percent',
  },
];
export default function CreateExpenseScreen({ navigation }) {
  const user = useAuthStore((s) => s.user);
  const householdId = useAuthStore((s) => s.householdId);
  const prependExpense = useExpenseStore((s) => s.prependExpense);
  const [members, setMembers] = useState([]);
  const [saving, setSaving] = useState(false);
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState('');
  const [paidBy, setPaidBy] = useState(null);
  const [splitMode, setSplitMode] = useState('equal');
  const [participants, setParticipants] = useState([]);
  const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
  const [showPaidBySheet, setShowPaidBySheet] = useState(false);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const loadMembers = useCallback(async () => {
    if (!householdId) return;
    try {
      const data = await householdApi.getMembers(householdId);
      setMembers(data);
      if (!paidBy && user) setPaidBy(user.id);
      if (participants.length === 0) {
        setParticipants(
          data.map((m) => ({
            userId: m.userId,
          })),
        );
      }
    } catch {
      showAlert('Error', 'Could not load household members');
    }
  }, [householdId, user]);
  useEffect(() => {
    loadMembers();
  }, [loadMembers]);
  const handleToggleParticipant = useCallback((memberId) => {
    setParticipants((prev) => {
      const exists = prev.find((p) => p.userId === memberId);
      if (exists) return prev.filter((p) => p.userId !== memberId);
      return [
        ...prev,
        {
          userId: memberId,
        },
      ];
    });
  }, []);
  const handleShareChange = useCallback((userId, value) => {
    const num = parseFloat(value) || 0;
    setParticipants((prev) =>
      prev.map((p) =>
        p.userId === userId
          ? {
              ...p,
              shareAmount: num,
            }
          : p,
      ),
    );
  }, []);
  const handleSubmit = useCallback(async () => {
    if (!title.trim()) {
      showAlert('Required', 'Enter a description');
      return;
    }
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) {
      showAlert('Required', 'Enter a valid amount');
      return;
    }
    if (!paidBy) {
      showAlert('Required', 'Select who paid');
      return;
    }
    if (participants.length === 0) {
      showAlert('Required', 'Add at least one participant');
      return;
    }
    const splitType = splitMode === 'equal' ? 'equal' : 'custom';
    let splitParticipants;
    if (splitType === 'equal') {
      splitParticipants = participants.map((p) => ({ userId: p.userId }));
    } else if (splitMode === 'percent') {
      const percentTotal = participants.reduce((sum, p) => sum + (p.shareAmount || 0), 0);
      if (Math.abs(percentTotal - 100) > 0.5) {
        showAlert(
          'Split Mismatch',
          `Percentages total ${percentTotal.toFixed(1)}%, but must total 100%`,
        );
        return;
      }
      const shares = participants.map((p) => ({
        userId: p.userId,
        shareAmount: Math.round(((p.shareAmount || 0) / 100) * amt * 100) / 100,
      }));
      const shareTotal = shares.reduce((sum, s) => sum + s.shareAmount, 0);
      const remainder = Math.round((amt - shareTotal) * 100) / 100;
      if (Math.abs(remainder) >= 0.01) {
        const idx = shares.findIndex((s) => s.userId === paidBy);
        const target = idx !== -1 ? idx : 0;
        shares[target].shareAmount = Math.round((shares[target].shareAmount + remainder) * 100) / 100;
      }
      splitParticipants = shares;
    } else {
      const customTotal = participants.reduce((sum, p) => sum + (p.shareAmount || 0), 0);
      if (Math.abs(customTotal - amt) > 0.01) {
        showAlert(
          'Split Mismatch',
          `Custom amounts total $${customTotal.toFixed(2)}, but the expense is $${amt.toFixed(2)}`,
        );
        return;
      }
      splitParticipants = participants.map((p) => ({
        userId: p.userId,
        shareAmount: p.shareAmount,
      }));
    }
    setSaving(true);
    try {
      const body = {
        title: title.trim(),
        amount: amt,
        paidBy,
        date: date || undefined,
        splitType,
        participants: splitParticipants,
      };
      const created = await expenseApi.create(body);
      prependExpense(created);
      navigation.goBack();
    } catch (e) {
      showAlert('Error', e?.response?.data?.message || 'Could not create expense');
    } finally {
      setSaving(false);
    }
  }, [title, amount, paidBy, participants, splitMode, date, navigation, prependExpense]);
  const paidByName = paidBy ? members.find((m) => m.userId === paidBy)?.displayName || '' : '';
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
        <Text style={styles.sheetTitle}>Add expense</Text>

        <ScrollView
          style={styles.sheetScroll}
          contentContainerStyle={styles.sheetScrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Big amount (SCREEN 23) */}
          <View style={styles.amountRow}>
            <Text style={styles.amountSymbol}>$</Text>
            <TextInput
              style={styles.amountInput}
              value={amount}
              onChangeText={setAmount}
              placeholder="0.00"
              placeholderTextColor={colors.textMuted}
              keyboardType="decimal-pad"
              maxLength={12}
            />
          </View>

          <View style={styles.form}>
            {/* Description */}
            <Text style={styles.fieldLabel}>Description</Text>
            <TextInput
              style={[styles.input, styles.inputFocused]}
              placeholder="Dinner"
              placeholderTextColor={colors.textMuted}
              value={title}
              onChangeText={setTitle}
              maxLength={120}
            />

            {/* Paid by */}
            <Text style={styles.fieldLabel}>Paid by</Text>
            <TouchableOpacity
              style={styles.input}
              onPress={() => setShowPaidBySheet(true)}
              activeOpacity={0.7}
            >
              <Text style={paidByName ? styles.inputValue : styles.inputPlaceholder}>
                {paidByName || 'Select'}
              </Text>
            </TouchableOpacity>

            {/* Split between */}
            <Text style={styles.fieldLabel}>Split between</Text>
            <View style={styles.avatarRow}>
              {members.map((m) => {
                const sel = participants.some((p) => p.userId === m.userId);
                return (
                  <TouchableOpacity
                    key={m.userId}
                    style={[styles.splitAvatar, sel && styles.splitAvatarSelected]}
                    onPress={() => handleToggleParticipant(m.userId)}
                    activeOpacity={0.7}
                  >
                    <Avatar
                      url={m.avatarUrl}
                      emoji={m.avatarEmoji}
                      name={m.displayName}
                      id={m.userId}
                      size={38}
                    />
                  </TouchableOpacity>
                );
              })}
            </View>
            <View style={styles.splitChips}>
              {SPLIT_OPTIONS.map((opt) => {
                const active = splitMode === opt.key;
                return (
                  <TouchableOpacity
                    key={opt.key}
                    style={[styles.splitChip, active && styles.splitChipActive]}
                    onPress={() => setSplitMode(opt.key)}
                    activeOpacity={0.7}
                  >
                    <Text style={[styles.splitChipText, active && styles.splitChipTextActive]}>
                      {opt.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            {splitMode !== 'equal' && (
              <View style={styles.shares}>
                {participants.map((p) => {
                  const member = members.find((m) => m.userId === p.userId);
                  return (
                    <View key={p.userId} style={styles.shareRow}>
                      <Text style={styles.shareName}>{member?.displayName || '?'}</Text>
                      <TextInput
                        style={styles.shareInput}
                        placeholder={splitMode === 'percent' ? '0%' : '$0'}
                        placeholderTextColor={colors.textMuted}
                        keyboardType="numeric"
                        value={p.shareAmount?.toString() || ''}
                        onChangeText={(v) => handleShareChange(p.userId, v)}
                        maxLength={8}
                      />
                    </View>
                  );
                })}
              </View>
            )}

            {/* Date */}
            <Text style={styles.fieldLabel}>Date</Text>
            <TouchableOpacity
              style={styles.input}
              onPress={() => setShowDatePicker(true)}
              activeOpacity={0.7}
            >
              <Text style={styles.inputValue}>{formatDateLabel(date)}</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>

        {/* Submit (SCREEN 23) */}
        <TouchableOpacity
          style={[styles.submitBtn, saving && styles.submitBtnDisabled]}
          onPress={handleSubmit}
          disabled={saving}
          activeOpacity={0.85}
        >
          <GoldFill radius={radius.pill} disabled={saving} />
          {saving ? (
            <ActivityIndicator size="small" color={colors.onAccent} />
          ) : (
            <Text style={styles.submitBtnText}>Add expense</Text>
          )}
        </TouchableOpacity>
      </View>

      {/* Paid by picker */}
      <Modal
        visible={showPaidBySheet}
        transparent
        animationType="slide"
        onRequestClose={() => setShowPaidBySheet(false)}
      >
        <View style={styles.pickerOverlay}>
          <TouchableOpacity
            style={styles.pickerBackdrop}
            activeOpacity={1}
            onPress={() => setShowPaidBySheet(false)}
          />
          <View
            style={[
              styles.pickerSheet,
              {
                paddingBottom: 32,
              },
            ]}
          >
            <Text style={styles.pickerTitle}>Paid by</Text>
            <FlatList
              data={members}
              keyExtractor={(item) => item.userId}
              renderItem={({ item }) => {
                const sel = paidBy === item.userId;
                return (
                  <TouchableOpacity
                    style={styles.pickRow}
                    onPress={() => {
                      setPaidBy(item.userId);
                      setShowPaidBySheet(false);
                    }}
                    activeOpacity={0.7}
                  >
                    <Avatar
                      url={item.avatarUrl}
                      emoji={item.avatarEmoji}
                      name={item.displayName}
                      id={item.userId}
                      size={40}
                    />
                    <Text style={styles.pickName}>{item.displayName}</Text>
                    {sel && <Text style={styles.pickCheck}>✓</Text>}
                  </TouchableOpacity>
                );
              }}
            />
          </View>
        </View>
      </Modal>

      {showDatePicker && (
        <DateTimePicker
          value={date ? new Date(date + 'T00:00:00') : new Date()}
          mode="date"
          onChange={(_, newDate) => {
            setShowDatePicker(false);
            if (newDate) setDate(newDate.toISOString().split('T')[0]);
          }}
        />
      )}
    </KeyboardAvoidingView>
  );
}
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
    paddingBottom: 44,
    shadowColor: colors.shadow,
    shadowOffset: {
      width: 0,
      height: -8,
    },
    shadowOpacity: 0.14,
    shadowRadius: 40,
    elevation: 16,
    maxHeight: '88%',
  },
  sheetScroll: {
    flexShrink: 1,
  },
  sheetScrollContent: {
    paddingBottom: 8,
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
    marginBottom: 26,
  },
  // Big amount (SCREEN 23)
  amountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 26,
  },
  amountSymbol: {
    fontSize: 42,
    fontWeight: '700',
    fontFamily: fonts.displayBold,
    color: colors.ink,
  },
  amountInput: {
    fontSize: 42,
    fontWeight: '700',
    fontFamily: fonts.displayBold,
    color: colors.ink,
    padding: 0,
    minWidth: 120,
    textAlign: 'left',
  },
  form: {
    marginBottom: 20,
  },
  // Fields (SCREEN 23 design inputs)
  fieldLabel: {
    fontSize: 11,
    fontWeight: '600',
    fontFamily: fonts.bodySemiBold,
    letterSpacing: 0.4,
    color: colors.textSecondary,
    marginBottom: 7,
    marginTop: 14,
  },
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
  // Split between (SCREEN 23)
  avatarRow: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 12,
    flexWrap: 'wrap',
  },
  splitAvatar: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: colors.borderCool,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: 'transparent',
  },
  splitAvatarSelected: {
    borderColor: colors.gold,
  },
  splitChips: {
    flexDirection: 'row',
    gap: 8,
  },
  splitChip: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: radius.pill,
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  splitChipActive: {
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.ink,
  },
  splitChipText: {
    fontSize: 12,
    fontWeight: '600',
    fontFamily: fonts.bodySemiBold,
    color: colors.textSecondary,
  },
  splitChipTextActive: {
    color: colors.onAccent,
  },
  // Custom / percent shares
  shares: {
    marginTop: 12,
    gap: 8,
  },
  shareRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: colors.canvas,
  },
  shareName: {
    fontSize: 14,
    fontFamily: fonts.bodyMedium,
    color: colors.ink,
  },
  shareInput: {
    backgroundColor: colors.surface,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontSize: 13,
    fontWeight: '600',
    color: colors.ink,
    width: 80,
    textAlign: 'right',
    borderWidth: 1,
    borderColor: colors.border,
  },
  // Submit (SCREEN 23)
  submitBtn: {
    height: 54,
    borderRadius: radius.pill,
    backgroundColor: colors.gold,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 90,
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
  // Paid-by picker
  pickerOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  pickerBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: withAlpha(colors.shadow, 0.55),
  },
  pickerSheet: {
    backgroundColor: colors.canvasElevated,
    borderTopLeftRadius: 32,
    borderTopRightRadius: 32,
    borderWidth: 1,
    borderColor: colors.border,
    borderBottomWidth: 0,
    paddingTop: 20,
    paddingHorizontal: 24,
  },
  pickerTitle: {
    fontSize: 16,
    fontWeight: '600',
    fontFamily: fonts.displayBold,
    color: colors.ink,
    textAlign: 'center',
    marginBottom: 12,
  },
  pickRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
  },
  pickName: {
    flex: 1,
    fontSize: 15,
    fontWeight: '600',
    fontFamily: fonts.bodySemiBold,
    color: colors.ink,
  },
  pickCheck: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.goldDeep,
  },
});
