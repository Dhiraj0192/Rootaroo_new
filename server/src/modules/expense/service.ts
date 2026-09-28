import { Op } from 'sequelize';
import {
  sequelize,
  Expense,
  ExpenseParticipant,
  Settlement,
  User,
  HouseholdMember,
} from '../../database/models';
import { NotFoundError, ForbiddenError, ValidationError } from '../../shared/utils/errors';
import { getUserHousehold as getUserHouseholdCore } from '../../shared/utils/household';
import * as notificationService from '../../shared/services/notifications';
import type {
  ExpenseResponse,
  ExpenseSummaryResponse,
  LedgerEntryResponse,
  SettlementResponse,
  PaginatedSettlements,
  PaginatedExpenses,
  NetBalanceResponse,
  PairwiseBalanceResponse,
} from './types';

async function getUserHousehold(userId: string): Promise<string> {
  return getUserHouseholdCore(userId, 'You must belong to a household to manage expenses');
}

function toExpenseResponse(expense: Expense): ExpenseResponse {
  const participants = expense.get('participants') as ExpenseParticipant[] || [];
  return {
    id: expense.id,
    householdId: expense.householdId,
    title: expense.title,
    amount: parseFloat(expense.amount.toString()),
    paidBy: expense.paidBy,
    splitType: expense.splitType,
    date: expense.createdAt.toISOString().split('T')[0],
    createdAt: expense.createdAt.toISOString(),
    updatedAt: expense.updatedAt.toISOString(),
    participants: participants.map((p) => ({
      id: p.id,
      expenseId: p.expenseId,
      userId: p.userId,
      shareAmount: parseFloat(p.shareAmount.toString()),
      isSettled: p.isSettled,
      createdAt: p.createdAt.toISOString(),
      user: p.get('user')
        ? {
            id: (p.get('user') as User).id,
            displayName: (p.get('user') as User).displayName,
            avatarUrl: (p.get('user') as User).avatarUrl,
            avatarEmoji: (p.get('user') as User).avatarEmoji,
          }
        : undefined,
    })),
  };
}

/**
 * Split `amount` across `participants`. For 'equal', shares are rounded to
 * cents and any leftover penny from the division goes to the payer's share
 * so the shares always sum exactly to `amount`. For 'custom', the supplied
 * shareAmount is used verbatim but validated: every share must be non-negative
 * and the shares must sum to `amount` (within a cent).
 */
function calculateShares(
  amount: number,
  paidBy: string,
  splitType: 'equal' | 'custom',
  participants: { userId: string; shareAmount?: number }[]
): { userId: string; shareAmount: number }[] {
  if (splitType === 'equal') {
    const rawShare = amount / participants.length;
    const roundedShare = Math.round(rawShare * 100) / 100;
    const shares = participants.map((p) => ({ userId: p.userId, shareAmount: roundedShare }));
    const remainder = Math.round((amount - roundedShare * participants.length) * 100) / 100;
    if (remainder !== 0) {
      const payerIdx = shares.findIndex((s) => s.userId === paidBy);
      const idx = payerIdx !== -1 ? payerIdx : 0;
      shares[idx].shareAmount = Math.round((shares[idx].shareAmount + remainder) * 100) / 100;
    }
    return shares;
  }

  const shares = participants.map((p) => ({ userId: p.userId, shareAmount: p.shareAmount ?? 0 }));
  if (shares.some((s) => s.shareAmount < 0)) {
    throw new ValidationError('Each participant share cannot be negative');
  }
  const total = Math.round(shares.reduce((sum, s) => sum + s.shareAmount, 0) * 100) / 100;
  if (Math.abs(total - amount) > 0.01) {
    throw new ValidationError(
      `Custom shares total ${total.toFixed(2)}, but the expense amount is ${amount.toFixed(2)}`
    );
  }
  return shares;
}

function toSettlementResponse(settlement: Settlement): SettlementResponse {
  const fromUser = settlement.get('fromUser') as User | undefined;
  const toUser = settlement.get('toUser') as User | undefined;
  return {
    id: settlement.id,
    householdId: settlement.householdId,
    fromUserId: settlement.fromUserId,
    toUserId: settlement.toUserId,
    amount: parseFloat(settlement.amount.toString()),
    settledAt: settlement.createdAt.toISOString(),
    fromUser: fromUser
      ? {
          id: fromUser.id,
          displayName: fromUser.displayName,
          avatarUrl: fromUser.avatarUrl,
          avatarEmoji: fromUser.avatarEmoji,
        }
      : undefined,
    toUser: toUser
      ? {
          id: toUser.id,
          displayName: toUser.displayName,
          avatarUrl: toUser.avatarUrl,
          avatarEmoji: toUser.avatarEmoji,
        }
      : undefined,
  };
}

/** FR-100: Create expense with equal or custom split */
export async function createExpense(
  userId: string,
  body: {
    title: string;
    amount: number;
    paidBy: string;
    date?: string;
    splitType: 'equal' | 'custom';
    participants: { userId: string; shareAmount?: number }[];
  }
): Promise<ExpenseResponse> {
  const { title, amount, paidBy, splitType, participants } = body;
  const householdId = await getUserHousehold(userId);

  // Verify payer is in household
  const payerMember = await HouseholdMember.findOne({ where: { userId: paidBy, householdId } });
  if (!payerMember) {
    throw new ForbiddenError('Payer must be a household member');
  }

  // Verify all participants are in household
  const participantIds = participants.map((p) => p.userId);
  const members = await HouseholdMember.findAll({
    where: { userId: { [Op.in]: participantIds }, householdId },
  });
  if (members.length !== participantIds.length) {
    throw new ForbiddenError('All participants must be household members');
  }

  // Calculate share amounts
  const shareAmounts = calculateShares(amount, paidBy, splitType, participants);

  const expense = await Expense.create({
    title,
    amount,
    paidBy,
    splitType,
    householdId,
  });

  // Create participants
  await ExpenseParticipant.bulkCreate(
    shareAmounts.map((p) => ({
      expenseId: expense.id,
      userId: p.userId,
      shareAmount: p.shareAmount,
    }))
  );

  // Load full expense with participants
  const fullExpense = await Expense.findByPk(expense.id, {
    include: [
      { model: ExpenseParticipant, as: 'participants', include: [{ model: User, as: 'user' }] },
    ],
  });

  if (!fullExpense) {
    throw new Error('Failed to load created expense');
  }

  return toExpenseResponse(fullExpense);
}

/** FR-106: List expenses with cursor pagination */
export async function listExpenses(
  userId: string,
  options: { cursor?: string; limit?: number }
): Promise<PaginatedExpenses> {
  const householdId = await getUserHousehold(userId);
  const limit = Math.min(options.limit || 20, 50);
  const where: any = { householdId };
  if (options.cursor) {
    where.createdAt = { [Op.lt]: new Date(options.cursor) };
  }

  const expenses = await Expense.findAll({
    where,
    include: [
      { model: ExpenseParticipant, as: 'participants', include: [{ model: User, as: 'user' }] },
    ],
    order: [['createdAt', 'DESC']],
    limit: limit + 1,
  });

  const hasMore = expenses.length > limit;
  const pageExpenses = hasMore ? expenses.slice(0, limit) : expenses;
  const nextCursor = hasMore
    ? pageExpenses[pageExpenses.length - 1].createdAt.toISOString()
    : null;

  return {
    expenses: pageExpenses.map(toExpenseResponse),
    nextCursor,
    hasMore,
  };
}

export async function getExpenseById(
  expenseId: string,
  userId: string
): Promise<ExpenseResponse> {
  const expense = await Expense.findByPk(expenseId, {
    include: [
      { model: ExpenseParticipant, as: 'participants', include: [{ model: User, as: 'user' }] },
    ],
  });

  if (!expense) {
    throw new NotFoundError('Expense');
  }

  const householdId = await getUserHousehold(userId);
  if (expense.householdId !== householdId) {
    throw new ForbiddenError('Access denied');
  }

  return toExpenseResponse(expense);
}

/** FR-107, FR-108: Update expense (creator or admin only) */
export async function updateExpense(
  expenseId: string,
  userId: string,
  userRole: string,
  body: {
    title?: string;
    amount?: number;
    paidBy?: string;
    splitType?: 'equal' | 'custom';
    participants?: { userId: string; shareAmount?: number }[];
  }
): Promise<ExpenseResponse> {
  const expense = await Expense.findByPk(expenseId, {
    include: [{ model: ExpenseParticipant, as: 'participants' }],
  });

  if (!expense) {
    throw new NotFoundError('Expense');
  }

  const householdId = await getUserHousehold(userId);
  if (expense.householdId !== householdId) {
    throw new ForbiddenError('Access denied');
  }

  // Check permission: creator or admin
  if (expense.paidBy !== userId && userRole !== 'admin') {
    throw new ForbiddenError('Only the creator or an admin can edit this expense');
  }

  // If updating amount or participants, recalculate shares
  if (body.amount !== undefined || body.splitType !== undefined || body.participants !== undefined) {
    const existingParticipants = expense.get('participants') as { userId: string; shareAmount: number }[];
    const participants = body.participants || existingParticipants.map((p) => ({ userId: p.userId, shareAmount: p.shareAmount }));
    const splitType = body.splitType || expense.splitType;
    const amount = body.amount !== undefined ? body.amount : parseFloat(expense.amount.toString());
    const paidBy = body.paidBy !== undefined ? body.paidBy : expense.paidBy;

    const shareAmounts = calculateShares(amount, paidBy, splitType, participants);

    // Verify all participants are household members
    const participantIds = participants.map((p) => p.userId);
    const members = await HouseholdMember.findAll({
      where: { userId: { [Op.in]: participantIds }, householdId },
    });
    if (members.length !== participantIds.length) {
      throw new ForbiddenError('All participants must be household members');
    }

    // Delete old participants and create new ones
    await ExpenseParticipant.destroy({ where: { expenseId } });
    await ExpenseParticipant.bulkCreate(
      shareAmounts.map((p) => ({
        expenseId,
        userId: p.userId,
        shareAmount: p.shareAmount,
      }))
    );
  }

  // Update expense fields
  if (body.title !== undefined) expense.title = body.title;
  if (body.amount !== undefined) expense.amount = body.amount;
  if (body.paidBy !== undefined) expense.paidBy = body.paidBy;
  if (body.splitType !== undefined) expense.splitType = body.splitType;

  await expense.save();

  // Reload with participants
  const updated = await Expense.findByPk(expenseId, {
    include: [
      { model: ExpenseParticipant, as: 'participants', include: [{ model: User, as: 'user' }] },
    ],
  });

  if (!updated) {
    throw new Error('Failed to load updated expense');
  }

  return toExpenseResponse(updated);
}

/** FR-107, FR-108: Delete expense (creator or admin only) */
export async function deleteExpense(
  expenseId: string,
  userId: string,
  userRole: string
): Promise<void> {
  const expense = await Expense.findByPk(expenseId);

  if (!expense) {
    throw new NotFoundError('Expense');
  }

  const householdId = await getUserHousehold(userId);
  if (expense.householdId !== householdId) {
    throw new ForbiddenError('Access denied');
  }

  if (expense.paidBy !== userId && userRole !== 'admin') {
    throw new ForbiddenError('Only the creator or an admin can delete this expense');
  }

  // Cascade will delete participants
  await expense.destroy();
}

/** Send a push reminder to every not-yet-settled participant (other than the payer). */
export async function sendExpenseReminder(
  expenseId: string,
  userId: string
): Promise<{ remindedCount: number }> {
  const expense = await Expense.findByPk(expenseId, {
    include: [{ model: ExpenseParticipant, as: 'participants' }],
  });

  if (!expense) {
    throw new NotFoundError('Expense');
  }

  const householdId = await getUserHousehold(userId);
  if (expense.householdId !== householdId) {
    throw new ForbiddenError('Access denied');
  }

  const sender = await User.findByPk(userId);
  const senderName = sender?.displayName || 'Someone';

  const participants = expense.get('participants') as ExpenseParticipant[];
  const unsettled = participants.filter((p) => !p.isSettled && p.userId !== expense.paidBy);

  await Promise.all(
    unsettled.map((p) =>
      notificationService.notifyUser(
        p.userId,
        'expense_reminder',
        'Payment Reminder',
        `${senderName} reminded you to pay ${parseFloat(p.shareAmount.toString()).toFixed(2)} for "${expense.title}"`,
        { type: 'expense_reminder', expenseId: expense.id }
      )
    )
  );

  return { remindedCount: unsettled.length };
}

/**
 * FR-107/108: Mark all participants of an expense as settled (creator or admin only).
 * For each not-yet-settled participant (other than the payer), this records a real
 * Settlement (participant -> payer, for their share amount) so the balance/ledger
 * reflect the settlement immediately, instead of only flipping a display flag.
 */
export async function markExpenseSettled(
  expenseId: string,
  userId: string,
  userRole: string
): Promise<ExpenseResponse> {
  const expense = await Expense.findByPk(expenseId, {
    include: [{ model: ExpenseParticipant, as: 'participants' }],
  });

  if (!expense) {
    throw new NotFoundError('Expense');
  }

  const householdId = await getUserHousehold(userId);
  if (expense.householdId !== householdId) {
    throw new ForbiddenError('Access denied');
  }

  if (expense.paidBy !== userId && userRole !== 'admin') {
    throw new ForbiddenError('Only the creator or an admin can settle this expense');
  }

  const participants = expense.get('participants') as ExpenseParticipant[];
  const toSettle = participants.filter((p) => !p.isSettled && p.userId !== expense.paidBy);

  await sequelize.transaction(async (transaction) => {
    if (toSettle.length > 0) {
      await Settlement.bulkCreate(
        toSettle.map((p) => ({
          householdId,
          fromUserId: p.userId,
          toUserId: expense.paidBy,
          amount: parseFloat(p.shareAmount.toString()),
        })),
        { transaction }
      );
    }
    await ExpenseParticipant.update(
      { isSettled: true },
      { where: { expenseId }, transaction }
    );
  });

  const updated = await Expense.findByPk(expenseId, {
    include: [
      { model: ExpenseParticipant, as: 'participants', include: [{ model: User, as: 'user' }] },
    ],
  });

  if (!updated) {
    throw new Error('Failed to load updated expense');
  }

  return toExpenseResponse(updated);
}

/** FR-103, FR-104, FR-109: Get expense summary with net balances and ledger */
export async function getExpenseSummary(userId: string): Promise<ExpenseSummaryResponse> {
  const householdId = await getUserHousehold(userId);
  return getExpenseSummaryForHousehold(householdId);
}

export async function getExpenseSummaryForHousehold(householdId: string): Promise<ExpenseSummaryResponse> {
  // Get all household members
  const members = await HouseholdMember.findAll({
    where: { householdId },
    include: [{ model: User, as: 'user' }],
  });

  // Get all expenses for household
  const expenses = await Expense.findAll({
    where: { householdId },
    include: [{ model: ExpenseParticipant, as: 'participants' }],
  });

  // Get all recorded settlements for household — these offset the raw
  // paid/share balance below so a recorded settlement actually reduces
  // what's owed instead of being a disconnected history entry.
  const settlements = await Settlement.findAll({ where: { householdId } });

  // Calculate paid total and share total per user
  const userBalances = new Map<string, { paid: number; share: number }>();
  members.forEach((m) => userBalances.set(m.userId, { paid: 0, share: 0 }));

  expenses.forEach((expense) => {
    const amount = parseFloat(expense.amount.toString());
    const paidBy = expense.paidBy;
    const current = userBalances.get(paidBy) || { paid: 0, share: 0 };
    current.paid += amount;
    userBalances.set(paidBy, current);

    const participants = expense.get('participants') as { userId: string; shareAmount: number | string }[] || [];
    participants.forEach((p) => {
      const share = parseFloat(p.shareAmount.toString());
      const current = userBalances.get(p.userId) || { paid: 0, share: 0 };
      current.share += share;
      userBalances.set(p.userId, current);
    });
  });

  // A settlement fromUser -> toUser means fromUser paid down their debt
  // (their balance moves up) and toUser's claim was paid off (moves down).
  const settlementAdjustments = new Map<string, number>();
  settlements.forEach((s) => {
    const amount = parseFloat(s.amount.toString());
    settlementAdjustments.set(
      s.fromUserId,
      (settlementAdjustments.get(s.fromUserId) || 0) + amount
    );
    settlementAdjustments.set(
      s.toUserId,
      (settlementAdjustments.get(s.toUserId) || 0) - amount
    );
  });

  // Build net balances
  const netBalances: NetBalanceResponse[] = members.map((m) => {
    const bal = userBalances.get(m.userId)!;
    const netBalance = bal.paid - bal.share + (settlementAdjustments.get(m.userId) || 0);
    return {
      userId: m.userId,
      displayName: m.user!.displayName,
      avatarUrl: m.user!.avatarUrl,
      avatarEmoji: m.user!.avatarEmoji,
      paidTotal: bal.paid,
      shareTotal: bal.share,
      netBalance: Math.round(netBalance * 100) / 100,
    };
  });

  // FR-104: Simplified ledger - netting algorithm
  // Clone netBalances to prevent mutation by the ledger algorithm
  const ledger = computeSimplifiedLedger(netBalances.map((nb) => ({ ...nb })));

  return {
    netBalances,
    totalExpenses: expenses.length,
    totalAmount: expenses.reduce((sum, e) => sum + parseFloat(e.amount.toString()), 0),
    ledger,
  };
}

/** FR-104: Get simplified ledger (standalone endpoint, unwraps from summary) */
export async function getLedger(
  userId: string
): Promise<LedgerEntryResponse[]> {
  const summary = await getExpenseSummary(userId);
  return summary.ledger;
}

/**
 * Get one member's pairwise balance against each other household member,
 * without the min-transaction rerouting `computeSimplifiedLedger` does.
 * amount > 0 means targetUserId owes that person; amount < 0 means that
 * person owes targetUserId.
 */
export async function getPairwiseBalances(
  callerId: string,
  targetUserId: string
): Promise<PairwiseBalanceResponse[]> {
  const householdId = await getUserHousehold(callerId);

  const members = await HouseholdMember.findAll({
    where: { householdId },
    include: [{ model: User, as: 'user' }],
  });
  if (!members.some((m) => m.userId === targetUserId)) {
    throw new NotFoundError('Household member');
  }

  const expenses = await Expense.findAll({
    where: { householdId },
    include: [{ model: ExpenseParticipant, as: 'participants' }],
  });
  const settlements = await Settlement.findAll({ where: { householdId } });

  // owed[ower][owedTo] = amount ower owes owedTo
  const owed = new Map<string, Map<string, number>>();
  const addOwed = (ower: string, owedTo: string, amount: number) => {
    if (ower === owedTo) return;
    const inner = owed.get(ower) ?? new Map<string, number>();
    inner.set(owedTo, (inner.get(owedTo) ?? 0) + amount);
    owed.set(ower, inner);
  };

  expenses.forEach((expense) => {
    const paidBy = expense.paidBy;
    const participants = expense.get('participants') as { userId: string; shareAmount: number | string }[] || [];
    participants.forEach((p) => {
      addOwed(p.userId, paidBy, parseFloat(p.shareAmount.toString()));
    });
  });

  settlements.forEach((s) => {
    addOwed(s.fromUserId, s.toUserId, -parseFloat(s.amount.toString()));
  });

  return members
    .filter((m) => m.userId !== targetUserId)
    .map((m) => {
      const targetOwesThem = owed.get(targetUserId)?.get(m.userId) ?? 0;
      const theyOweTarget = owed.get(m.userId)?.get(targetUserId) ?? 0;
      const amount = Math.round((targetOwesThem - theyOweTarget) * 100) / 100;
      return {
        userId: m.userId,
        displayName: m.user!.displayName,
        avatarUrl: m.user!.avatarUrl,
        avatarEmoji: m.user!.avatarEmoji,
        amount,
      };
    })
    .filter((b) => Math.abs(b.amount) > 0.01);
}

function computeSimplifiedLedger(
  balances: { userId: string; displayName: string; netBalance: number }[]
): LedgerEntryResponse[] {
  const creditors = balances
    .filter((b) => b.netBalance > 0.01)
    .sort((a, b) => b.netBalance - a.netBalance);
  const debtors = balances
    .filter((b) => b.netBalance < -0.01)
    .sort((a, b) => a.netBalance - b.netBalance);

  const ledger: LedgerEntryResponse[] = [];
  let i = 0,
    j = 0;

  while (i < creditors.length && j < debtors.length) {
    const creditor = creditors[i];
    const debtor = debtors[j];
    const amount = Math.min(creditor.netBalance, -debtor.netBalance);

    ledger.push({
      fromUserId: debtor.userId,
      fromUserName: debtor.displayName,
      toUserId: creditor.userId,
      toUserName: creditor.displayName,
      amount: Math.round(amount * 100) / 100,
    });

    creditor.netBalance -= amount;
    debtor.netBalance += amount;

    if (creditor.netBalance < 0.01) i++;
    if (debtor.netBalance > -0.01) j++;
  }

  return ledger;
}

/** FR-105: Record a settlement between two users */
export async function recordSettlement(
  userId: string,
  body: { fromUserId: string; toUserId: string; amount: number }
): Promise<SettlementResponse> {
  const householdId = await getUserHousehold(userId);

  // Verify both users are in household
  const [fromMember, toMember] = await Promise.all([
    HouseholdMember.findOne({ where: { userId: body.fromUserId, householdId } }),
    HouseholdMember.findOne({ where: { userId: body.toUserId, householdId } }),
  ]);

  if (!fromMember || !toMember) {
    throw new ForbiddenError('Both users must be household members');
  }

  // Only the fromUser or admin can record settlement
  if (userId !== body.fromUserId) {
    throw new ForbiddenError('Only the payer can record this settlement');
  }

  const settlement = await Settlement.create({
    householdId,
    fromUserId: body.fromUserId,
    toUserId: body.toUserId,
    amount: body.amount,
  });

  const fullSettlement = await Settlement.findByPk(settlement.id, {
    include: [
      { model: User, as: 'fromUser' },
      { model: User, as: 'toUser' },
    ],
  });

  if (!fullSettlement) {
    throw new Error('Failed to load created settlement');
  }

  return toSettlementResponse(fullSettlement);
}

/** FR-106: Get settlement history */
export async function getSettlements(
  userId: string,
  options: { cursor?: string; limit?: number }
): Promise<PaginatedSettlements> {
  const householdId = await getUserHousehold(userId);
  const limit = Math.min(options.limit || 20, 50);

  const where: any = { householdId };
  if (options.cursor) {
    where.createdAt = { [Op.lt]: new Date(options.cursor) };
  }

  const settlements = await Settlement.findAll({
    where,
    include: [
      { model: User, as: 'fromUser' },
      { model: User, as: 'toUser' },
    ],
    order: [['createdAt', 'DESC']],
    limit: limit + 1,
  });

  const hasMore = settlements.length > limit;
  const page = hasMore ? settlements.slice(0, limit) : settlements;
  const nextCursor = hasMore
    ? page[page.length - 1].createdAt.toISOString()
    : null;

  return {
    settlements: page.map(toSettlementResponse),
    nextCursor,
    hasMore,
  };
}