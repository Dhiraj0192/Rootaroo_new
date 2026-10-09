import { v4 as uuidv4 } from 'uuid';
import { formatInTimeZone } from 'date-fns-tz';
import { setupAssociations, Device, HouseholdMember, Task, TaskAssignee, CampaignSend, NotificationPreference, CampaignSetting } from '../../../database/models';
import { CAMPAIGN_SETTING_KEYS } from '../settings';
import { resetDb, closeIntResources } from '../../../test/int/db';
import { createHouseholdWithAdmin, addMember } from '../../../test/factories';
import { defaultCampaignDeps, runCampaigns } from '../run';

// 12:00 UTC: outside quiet hours for a UTC household, before the 18:00 check-in rule.
const NOW = new Date('2026-10-08T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

beforeAll(() => setupAssociations());
beforeEach(() => resetDb());
afterAll(() => closeIntResources());

async function device(userId: string, lastSeenAt: Date) {
  await Device.create({ userId, deviceKey: uuidv4(), name: 'Phone', platform: 'ios', appVersion: '1.0.0', lastSeenAt });
}

async function seed() {
  // Campaigns are off by default; these tests exercise them switched on.
  await CampaignSetting.bulkCreate(CAMPAIGN_SETTING_KEYS.map((key) => ({ key, enabled: true, updatedBy: 'test' })));
  const { household, admin } = await createHouseholdWithAdmin({ name: 'The Raos', cohort: 'test' });
  await household.update({ timezone: 'UTC' });
  await device(admin.id, ago(60_000));

  const idle = await addMember(household.id);
  await device(idle.id, ago(4 * DAY));

  const newbie = await addMember(household.id);
  await HouseholdMember.update({ joinedAt: ago(3 * DAY) }, { where: { userId: newbie.id } });
  await device(newbie.id, ago(60_000));

  const tomorrow = formatInTimeZone(new Date(NOW.getTime() + DAY), 'UTC', 'yyyy-MM-dd');
  const task = await Task.create({
    id: uuidv4(), householdId: household.id, createdBy: admin.id, title: 'Take out bins',
    dueDate: tomorrow, status: 'pending', recurrence: 'none', points: 10, pointsReduced: false,
  });
  await TaskAssignee.create({ id: uuidv4(), taskId: task.id, userId: admin.id });
  return { admin, idle, newbie };
}

describe('campaign candidates (real queries)', () => {
  it('finds each rule from real rows', async () => {
    const { admin, idle, newbie } = await seed();
    const found = await defaultCampaignDeps().gatherCandidates(NOW);
    const pairs = found.map((c) => [c.userId, c.rule]);
    expect(pairs).toEqual(expect.arrayContaining([
      [admin.id, 'task_due_tomorrow'],
      [idle.id, 'inactive_3d'],
      [newbie.id, 'new_member_first_post'],
    ]));
    expect(found.find((c) => c.rule === 'task_due_tomorrow')?.vars.task).toBe('Take out bins');
    expect(pairs).not.toContainEqual([admin.id, 'inactive_3d']);
  });

  it('a full run records one push per user and does not repeat on the next run', async () => {
    await seed();
    const deps = defaultCampaignDeps();
    expect(await runCampaigns(NOW, deps)).toBe(3);
    expect(await CampaignSend.count()).toBe(3);
    expect(await runCampaigns(new Date(NOW.getTime() + 60 * 60 * 1000), deps)).toBe(0);
  });

  it('respects the Tips and nudges switch', async () => {
    const { idle } = await seed();
    await NotificationPreference.create({ id: uuidv4(), userId: idle.id, tips: false });
    await runCampaigns(NOW, defaultCampaignDeps());
    expect(await CampaignSend.count({ where: { userId: idle.id } })).toBe(0);
  });

  it('sends nothing while campaigns are switched off', async () => {
    await seed();
    await CampaignSetting.update({ enabled: false }, { where: { key: 'all' } });
    expect(await runCampaigns(NOW, defaultCampaignDeps())).toBe(0);
  });
});
