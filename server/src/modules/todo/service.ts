import { v4 as uuidv4 } from 'uuid';
import { Op } from 'sequelize';
import {
  TodoItem,
  User,
} from '../../database/models';
import { NotFoundError, ForbiddenError } from '../../shared/utils/errors';
import { getUserHousehold as getUserHouseholdCore } from '../../shared/utils/household';
import logger from '../../shared/utils/logger';
import { emitToHousehold } from '../billing/socketGate';
import * as notificationService from '../notification/service';
import type {
  CreateTodoBody,
  UpdateTodoBody,
  TodoResponse,
  GroupedTodosResponse,
  TodoSummaryResponse,
  TodoAssignee,
  TodoFilter,
} from './types';

/** Edit/delete rights: only whoever created the to-do, or an admin. Older
 * to-dos with no recorded creator are therefore admin-only. */
function isCreatorOrAdmin(item: TodoItem, userId: string, userRole: string): boolean {
  return userRole === 'admin' || item.createdBy === userId;
}

// Every to-do we hand back carries both its assignee and its creator.
const TODO_INCLUDES = [
  { model: User, as: 'assignee' },
  { model: User, as: 'creator' },
];

function toAssignee(user: User | undefined | null): TodoAssignee | null {
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

function toTodoResponse(item: TodoItem): TodoResponse {
  return {
    id: item.id,
    title: item.title,
    dueDate: item.dueDate
      ? typeof item.dueDate === 'string'
        ? item.dueDate
        : item.dueDate.toISOString().split('T')[0]
      : null,
    // MySQL TIME comes back as "HH:MM:SS".
    dueTime: item.dueTime ? item.dueTime.slice(0, 5) : null,
    assignedTo: toAssignee(item.get('assignee') as User | undefined),
    createdBy: toAssignee(item.get('creator') as User | undefined),
    isCompleted: item.isCompleted,
    completedAt: item.completedAt ? item.completedAt.toISOString() : null,
    createdAt: item.createdAt.toISOString(),
  };
}

export async function createItem(
  userId: string,
  body: CreateTodoBody,
): Promise<TodoResponse> {
  const householdId = await getUserHousehold(userId);

  const item = await TodoItem.create({
    id: uuidv4(),
    householdId,
    title: body.title,
    dueDate: body.dueDate ? new Date(body.dueDate) : null,
    dueTime: body.dueTime || null,
    assignedTo: body.assignedTo || null,
    createdBy: userId,
    isCompleted: false,
  });

  const full = await TodoItem.findByPk(item.id, {
    include: TODO_INCLUDES,
  });
  if (!full) throw new Error('Failed to load');

  // FR-087: Notify assignee (async, fire-and-forget)
  if (body.assignedTo && body.assignedTo !== userId) {
    notificationService.sendToUser(body.assignedTo, 'todo', 'New to-do assigned',
      `You were assigned: ${body.title}`, { todoId: item.id as string, type: 'todo' }
    ).catch((e: Error) => logger.warn('[Push] Todo notify failed:', e.message));
  }

  return toTodoResponse(full);
}

export async function getItems(
  userId: string,
  filter: TodoFilter = 'all',
): Promise<GroupedTodosResponse> {
  const householdId = await getUserHousehold(userId);

  const where: Record<string, unknown> = { householdId };

  if (filter === 'assigned-to-me') {
    where.assignedTo = userId;
  } else if (filter === 'completed') {
    where.isCompleted = true;
  }

  const all = await TodoItem.findAll({
    where,
    include: TODO_INCLUDES,
    order: [['createdAt', 'DESC']],
  });

  const grouped: GroupedTodosResponse = { pending: [], completed: [] };
  for (const item of all) {
    const resp = toTodoResponse(item);
    if (item.isCompleted) {
      grouped.completed.push(resp);
    } else {
      grouped.pending.push(resp);
    }
  }
  return grouped;
}

export async function updateItem(
  itemId: string,
  userId: string,
  userRole: string,
  body: UpdateTodoBody,
): Promise<TodoResponse> {
  const householdId = await getUserHousehold(userId);
  const item = await TodoItem.findOne({
    where: { id: itemId, householdId },
    include: TODO_INCLUDES,
  });
  if (!item) throw new NotFoundError('To-do item');

  if (!isCreatorOrAdmin(item, userId, userRole)) {
    throw new ForbiddenError('Only the creator or an admin can edit this to-do');
  }
  // A finished to-do is a record of what was done — reopen it to change it.
  if (item.isCompleted) {
    throw new ForbiddenError('Completed to-dos can’t be edited');
  }

  if (body.title !== undefined) item.title = body.title;
  if (body.dueDate !== undefined) {
    item.dueDate = body.dueDate ? new Date(body.dueDate) : null;
  }
  if (body.dueTime !== undefined) item.dueTime = body.dueTime;
  if (body.assignedTo !== undefined) item.assignedTo = body.assignedTo;

  await item.save();
  return toTodoResponse(item);
}

export async function deleteItem(
  itemId: string,
  userId: string,
  userRole: string,
): Promise<void> {
  const householdId = await getUserHousehold(userId);
  const item = await TodoItem.findOne({ where: { id: itemId, householdId } });
  if (!item) throw new NotFoundError('To-do item');

  if (!isCreatorOrAdmin(item, userId, userRole)) {
    throw new ForbiddenError('Only the creator or an admin can delete this to-do');
  }

  await item.destroy();
}

export async function toggleComplete(
  itemId: string,
  userId: string,
  userRole: string,
): Promise<TodoResponse> {
  const householdId = await getUserHousehold(userId);
  const item = await TodoItem.findOne({
    where: { id: itemId, householdId },
    include: TODO_INCLUDES,
  });
  if (!item) throw new NotFoundError('To-do item');

  // Only the assignee or an admin can toggle
  if (item.assignedTo && item.assignedTo !== userId && userRole !== 'admin') {
    throw new ForbiddenError('Only the assignee or an admin can toggle this to-do');
  }

  const becameCompleted = !item.isCompleted;
  if (item.isCompleted) {
    item.isCompleted = false;
    item.completedAt = null;
  } else {
    item.isCompleted = true;
    item.completedAt = new Date();
  }

  await item.save();
  const response = toTodoResponse(item);

  // Only broadcast on the completing edge — reopening isn't streak-relevant.
  if (becameCompleted) {
    try {
      void emitToHousehold(householdId, 'todo:completed', response);
    } catch (e) {
      logger.warn('[WS] Todo-completed broadcast failed:', (e as Error).message);
    }
  }

  return response;
}

/** Two bounded COUNT queries instead of fetching every todo the household
 * has ever created and counting in JS. */
export async function getSummaryForHousehold(householdId: string): Promise<TodoSummaryResponse> {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);

  const [pending, completedToday] = await Promise.all([
    TodoItem.count({ where: { householdId, isCompleted: false } }),
    TodoItem.count({
      where: { householdId, isCompleted: true, completedAt: { [Op.gte]: todayStart, [Op.lte]: todayEnd } },
    }),
  ]);

  return { pending, completedToday };
}

export async function getSummary(
  userId: string,
): Promise<TodoSummaryResponse> {
  const householdId = await getUserHousehold(userId);
  return getSummaryForHousehold(householdId);
}
