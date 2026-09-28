import React, { useEffect, useState, useCallback } from 'react';
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
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { householdApi } from '../shared/api/household';
import { useAuthStore } from '../shared/store/authStore';
import { useExpenseStore } from '../shared/store/expenseStore';
import { colors, fonts, goldButton, radius, withAlpha } from '../shared/theme';
import { GoldFill } from '../shared/components/GoldButton';
import Avatar from '../components/Avatar';
function formatMoney(n) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}
function formatMoneyCompact(n) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(n);
}
function formatShortDate(dateStr) {
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}
const CATEGORY_KEYWORDS = [
  ['grocery', 'Groceries'],
  ['market', 'Groceries'],
  ['dinner', 'Dining'],
  ['lunch', 'Dining'],
  ['restaurant', 'Dining'],
  ['coffee', 'Dining'],
  ['shopping', 'Shopping'],
  ['clothes', 'Shopping'],
  ['uber', 'Transport'],
  ['taxi', 'Transport'],
  ['gas', 'Transport'],
  ['fuel', 'Transport'],
  ['electric', 'Bills'],
  ['water', 'Bills'],
  ['internet', 'Bills'],
  ['bill', 'Bills'],
  ['pharmacy', 'Health'],
  ['medicine', 'Health'],
  ['doctor', 'Health'],
];
function deriveTopCategory(expenses) {
  const totals = {};
  for (const e of expenses) {
    const t = e.title.toLowerCase();
    let cat = 'Other';
    for (const [kw, name] of CATEGORY_KEYWORDS) {
      if (t.includes(kw)) {
        cat = name;
        break;
      }
    }
    totals[cat] = (totals[cat] || 0) + e.amount;
  }
  let best = null;
  for (const [name, total] of Object.entries(totals)) {
    if (!best || total > best.total)
      best = {
        name,
        total,
      };
  }
  return best;
}
export default function ExpenseListScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const user = useAuthStore((s) => s.user);
  const householdId = useAuthStore((s) => s.householdId);
  const {
    expenses,
    loading,
    refreshing,
    summary,
    settlements,
    fetchExpenses,
    refreshExpenses,
    fetchSummary,
    fetchSettlements,
  } = useExpenseStore();
  const [members, setMembers] = useState([]);
  useEffect(() => {
    fetchExpenses();
    fetchSummary();
    fetchSettlements();
    if (householdId)
      householdApi
        .getMembers(householdId)
        .then(setMembers)
        .catch(() => {});
  }, [fetchExpenses, fetchSummary, fetchSettlements, householdId]);
  const handleRefresh = useCallback(async () => {
    await Promise.all([refreshExpenses(), fetchSummary(), fetchSettlements()]);
  }, [refreshExpenses, fetchSummary, fetchSettlements]);
  if (loading && expenses.length === 0) {
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
  const myBalance = summary?.netBalances.find((nb) => nb.userId === user?.id)?.netBalance ?? null;
  const owes = myBalance !== null && myBalance < 0;
  const owed = myBalance !== null && myBalance > 0;
  const balanceText =
    myBalance === null || myBalance === 0
      ? formatMoney(0)
      : myBalance < 0
        ? `−${formatMoney(Math.abs(myBalance))}`
        : `+${formatMoney(myBalance)}`;
  const balanceStatus = owes ? 'You owe' : owed ? 'You are owed' : 'All settled';
  const payerMost = summary?.netBalances.reduce(
    (a, b) => (b.paidTotal > a.paidTotal ? b : a),
    summary?.netBalances[0],
  );
  const mostPayerName =
    payerMost && payerMost.displayName && payerMost.displayName !== user?.name
      ? `${payerMost.displayName.split(' ')[0]} paid more`
      : null;
  // `summary` is all-time (the server sums every expense ever), so anything
  // labelled "this month" has to be scoped here from the loaded page. The list
  // is newest-first, so the current month is present unless a household logged
  // more than one page of expenses within it.
  const now = new Date();
  const monthExpenses = expenses.filter((e) => {
    const d = new Date(e.date || e.createdAt);
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  });
  const monthTotal = monthExpenses.reduce((sum, e) => sum + Number(e.amount || 0), 0);
  const monthLabel = now.toLocaleDateString('en-US', { month: 'long' });
  const subText = [
    `${monthExpenses.length} shared expense${monthExpenses.length === 1 ? '' : 's'} this month`,
    mostPayerName,
  ]
    .filter(Boolean)
    .join(' · ');

  /** Who a member owes, per the simplified ledger — drives their row sub-line. */
  const owesLine = (userId) => {
    const entry = summary?.ledger?.find((l) => l.fromUserId === userId);
    return entry ? `Owes ${entry.toUserName.split(' ')[0]}` : null;
  };
  /** Falls back to the most recent expense they actually paid for. */
  const paidLine = (userId) => {
    const paid = expenses.find((e) => e.paidBy === userId);
    return paid ? `Paid ${paid.title.toLowerCase()}` : null;
  };
  const memberSubline = (nb) =>
    (nb.netBalance < 0 ? owesLine(nb.userId) : paidLine(nb.userId)) ||
    (nb.netBalance === 0 ? 'Settled up' : null);
  const topCategory = deriveTopCategory(expenses);
  const recentLedger = summary?.ledger?.[0];
  const recentSettlement = recentLedger
    ? {
        from: recentLedger.fromUserName,
        to: recentLedger.toUserName,
        amount: recentLedger.amount,
      }
    : settlements?.[0]
      ? {
          from: settlements[0].fromUser?.displayName || 'Someone',
          to: settlements[0].toUser?.displayName || 'Someone',
          amount: settlements[0].amount,
        }
      : null;
  const familyName = user?.name ? `${user.name.split(' ')[0]}'s Family` : 'Your Family';
  const avatarMembers = members.slice(0, 4);
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

      <ScrollView
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={colors.gold}
            colors={[colors.gold]}
          />
        }
        contentContainerStyle={[
          styles.content,
          {
            paddingBottom: insets.bottom + 40,
          },
        ]}
      >
        {/* ── Header ── */}
        <View style={styles.header}>
          <View style={styles.headerText}>
            <Text style={styles.screenTitle}>Bills</Text>
            <Text style={styles.screenSub} numberOfLines={1}>
              {familyName} · {monthLabel}
            </Text>
          </View>
          <TouchableOpacity
            style={styles.addBtn}
            onPress={() => navigation.navigate('CreateExpense')}
            activeOpacity={0.85}
            accessibilityRole="button"
          >
            <GoldFill radius={radius.pill} />
            <Text style={styles.addBtnText}>+ Add expense</Text>
          </TouchableOpacity>
        </View>

        {/* ── Balance card ── */}
        <View style={styles.balanceCard}>
          <View style={styles.balanceTop}>
            <Text style={styles.cardLabel}>YOUR BALANCE</Text>
            <View style={styles.avatarStack}>
              {avatarMembers.map((m, i) => (
                <View key={m.userId} style={[styles.stackItem, i > 0 && styles.stackItemOverlap]}>
                  <Avatar
                    url={m.avatarUrl}
                    emoji={m.avatarEmoji}
                    name={m.displayName}
                    id={m.userId}
                    size={28}
                  />
                </View>
              ))}
            </View>
          </View>

          <View style={styles.balanceRow}>
            <Text style={styles.balanceAmount}>{balanceText}</Text>
            <View
              style={[
                styles.statusPill,
                owes && styles.statusPillOwe,
                owed && styles.statusPillOwed,
              ]}
            >
              <Text
                style={[
                  styles.statusPillText,
                  owes && styles.statusPillTextOwe,
                  owed && styles.statusPillTextOwed,
                ]}
              >
                {balanceStatus.toUpperCase()}
              </Text>
            </View>
          </View>

          <Text style={styles.cardSub}>{subText}</Text>

          <View style={styles.cardDivider} />

          <View style={styles.statsRow}>
            <View style={styles.statCol}>
              <Text style={styles.statLabel}>THIS MONTH</Text>
              <Text style={styles.statValue}>{formatMoneyCompact(monthTotal)}</Text>
            </View>
            <View style={styles.statDivider} />
            <View style={styles.statCol}>
              <Text style={styles.statLabel}>LAST SETTLED</Text>
              {recentSettlement ? (
                <View style={styles.statInline}>
                  <Text style={styles.statValue}>
                    {formatMoneyCompact(recentSettlement.amount)}
                  </Text>
                  <Text style={styles.statMeta} numberOfLines={1}>
                    {recentSettlement.from.split(' ')[0]} → {recentSettlement.to.split(' ')[0]}
                  </Text>
                </View>
              ) : (
                <Text style={styles.statValue}>—</Text>
              )}
            </View>
          </View>

          <View style={styles.cardActions}>
            <TouchableOpacity
              style={styles.settleBtn}
              onPress={() => navigation.navigate('ExpenseSettlements')}
              activeOpacity={0.85}
            >
              <GoldFill radius={radius.pill} />
              <Text style={styles.settleBtnText}>Settle up</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.ledgerBtn}
              onPress={() => navigation.navigate('ExpenseLedger')}
              activeOpacity={0.85}
            >
              <Text style={styles.ledgerBtnText}>Ledger</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* ── Family balance ── */}
        <Text style={styles.sectionLabel}>FAMILY BALANCE</Text>
        {(summary?.netBalances || [])
          .filter((nb) => nb.userId !== user?.id)
          .map((nb) => {
            const positive = nb.netBalance > 0;
            const negative = nb.netBalance < 0;
            const sub = memberSubline(nb);
            return (
              <TouchableOpacity
                key={nb.userId}
                style={styles.row}
                activeOpacity={0.75}
                onPress={() =>
                  navigation.navigate('MemberBalanceDetail', {
                    userId: nb.userId,
                    displayName: nb.displayName,
                  })
                }
              >
                <Avatar
                  url={nb.avatarUrl}
                  emoji={nb.avatarEmoji}
                  name={nb.displayName}
                  id={nb.userId}
                  size={44}
                />
                <View style={styles.rowBody}>
                  <Text style={styles.rowTitle} numberOfLines={1}>
                    {nb.displayName}
                  </Text>
                  {!!sub && (
                    <Text style={styles.rowSub} numberOfLines={1}>
                      {sub}
                    </Text>
                  )}
                </View>
                <View style={styles.rowRight}>
                  <Text
                    style={[
                      styles.rowAmount,
                      positive && styles.rowAmountPositive,
                      negative && styles.rowAmountNegative,
                    ]}
                  >
                    {positive ? '+' : negative ? '-' : ''}
                    {formatMoneyCompact(Math.abs(nb.netBalance))}
                  </Text>
                  <Text style={styles.rowAmountMeta}>
                    {positive ? 'gets back' : negative ? 'owes' : 'settled'}
                  </Text>
                </View>
              </TouchableOpacity>
            );
          })}

        {/* ── Recent expenses ── */}
        <Text style={styles.sectionLabel}>RECENT EXPENSES</Text>
        {expenses.length === 0 ? (
          <Text style={styles.emptyText}>No expenses yet.</Text>
        ) : (
          expenses.slice(0, 10).map((e) => {
            const iPaid = e.paidBy === user?.id;
            const payerName = iPaid ? 'You' : e.payer?.displayName?.split(' ')[0] || 'Someone';
            const splitCount = e.participants?.length || 0;
            return (
              <TouchableOpacity
                key={e.id}
                style={styles.row}
                activeOpacity={0.75}
                onPress={() => navigation.navigate('ExpenseDetail', { expenseId: e.id })}
              >
                <View style={styles.expenseIcon}>
                  <View style={styles.expenseIconRing} />
                </View>
                <View style={styles.rowBody}>
                  <Text style={styles.rowTitle} numberOfLines={1}>
                    {e.title}
                  </Text>
                  <Text style={styles.rowSub} numberOfLines={1}>
                    {payerName} paid
                    {splitCount ? ` · split among ${splitCount}` : ''}
                  </Text>
                </View>
                <View style={styles.rowRight}>
                  <Text style={styles.rowAmount}>{formatMoneyCompact(e.amount)}</Text>
                  <Text style={styles.rowAmountMeta}>
                    {formatShortDate(e.date || e.createdAt)}
                  </Text>
                </View>
              </TouchableOpacity>
            );
          })
        )}

        {/* ── Insight card ── */}
        <LinearGradient
          colors={[colors.borderCool, colors.canvas]}
          start={{
            x: 0,
            y: 0,
          }}
          end={{
            x: 1,
            y: 1,
          }}
          style={styles.insightCard}
        >
          <Text style={styles.insightText}>
            This month your family shared {monthExpenses.length} expense
            {monthExpenses.length === 1 ? '' : 's'}.
            {topCategory ? ` ${topCategory.name} were your biggest category.` : ''}
          </Text>
        </LinearGradient>
      </ScrollView>
    </View>
  );
}
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
  content: { paddingHorizontal: 20, paddingTop: 8 },

  /* ── Header ── */
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    marginBottom: 6,
  },
  headerText: { flex: 1 },
  screenTitle: {
    fontFamily: fonts.display,
    fontSize: 30,
    lineHeight: 37,
    color: colors.ink,
    letterSpacing: -0.6,
  },
  screenSub: {
    marginTop: 3,
    fontFamily: fonts.body,
    fontSize: 13,
    color: colors.textMuted,
  },
  addBtn: {
    height: 42,
    paddingHorizontal: 18,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.gold,
    ...goldButton.glow,
  },
  addBtnText: {
    fontFamily: fonts.bodyBold,
    fontSize: 14,
    color: goldButton.onGold,
  },

  /* ── Balance card ── */
  balanceCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderCool,
    borderRadius: radius.sheet,
    paddingHorizontal: 18,
    paddingVertical: 18,
  },
  balanceTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  cardLabel: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 11,
    letterSpacing: 1.4,
    color: colors.textFaint,
  },
  avatarStack: { flexDirection: 'row', alignItems: 'center' },
  stackItem: {
    borderRadius: 16,
    borderWidth: 2,
    borderColor: colors.canvasElevated,
  },
  stackItemOverlap: { marginLeft: -10 },

  balanceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 14,
  },
  balanceAmount: {
    fontFamily: fonts.display,
    fontSize: 38,
    lineHeight: 44,
    color: colors.ink,
    letterSpacing: -1,
  },
  statusPill: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radius.sm,
    backgroundColor: withAlpha(colors.success, 0.16),
  },
  statusPillOwe: { backgroundColor: colors.dangerSoft },
  statusPillOwed: { backgroundColor: colors.goldTint },
  statusPillText: {
    fontFamily: fonts.bodyBold,
    fontSize: 10,
    letterSpacing: 0.7,
    color: colors.success,
  },
  statusPillTextOwe: { color: colors.danger },
  statusPillTextOwed: { color: colors.gold },

  cardSub: {
    marginTop: 10,
    fontFamily: fonts.body,
    fontSize: 13,
    color: colors.textMuted,
  },
  cardDivider: {
    height: 1,
    backgroundColor: colors.divider,
    marginVertical: 16,
  },

  statsRow: { flexDirection: 'row', alignItems: 'flex-start' },
  statCol: { flex: 1 },
  statDivider: {
    width: 1,
    alignSelf: 'stretch',
    backgroundColor: colors.divider,
    marginHorizontal: 16,
  },
  statLabel: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 10,
    letterSpacing: 1.2,
    color: colors.textFaint,
  },
  statInline: { flexDirection: 'row', alignItems: 'baseline', gap: 7 },
  statValue: {
    marginTop: 5,
    fontFamily: fonts.bodyBold,
    fontSize: 17,
    color: colors.ink,
  },
  statMeta: {
    flexShrink: 1,
    fontFamily: fonts.body,
    fontSize: 12,
    color: colors.textMuted,
  },

  cardActions: { flexDirection: 'row', gap: 12, marginTop: 18 },
  settleBtn: {
    flex: 1,
    height: 46,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.gold,
    ...goldButton.glow,
  },
  settleBtnText: {
    fontFamily: fonts.bodyBold,
    fontSize: 15,
    color: goldButton.onGold,
  },
  ledgerBtn: {
    flex: 1,
    height: 46,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceDark,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ledgerBtnText: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 15,
    color: colors.ink,
  },

  /* ── Sections ── */
  sectionLabel: {
    marginTop: 24,
    marginBottom: 10,
    fontFamily: fonts.bodySemiBold,
    fontSize: 11,
    letterSpacing: 1.4,
    color: colors.textFaint,
  },

  /* ── Shared row (family balance + recent expenses) ── */
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 13,
    marginBottom: 10,
    paddingHorizontal: 14,
    paddingVertical: 13,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderCool,
    borderRadius: radius.xl,
  },
  rowBody: { flex: 1 },
  rowTitle: {
    fontFamily: fonts.bodyBold,
    fontSize: 15.5,
    color: colors.ink,
  },
  rowSub: {
    marginTop: 3,
    fontFamily: fonts.body,
    fontSize: 13,
    color: colors.textMuted,
  },
  rowRight: { alignItems: 'flex-end' },
  rowAmount: {
    fontFamily: fonts.bodyBold,
    fontSize: 15.5,
    color: colors.ink,
  },
  rowAmountPositive: { color: colors.success },
  rowAmountNegative: { color: colors.danger },
  rowAmountMeta: {
    marginTop: 3,
    fontFamily: fonts.body,
    fontSize: 12,
    color: colors.textFaint,
  },
  expenseIcon: {
    width: 44,
    height: 44,
    borderRadius: radius.card,
    backgroundColor: colors.surfaceDark,
    borderWidth: 1,
    borderColor: colors.borderCool,
    alignItems: 'center',
    justifyContent: 'center',
  },
  expenseIconRing: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    borderColor: colors.gold,
  },

  emptyText: {
    fontFamily: fonts.body,
    fontSize: 14,
    color: colors.textFaint,
    paddingVertical: 12,
  },

  insightCard: {
    borderRadius: 20,
    padding: 20,
    marginTop: 22,
    marginBottom: 66,
  },
  insightText: {
    fontSize: 14,
    lineHeight: 21,
    fontFamily: fonts.body,
    color: colors.brownDeep,
  },
});
