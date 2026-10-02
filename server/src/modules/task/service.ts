import { v4 as uuidv4 } from 'uuid';
import { Op } from 'sequelize';
import {
  Task,
  TaskAssignee,
  User,
} from '../../database/models';
import { NotFoundError, ForbiddenError } from '../../shared/utils/errors';
import { isCurrentHouseholdAdmin, getUserHousehold as getUserHouseholdCore } from '../../shared/utils/household';
import logger from '../../shared/utils/logger';
import { emitToHousehold } from '../billing/socketGate';
import * as notificationService from '../notification/service';
import type {
  CreateTaskBody,
  UpdateTaskBody,
  TaskResponse,
  GroupedTasksResponse,
  TaskSummaryResponse,
  TaskAssigneeResponse,
  TaskAuthorResponse,
} from './types';

// ── Helpers ──

function toAuthorResponse(user: User): TaskAuthorResponse {
  return {
    id: user.id,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    avatarEmoji: user.avatarEmoji,
  };
}

function toAssigneeResponse(user: User): TaskAssigneeResponse {
  return {
    id: user.id,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    avatarEmoji: user.avatarEmoji,
  };
}

async function getUserHousehold(userId: string): Promise<string> {
  return getUserHouseholdCore(userId, 'You must belong to a household to manage tasks');
}

function todayStart(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function todayEnd(): Date {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d;
}

function computeNextDueDate(
  currentDueDate: string | null,
  rule: string,
): string | null {
  if (!currentDueDate || rule === 'none') return null;
  const date = new Date(currentDueDate);
  switch (rule) {
    case 'daily':
      date.setDate(date.getDate() + 1);
      break;
    case 'weekly':
      date.setDate(date.getDate() + 7);
      break;
    case 'biweekly':
      date.setDate(date.getDate() + 14);
      break;
    case 'monthly':
      date.setMonth(date.getMonth() + 1);
      break;
    default:
      return null;
  }
  return date.toISOString().split('T')[0];
}

function toISODateString(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (typeof value === 'string') {
    // already "YYYY-MM-DD" or an ISO string — normalise to date portion only
    return value.split('T')[0];
  }
  return value.toISOString().split('T')[0];
}

function toISOTimestamp(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (typeof value === 'string') return new Date(value).toISOString();
  return value.toISOString();
}

function toTaskResponse(task: Task): TaskResponse {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    status: task.status,
    dueDate: toISODateString(task.dueDate),
    recurrence: task.recurrence,
    recurrenceEndDate: toISODateString(task.recurrenceEndDate),
    points: task.points ?? 5,
    assignees: ((task.get('assignees') as User[]) || []).map(toAssigneeResponse),
    createdBy: toAuthorResponse(task.get('creator') as unknown as User),
    completedBy: task.get('completer')
      ? toAuthorResponse(task.get('completer') as unknown as User)
      : null,
    completedAt: toISOTimestamp(task.completedAt),
    createdAt: toISOTimestamp(task.createdAt) ?? '',
  };
}

// ── Public Methods ──

/** FR-060/061: Create task with assignees. */
export async function createTask(
  userId: string,
  body: CreateTaskBody,
): Promise<TaskResponse> {
  const householdId = await getUserHousehold(userId);

  // Points can't be self-awarded: a task assigned solely to its own creator
  // always gets the baseline point value, regardless of what the client sent.
  const isSelfOnly = body.assigneeIds?.length === 1 && body.assigneeIds[0] === userId;

  const task = await Task.create({
    id: uuidv4(),
    householdId,
    createdBy: userId,
    title: body.title,
    description: body.description || null,
    dueDate: body.dueDate || null,
    status: 'pending',
    recurrence: body.recurrence || 'none',
    recurrenceEndDate: body.recurrenceEndDate || null,
    points: isSelfOnly ? 5 : (body.points ?? 5),
  });

  if (body.assigneeIds && body.assigneeIds.length > 0) {
    await TaskAssignee.bulkCreate(
      body.assigneeIds.map((assigneeId) => ({
        id: uuidv4(),
        taskId: task.id,
        userId: assigneeId,
      })),
    );
  }

  const fullTask = await Task.findByPk(task.id, {
    include: [
      { model: User, as: 'creator' },
      { model: User, as: 'completer' },
      { model: User, as: 'assignees' },
    ],
  });
  if (!fullTask) throw new Error('Failed to load created task');

  // FR-062: Notify assignees (async, fire-and-forget)
  const assigneeIds = body.assigneeIds || [];
  for (const assigneeId of assigneeIds) {
    notificationService.sendToUser(assigneeId, 'task', 'New task assigned',
      `You were assigned: ${body.title}`, { taskId: task.id as string, type: 'task' }
    ).catch((e: Error) => logger.warn('[Push] Task notify failed:', e.message));
  }

  return toTaskResponse(fullTask);
}

/** FR-065: List tasks with optional grouping. */
export async function getTasks(
  userId: string,
  options: { group?: string; status?: string },
): Promise<TaskResponse[] | GroupedTasksResponse> {
  const householdId = await getUserHousehold(userId);
  const include = [
    { model: User, as: 'creator' },
    { model: User, as: 'completer' },
    { model: User, as: 'assignees' },
  ];

  if (options.group === 'status') {
    const now = new Date();
    const start = todayStart();
    const end = todayEnd();
    // Only what the grouped view can show: open tasks, plus those completed
    // today. Older completed tasks used to be loaded (with 3 user joins each)
    // and then discarded below, so the cost grew with household lifetime.
    const allTasks = await Task.findAll({
      where: {
        householdId,
        [Op.or]: [
          { status: { [Op.ne]: 'completed' } },
          { completedAt: { [Op.gte]: start, [Op.lte]: end } },
        ],
      },
      include,
      order: [['createdAt', 'DESC']],
    });
    const grouped: GroupedTasksResponse = {
      pending: [],
      overdue: [],
      completedToday: [],
    };

    for (const t of allTasks) {
      const resp = toTaskResponse(t);
      if (t.status === 'completed') {
        if (t.completedAt && t.completedAt >= start && t.completedAt <= end) {
          grouped.completedToday.push(resp);
        }
      } else if (t.dueDate && new Date(t.dueDate) < now) {
        grouped.overdue.push(resp);
      } else {
        grouped.pending.push(resp);
      }
    }

    return grouped;
  }

  const where: any = { householdId };
  if (options.status) where.status = options.status;

  const tasks = await Task.findAll({
    where,
    include,
    order: [['createdAt', 'DESC']],
  });

  return tasks.map(toTaskResponse);
}

/** FR-060: Get a single task. */
export async function getTaskById(
  taskId: string,
  userId: string,
): Promise<TaskResponse> {
  const householdId = await getUserHousehold(userId);
  const task = await Task.findOne({
    where: { id: taskId, householdId },
    include: [
      { model: User, as: 'creator' },
      { model: User, as: 'completer' },
      { model: User, as: 'assignees' },
    ],
  });
  if (!task) throw new NotFoundError('Task');
  return toTaskResponse(task);
}

/** FR-066: Edit task (creator or admin only). */
export async function updateTask(
  taskId: string,
  userId: string,
  _userRole: string,
  body: UpdateTaskBody,
): Promise<TaskResponse> {
  const householdId = await getUserHousehold(userId);
  const task = await Task.findOne({
    where: { id: taskId, householdId },
    include: [
      { model: User, as: 'creator' },
      { model: User, as: 'completer' },
      { model: User, as: 'assignees' },
    ],
  });
  if (!task) throw new NotFoundError('Task');
  // DB-checked, not the caller's JWT `role` claim, which goes stale on
  // demotion until the token expires (F-06).
  if (task.createdBy !== userId && !(await isCurrentHouseholdAdmin(userId, householdId))) {
    throw new ForbiddenError('Only the creator or an admin can edit this task');
  }

  if (body.title !== undefined) task.title = body.title;
  if (body.description !== undefined) task.description = body.description;
  if (body.dueDate !== undefined) {
    task.dueDate = body.dueDate || null;
  }
  if (body.recurrence !== undefined) task.recurrence = body.recurrence;
  if (body.recurrenceEndDate !== undefined) {
    task.recurrenceEndDate = body.recurrenceEndDate || null;
  }
  if (body.points !== undefined) {
    // This endpoint doesn't support reassigning members, so "self-only"
    // is determined from the task's existing assignees, not the request body.
    const currentAssignees = (task.get('assignees') as User[]) || [];
    const isSelfOnly = currentAssignees.length === 1 && currentAssignees[0].id === userId;
    task.points = isSelfOnly ? 5 : body.points;
  }

  await task.save();
  return toTaskResponse(task);
}

/** FR-067: Delete task (creator or admin only). */
export async function deleteTask(
  taskId: string,
  userId: string,
  _userRole: string,
): Promise<void> {
  const householdId = await getUserHousehold(userId);
  const task = await Task.findOne({ where: { id: taskId, householdId } });
  if (!task) throw new NotFoundError('Task');
  // DB-checked, not the JWT `role` claim (F-06 — see updateTask).
  if (task.createdBy !== userId && !(await isCurrentHouseholdAdmin(userId, householdId))) {
    throw new ForbiddenError('Only the creator or an admin can delete this task');
  }
  await task.destroy();
}

/** FR-063: Complete a task. FR-068: Clone recurring if applicable. */
export async function completeTask(
  taskId: string,
  userId: string,
): Promise<TaskResponse> {
  const householdId = await getUserHousehold(userId);
  const task = await Task.findOne({
    where: { id: taskId, householdId },
    include: [
      { model: User, as: 'creator' },
      { model: User, as: 'completer' },
      { model: User, as: 'assignees' },
    ],
  });
  if (!task) throw new NotFoundError('Task');

  // Only assignees can complete
  const assignees = (task.get('assignees') as User[]) || [];
  if (!assignees.some((a) => a.id === userId)) {
    throw new ForbiddenError('Only assigned members can complete this task');
  }

  task.status = 'completed';
  task.completedBy = userId;
  task.completedAt = new Date();
  await task.save();

  // FR-068: Clone recurring task
  if (task.recurrence !== 'none') {
    const nextDueDate = computeNextDueDate(
      toISODateString(task.dueDate),
      task.recurrence,
    );

    if (
      nextDueDate &&
      (!task.recurrenceEndDate || new Date(nextDueDate) <= new Date(task.recurrenceEndDate!))
    ) {
      const newTask = await Task.create({
        id: uuidv4(),
        householdId: task.householdId,
        createdBy: task.createdBy,
        title: task.title,
        description: task.description,
        dueDate: nextDueDate,
        status: 'pending',
        recurrence: task.recurrence,
        recurrenceEndDate: task.recurrenceEndDate,
        points: task.points,
        pointsReduced: false,
      });

      const assignees = await TaskAssignee.findAll({
        where: { taskId: task.id },
      });
      if (assignees.length > 0) {
        await TaskAssignee.bulkCreate(
          assignees.map((a) => ({
            id: uuidv4(),
            taskId: newTask.id,
            userId: a.userId,
          })),
        );
      }
    }
  }

  const response = toTaskResponse(task);

  // Live-update other household members' dashboards (streak/leaderboard) —
  // same fire-and-forget pattern as feed's new-post broadcast.
  try {
    void emitToHousehold(householdId, 'task:completed', response);
  } catch (e) {
    logger.warn('[WS] Task-completed broadcast failed:', (e as Error).message);
  }

  return response;
}

/** FR-064: Re-open a completed task. */
export async function reopenTask(
  taskId: string,
  userId: string,
  _userRole: string,
): Promise<TaskResponse> {
  const householdId = await getUserHousehold(userId);
  const task = await Task.findOne({
    where: { id: taskId, householdId },
    include: [
      { model: User, as: 'creator' },
      { model: User, as: 'completer' },
      { model: User, as: 'assignees' },
    ],
  });
  if (!task) throw new NotFoundError('Task');

  // Only admin or the member who completed the task can reopen. DB-checked,
  // not the JWT `role` claim (F-06 — see updateTask).
  if (task.completedBy !== userId && !(await isCurrentHouseholdAdmin(userId, householdId))) {
    throw new ForbiddenError('Only admin or the member who completed this task can reopen it');
  }

  task.status = 'reopened';
  task.completedBy = null;
  task.completedAt = null;
  await task.save();

  return toTaskResponse(task);
}

/**
 * FR-069: Dashboard summary counts. Three bounded COUNT queries instead of
 * fetching every task the household has ever created and counting in JS —
 * the old approach scaled with household lifetime activity, not with the
 * (tiny, constant) size of this response.
 */
export async function getTaskSummaryForHousehold(householdId: string): Promise<TaskSummaryResponse> {
  const now = new Date();
  const start = todayStart();
  const end = todayEnd();

  const [overdue, pending, completedToday] = await Promise.all([
    Task.count({
      where: { householdId, status: { [Op.ne]: 'completed' }, dueDate: { [Op.lt]: now } },
    }),
    Task.count({
      where: {
        householdId,
        status: { [Op.ne]: 'completed' },
        [Op.or]: [{ dueDate: { [Op.is]: null } as any }, { dueDate: { [Op.gte]: now } }],
      },
    }),
    Task.count({
      where: { householdId, status: 'completed', completedAt: { [Op.gte]: start, [Op.lte]: end } },
    }),
  ]);

  return { pending, overdue, completedToday };
}

export async function getTaskSummary(
  userId: string,
): Promise<TaskSummaryResponse> {
  const householdId = await getUserHousehold(userId);
  return getTaskSummaryForHousehold(householdId);
}
