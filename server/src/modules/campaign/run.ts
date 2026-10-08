import { Op } from 'sequelize';
import { addDays } from 'date-fns';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import {
  sequelize, CampaignSend, CheckIn, Device, FeedPost, Household, HouseholdMember,
  NotificationPreference, Task, TaskAssignee, User,
} from '../../database/models';
import { isEntitledBatch } from '../billing/entitlement';
import { sendToUser } from '../notification/service';
import logger from '../../shared/utils/logger';
import { pickLine, type CampaignRule } from './copy';
import { enabledRules } from './settings';
import { selectSends, type Candidate, type RecentSend } from './select';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface CampaignDeps {
  gatherCandidates(now: Date): Promise<Candidate[]>;
  recentSends(since: Date): Promise<RecentSend[]>;
  tipsOff(userIds: string[]): Promise<Set<string>>;
  enabledRules(): Promise<Set<CampaignRule>>;
  lastLine(userId: string, rule: CampaignRule): Promise<string | null>;
  send(userId: string, rule: CampaignRule, line: string): Promise<void>;
  record(entry: { userId: string; rule: CampaignRule; line: string; sentAt: Date }): Promise<void>;
}

/** Returns how many pushes went out. A failed send is logged and skipped, so it isn't recorded against the cap. */
export async function runCampaigns(now: Date, deps: CampaignDeps): Promise<number> {
  const on = await deps.enabledRules();
  if (on.size === 0) return 0;

  const candidates = (await deps.gatherCandidates(now)).filter((c) => on.has(c.rule));
  if (candidates.length === 0) return 0;

  const recent = await deps.recentSends(new Date(now.getTime() - 7 * DAY_MS));
  const tipsOff = await deps.tipsOff([...new Set(candidates.map((c) => c.userId))]);

  let sent = 0;
  for (const c of selectSends(candidates, recent, now, tipsOff)) {
    try {
      const line = pickLine(c.rule, c.vars, Math.random, await deps.lastLine(c.userId, c.rule));
      await deps.send(c.userId, c.rule, line);
      await deps.record({ userId: c.userId, rule: c.rule, line, sentAt: now });
      sent++;
    } catch (err) {
      logger.error(`[Campaigns] ${c.rule} to ${c.userId} failed:`, err);
    }
  }
  return sent;
}

export function defaultCampaignDeps(): CampaignDeps {
  return {
    gatherCandidates,
    enabledRules,
    async recentSends(since) {
      const rows = await CampaignSend.findAll({ where: { sentAt: { [Op.gte]: since } } });
      return rows.map((r) => ({ userId: r.userId, rule: r.rule, sentAt: r.sentAt }));
    },
    async tipsOff(userIds) {
      if (userIds.length === 0) return new Set();
      const rows = await NotificationPreference.findAll({
        where: { userId: userIds, tips: false }, attributes: ['userId'],
      });
      return new Set(rows.map((r) => r.userId));
    },
    async lastLine(userId, rule) {
      const row = await CampaignSend.findOne({ where: { userId, rule }, order: [['sentAt', 'DESC']] });
      return row?.line ?? null;
    },
    async send(userId, rule, line) {
      // History skipped: these are nudges, not something to keep in the in-app list.
      await sendToUser(userId, 'campaign', 'Rootaroo', line, { type: 'campaign', rule }, { skipHistory: true });
    },
    async record({ userId, rule, line, sentAt }) {
      await CampaignSend.create({ userId, rule, line, sentAt });
    },
  };
}

/** Everyone who qualifies for any rule right now, in entitled households only. Queries are batched, not per user. */
async function gatherCandidates(now: Date): Promise<Candidate[]> {
  const allHouseholds = await Household.findAll({ attributes: ['id', 'name', 'timezone'] });
  const entitled = await isEntitledBatch(allHouseholds.map((h) => h.id));
  const households = allHouseholds.filter((h) => entitled.has(h.id));
  if (households.length === 0) return [];
  const householdIds = households.map((h) => h.id);

  const members = await HouseholdMember.findAll({
    where: { householdId: householdIds }, attributes: ['householdId', 'userId', 'joinedAt'],
  });
  const userIds = [...new Set(members.map((m) => m.userId))];
  const users = await User.findAll({ where: { id: userIds }, attributes: ['id', 'displayName'] });
  const firstName = new Map(users.map((u) => [u.id, (u.displayName ?? '').trim().split(/\s+/)[0] ?? '']));

  const lastSeenRows = (await Device.findAll({
    where: { userId: userIds },
    attributes: ['userId', [sequelize.fn('MAX', sequelize.col('last_seen_at')), 'lastSeenAt']],
    group: ['user_id'],
    raw: true,
  })) as unknown as Array<{ userId: string; lastSeenAt: Date | string }>;
  const lastSeen = new Map(lastSeenRows.map((r) => [r.userId, new Date(r.lastSeenAt).getTime()]));

  const out: Candidate[] = [];
  const membersByHousehold = new Map<string, typeof members>();
  for (const m of members) {
    const list = membersByHousehold.get(m.householdId) ?? [];
    list.push(m);
    membersByHousehold.set(m.householdId, list);
  }

  // Inactivity, new-member and check-in rules need only what is already loaded plus one query each.
  const recentPosters = await postedUsers(members.filter((m) => {
    const age = now.getTime() - m.joinedAt.getTime();
    return age >= 2 * DAY_MS && age < 7 * DAY_MS;
  }));
  const checkedInHouseholds = await householdsWithCheckInToday(households, now);
  const dueTasks = await tasksDueTomorrow(households, now);

  for (const h of households) {
    const base = { timezone: h.timezone };
    const list = membersByHousehold.get(h.id) ?? [];
    const vars = (userId: string) => ({ household: h.name, name: firstName.get(userId) ?? '' });
    const localHour = Number(formatInTimeZone(now, h.timezone, 'H'));
    const quietCheckins = list.length >= 2 && localHour >= 18 && !checkedInHouseholds.has(h.id);

    for (const m of list) {
      const seen = lastSeen.get(m.userId);
      if (seen !== undefined) {
        const idle = now.getTime() - seen;
        if (idle >= 7 * DAY_MS && idle < 30 * DAY_MS) out.push({ userId: m.userId, rule: 'inactive_7d', ...base, vars: vars(m.userId) });
        else if (idle >= 3 * DAY_MS && idle < 7 * DAY_MS) out.push({ userId: m.userId, rule: 'inactive_3d', ...base, vars: vars(m.userId) });
      }

      const task = dueTasks.get(`${h.id}:${m.userId}`);
      if (task) out.push({ userId: m.userId, rule: 'task_due_tomorrow', ...base, vars: { ...vars(m.userId), task } });

      if (quietCheckins) out.push({ userId: m.userId, rule: 'no_checkin_today', ...base, vars: vars(m.userId) });

      const joinedAge = now.getTime() - m.joinedAt.getTime();
      if (joinedAge >= 2 * DAY_MS && joinedAge < 7 * DAY_MS && !recentPosters.has(`${h.id}:${m.userId}`)) {
        out.push({ userId: m.userId, rule: 'new_member_first_post', ...base, vars: vars(m.userId) });
      }
    }
  }
  return out;
}

/** Keys "householdId:userId" of the given members who have already posted in that household. */
async function postedUsers(members: HouseholdMember[]): Promise<Set<string>> {
  if (members.length === 0) return new Set();
  const posts = await FeedPost.findAll({
    where: { userId: members.map((m) => m.userId), householdId: members.map((m) => m.householdId) },
    attributes: ['householdId', 'userId'],
    group: ['household_id', 'user_id'],
    raw: true,
  });
  return new Set(posts.map((p) => `${p.householdId}:${p.userId}`));
}

async function householdsWithCheckInToday(households: Household[], now: Date): Promise<Set<string>> {
  // Only households past 18:00 locally matter; anything newer than ~30h covers every timezone's "today".
  const evening = households.filter((h) => Number(formatInTimeZone(now, h.timezone, 'H')) >= 18);
  if (evening.length === 0) return new Set();
  const rows = await CheckIn.findAll({
    where: { householdId: evening.map((h) => h.id), createdAt: { [Op.gte]: new Date(now.getTime() - 30 * 60 * 60 * 1000) } },
    attributes: ['householdId', 'createdAt'],
  });
  const startOfToday = new Map(evening.map((h) => [
    h.id,
    fromZonedTime(`${formatInTimeZone(now, h.timezone, 'yyyy-MM-dd')}T00:00:00`, h.timezone).getTime(),
  ]));
  return new Set(rows.filter((r) => r.createdAt.getTime() >= (startOfToday.get(r.householdId) ?? Infinity)).map((r) => r.householdId));
}

/** "householdId:userId" -> title of the first assigned, unfinished task due tomorrow (household-local). */
async function tasksDueTomorrow(households: Household[], now: Date): Promise<Map<string, string>> {
  const tomorrowOf = new Map(households.map((h) => [h.id, formatInTimeZone(addDays(now, 1), h.timezone, 'yyyy-MM-dd')]));
  const tasks = await Task.findAll({
    where: {
      householdId: households.map((h) => h.id),
      dueDate: [...new Set(tomorrowOf.values())],
      status: { [Op.ne]: 'completed' },
    },
    attributes: ['id', 'householdId', 'title', 'dueDate'],
    order: [['createdAt', 'ASC']],
  });
  const due = tasks.filter((t) => t.dueDate === tomorrowOf.get(t.householdId));
  if (due.length === 0) return new Map();
  const assignees = await TaskAssignee.findAll({ where: { taskId: due.map((t) => t.id) }, attributes: ['taskId', 'userId'] });
  const taskById = new Map(due.map((t) => [t.id, t]));
  const out = new Map<string, string>();
  for (const a of assignees) {
    const t = taskById.get(a.taskId);
    const key = t && `${t.householdId}:${a.userId}`;
    if (t && key && !out.has(key)) out.set(key, t.title);
  }
  return out;
}
