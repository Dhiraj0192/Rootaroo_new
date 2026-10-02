import { v4 as uuidv4 } from 'uuid';
import { Op } from 'sequelize';
import {
  GroceryItem,
  User,
} from '../../database/models';
import { NotFoundError, ForbiddenError } from '../../shared/utils/errors';
import { getUserHousehold as getUserHouseholdCore } from '../../shared/utils/household';
import logger from '../../shared/utils/logger';
import { emitToHousehold } from '../billing/socketGate';
import type {
  CreateGroceryBody,
  UpdateGroceryBody,
  GroceryResponse,
  GroupedGroceriesResponse,
  GrocerySummaryResponse,
  GroceryAssignee,
} from './types';

// ── Helpers ──

function toAssignee(user: User | undefined | null): GroceryAssignee | null {
  if (!user) return null;
  return {
    id: user.id,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    avatarEmoji: user.avatarEmoji,
  };
}

async function getUserHousehold(userId: string): Promise<string> {
  return getUserHouseholdCore(userId);
}

function toGroceryResponse(item: GroceryItem): GroceryResponse {
  return {
    id: item.id,
    name: item.name,
    quantity: item.quantity,
    note: item.note,
    assignedTo: toAssignee(item.get('assignee') as User | undefined),
    isBought: item.isBought,
    boughtBy: toAssignee(item.get('buyer') as User | undefined),
    boughtAt: item.boughtAt ? item.boughtAt.toISOString() : null,
    createdAt: item.createdAt.toISOString(),
  };
}

// ── Public Methods ──

/** FR-080: Add grocery item. */
export async function createItem(
  userId: string,
  body: CreateGroceryBody,
): Promise<GroceryResponse> {
  const householdId = await getUserHousehold(userId);

  const item = await GroceryItem.create({
    id: uuidv4(),
    householdId,
    name: body.name,
    quantity: body.quantity || null,
    note: body.note || null,
    assignedTo: body.assignedTo || null,
    isBought: false,
  });

  const full = await GroceryItem.findByPk(item.id, {
    include: [
      { model: User, as: 'assignee' },
      { model: User, as: 'buyer' },
    ],
  });
  if (!full) throw new Error('Failed to load created item');
  return toGroceryResponse(full);
}

/** FR-087: List groceries with grouping. */
export async function getItems(
  userId: string,
): Promise<GroupedGroceriesResponse> {
  const householdId = await getUserHousehold(userId);

  const all = await GroceryItem.findAll({
    where: { householdId },
    include: [
      { model: User, as: 'assignee' },
      { model: User, as: 'buyer' },
    ],
    order: [['createdAt', 'DESC']],
  });

  const grouped: GroupedGroceriesResponse = {
    pending: [],
    bought: [],
    archived: [],
  };

  for (const item of all) {
    const resp = toGroceryResponse(item);
    if (item.archivedAt) {
      grouped.archived.push(resp);
    } else if (item.isBought) {
      grouped.bought.push(resp);
    } else {
      grouped.pending.push(resp);
    }
  }

  return grouped;
}

/** FR-083: Edit a grocery item. */
export async function updateItem(
  itemId: string,
  userId: string,
  userRole: string,
  body: UpdateGroceryBody,
): Promise<GroceryResponse> {
  const householdId = await getUserHousehold(userId);
  const item = await GroceryItem.findOne({
    where: { id: itemId, householdId },
    include: [
      { model: User, as: 'assignee' },
      { model: User, as: 'buyer' },
    ],
  });
  if (!item) throw new NotFoundError('Grocery item');

  // Only admin can edit
  if (userRole !== 'admin') {
    throw new ForbiddenError('Only admins can edit grocery items');
  }

  if (body.name !== undefined) item.name = body.name;
  if (body.quantity !== undefined) item.quantity = body.quantity;
  if (body.note !== undefined) item.note = body.note;
  if (body.assignedTo !== undefined) item.assignedTo = body.assignedTo;

  await item.save();
  return toGroceryResponse(item);
}

/** FR-082: Delete item. */
export async function deleteItem(
  itemId: string,
  userId: string,
  userRole: string,
): Promise<void> {
  const householdId = await getUserHousehold(userId);
  const item = await GroceryItem.findOne({ where: { id: itemId, householdId } });
  if (!item) throw new NotFoundError('Grocery item');

  // Only admin can delete
  if (userRole !== 'admin') {
    throw new ForbiddenError('Only admins can delete grocery items');
  }

  await item.destroy();
}

/** FR-081: Toggle bought status. */
export async function toggleBought(
  itemId: string,
  userId: string,
  userRole: string,
): Promise<GroceryResponse> {
  const householdId = await getUserHousehold(userId);
  const item = await GroceryItem.findOne({
    where: { id: itemId, householdId },
    include: [
      { model: User, as: 'assignee' },
      { model: User, as: 'buyer' },
    ],
  });
  if (!item) throw new NotFoundError('Grocery item');

  // Only admin or assignee can toggle
  const assignee = item.get('assignee') as User | undefined;
  const isAssignee = assignee?.id === userId;
  if (userRole !== 'admin' && !isAssignee) {
    throw new ForbiddenError('Only the assigned member or an admin can mark items as bought');
  }

  const becameBought = !item.isBought;
  if (item.isBought) {
    item.isBought = false;
    item.boughtBy = null;
    item.boughtAt = null;
  } else {
    item.isBought = true;
    item.boughtBy = userId;
    item.boughtAt = new Date();
  }

  await item.save();
  const response = toGroceryResponse(item);

  // Only broadcast on the bought edge — un-marking isn't streak-relevant.
  if (becameBought) {
    try {
      void emitToHousehold(householdId, 'grocery:bought', response);
    } catch (e) {
      logger.warn('[WS] Grocery-bought broadcast failed:', (e as Error).message);
    }
  }

  return response;
}

/** FR-088: Archive bought items (move out of default view). */
export async function archiveItem(
  itemId: string,
  userId: string,
  userRole: string,
): Promise<GroceryResponse> {
  const householdId = await getUserHousehold(userId);
  const item = await GroceryItem.findOne({
    where: { id: itemId, householdId },
    include: [
      { model: User, as: 'assignee' },
      { model: User, as: 'buyer' },
    ],
  });
  if (!item) throw new NotFoundError('Grocery item');

  // Only admin, buyer, or assignee can archive
  const buyer    = item.get('buyer') as User | undefined;
  const assignee = item.get('assignee') as User | undefined;
  const canArchive = userRole === 'admin' || buyer?.id === userId || assignee?.id === userId;
  if (!canArchive) {
    throw new ForbiddenError('Only the buyer, assignee, or an admin can archive this item');
  }

  item.archivedAt = new Date();
  await item.save();
  return toGroceryResponse(item);
}

/** FR-089: Summary counts for dashboard. */
/** Two bounded COUNT queries instead of fetching every grocery item the
 * household has ever added and counting in JS. */
export async function getSummaryForHousehold(householdId: string): Promise<GrocerySummaryResponse> {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);

  const [pending, boughtToday] = await Promise.all([
    GroceryItem.count({
      where: { householdId, isBought: false, archivedAt: { [Op.is]: null } as any },
    }),
    GroceryItem.count({
      where: {
        householdId,
        isBought: true,
        archivedAt: { [Op.is]: null } as any,
        boughtAt: { [Op.gte]: todayStart, [Op.lte]: todayEnd },
      },
    }),
  ]);

  return { pending, boughtToday };
}

export async function getSummary(
  userId: string,
): Promise<GrocerySummaryResponse> {
  const householdId = await getUserHousehold(userId);
  return getSummaryForHousehold(householdId);
}
