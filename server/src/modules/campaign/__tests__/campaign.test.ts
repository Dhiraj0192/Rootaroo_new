import { COPY, RULES, pickLine, type CampaignRule } from '../copy';
import { selectSends, isQuietHour, CAMPAIGN_WEEKLY_CAP, type Candidate, type RecentSend } from '../select';
import { runCampaigns } from '../run';

const NOW = new Date('2026-10-08T06:00:00Z'); // 11:45 in Asia/Kathmandu, 23:00 the day before in Los Angeles
const DAY = 24 * 60 * 60 * 1000;

describe('copy deck', () => {
  it('has several lines for every rule', () => {
    for (const rule of RULES) expect(COPY[rule].length).toBeGreaterThanOrEqual(2);
  });

  it('fills placeholders', () => {
    const line = pickLine('task_due_tomorrow', { task: 'Take out bins' }, () => 0);
    expect(line).toContain('Take out bins');
    expect(line).not.toMatch(/\{\w+\}/);
  });

  it('does not repeat the line used last time for that rule', () => {
    const first = pickLine('inactive_3d', { household: 'The Raos' }, () => 0);
    const again = pickLine('inactive_3d', { household: 'The Raos' }, () => 0, first);
    expect(again).not.toBe(first);
  });

  it('leaves no raw placeholder when a variable is missing', () => {
    for (const rule of RULES) {
      for (let i = 0; i < COPY[rule].length; i++) {
        expect(pickLine(rule, {}, () => i / COPY[rule].length)).not.toMatch(/\{\w+\}/);
      }
    }
  });
});

describe('isQuietHour', () => {
  it('is quiet from 21:00 to 08:00 in the household timezone', () => {
    expect(isQuietHour(new Date('2026-10-08T15:30:00Z'), 'Asia/Kathmandu')).toBe(true); // 21:15
    expect(isQuietHour(new Date('2026-10-08T02:00:00Z'), 'Asia/Kathmandu')).toBe(true); // 07:45
    expect(isQuietHour(new Date('2026-10-08T03:00:00Z'), 'Asia/Kathmandu')).toBe(false); // 08:45
  });
});

describe('selectSends', () => {
  const c = (userId: string, rule: Candidate['rule'], timezone = 'Asia/Kathmandu'): Candidate => ({ userId, rule, timezone, vars: {} });

  it('caps campaign pushes at 2 per user per rolling week', () => {
    expect(CAMPAIGN_WEEKLY_CAP).toBe(2);
    const recent: RecentSend[] = [
      { userId: 'u1', rule: 'inactive_3d', sentAt: new Date(NOW.getTime() - 2 * DAY) },
      { userId: 'u1', rule: 'task_due_tomorrow', sentAt: new Date(NOW.getTime() - 3 * DAY) },
      { userId: 'u2', rule: 'inactive_3d', sentAt: new Date(NOW.getTime() - 8 * DAY) },
    ];
    const out = selectSends([c('u1', 'inactive_7d'), c('u2', 'inactive_7d')], recent, NOW, new Set());
    expect(out.map((s) => s.userId)).toEqual(['u2']);
  });

  it('sends at most one push per user per run, picking the highest-priority rule', () => {
    const out = selectSends([c('u1', 'inactive_3d'), c('u1', 'task_due_tomorrow')], [], NOW, new Set());
    expect(out).toHaveLength(1);
    expect(out[0].rule).toBe('task_due_tomorrow');
  });

  it('does not send the same rule to a user twice in a week', () => {
    const recent: RecentSend[] = [{ userId: 'u1', rule: 'inactive_3d', sentAt: new Date(NOW.getTime() - 6 * DAY) }];
    expect(selectSends([c('u1', 'inactive_3d')], recent, NOW, new Set())).toEqual([]);
  });

  it('skips users in quiet hours and users who turned tips off', () => {
    const out = selectSends(
      [c('night', 'inactive_3d', 'America/Los_Angeles'), c('optout', 'inactive_3d'), c('ok', 'inactive_3d')],
      [], NOW, new Set(['optout']),
    );
    expect(out.map((s) => s.userId)).toEqual(['ok']);
  });
});

describe('runCampaigns', () => {
  it('sends the chosen pushes, records them, and reports the count', async () => {
    const deps = {
      gatherCandidates: jest.fn(async () => [
        { userId: 'u1', rule: 'task_due_tomorrow' as const, timezone: 'Asia/Kathmandu', vars: { task: 'Bins' } },
      ]),
      recentSends: jest.fn(async () => []),
      tipsOff: jest.fn(async () => new Set<string>()),
      enabledRules: jest.fn(async () => new Set<CampaignRule>(RULES)),
      lastLine: jest.fn(async () => null),
      send: jest.fn(async () => {}),
      record: jest.fn(async () => 'r1'),
      acquireLock: jest.fn(async () => true),
      releaseLock: jest.fn(async () => {}),
      unrecord: jest.fn(async () => {}),
    };
    const sent = await runCampaigns(NOW, deps);
    expect(sent).toBe(1);
    expect(deps.send).toHaveBeenCalledWith('u1', 'task_due_tomorrow', expect.stringContaining('Bins'));
    expect(deps.record).toHaveBeenCalledWith({ userId: 'u1', rule: 'task_due_tomorrow', line: expect.stringContaining('Bins'), sentAt: NOW });
  });

  it('one failed send does not stop the others', async () => {
    const deps = {
      gatherCandidates: jest.fn(async () => [
        { userId: 'u1', rule: 'inactive_3d' as const, timezone: 'Asia/Kathmandu', vars: {} },
        { userId: 'u2', rule: 'inactive_3d' as const, timezone: 'Asia/Kathmandu', vars: {} },
      ]),
      recentSends: jest.fn(async () => []),
      tipsOff: jest.fn(async () => new Set<string>()),
      enabledRules: jest.fn(async () => new Set<CampaignRule>(RULES)),
      lastLine: jest.fn(async () => null),
      send: jest.fn().mockRejectedValueOnce(new Error('push down')).mockResolvedValue(undefined),
      record: jest.fn(async () => 'r1'),
      acquireLock: jest.fn(async () => true),
      releaseLock: jest.fn(async () => {}),
      unrecord: jest.fn(async () => {}),
    };
    expect(await runCampaigns(NOW, deps)).toBe(1);
    // Claimed before sending, so the failed one is recorded then given back.
    expect(deps.record).toHaveBeenCalledTimes(2);
    expect(deps.unrecord).toHaveBeenCalledTimes(1);
  });

  it('sends nothing and runs no queries when every campaign is off', async () => {
    const deps = {
      gatherCandidates: jest.fn(async () => []),
      recentSends: jest.fn(async () => []),
      tipsOff: jest.fn(async () => new Set<string>()),
      enabledRules: jest.fn(async () => new Set<CampaignRule>()),
      lastLine: jest.fn(async () => null),
      send: jest.fn(async () => {}),
      record: jest.fn(async () => 'r1'),
      acquireLock: jest.fn(async () => true),
      releaseLock: jest.fn(async () => {}),
      unrecord: jest.fn(async () => {}),
    };
    expect(await runCampaigns(NOW, deps)).toBe(0);
    expect(deps.gatherCandidates).not.toHaveBeenCalled();
  });

  it('only sends rules that are switched on', async () => {
    const deps = {
      gatherCandidates: jest.fn(async () => [
        { userId: 'u1', rule: 'task_due_tomorrow' as const, timezone: 'Asia/Kathmandu', vars: { task: 'Bins' } },
        { userId: 'u2', rule: 'inactive_3d' as const, timezone: 'Asia/Kathmandu', vars: {} },
      ]),
      recentSends: jest.fn(async () => []),
      tipsOff: jest.fn(async () => new Set<string>()),
      enabledRules: jest.fn(async () => new Set<CampaignRule>(['inactive_3d'])),
      lastLine: jest.fn(async () => null),
      send: jest.fn(async () => {}),
      record: jest.fn(async () => 'r1'),
      acquireLock: jest.fn(async () => true),
      releaseLock: jest.fn(async () => {}),
      unrecord: jest.fn(async () => {}),
    };
    expect(await runCampaigns(NOW, deps)).toBe(1);
    expect(deps.send).toHaveBeenCalledWith('u2', 'inactive_3d', expect.any(String));
  });

  const oneCandidate = () => ({
    gatherCandidates: jest.fn(async () => [
      { userId: 'u1', rule: 'inactive_3d' as const, timezone: 'Asia/Kathmandu', vars: {} },
      { userId: 'u2', rule: 'inactive_3d' as const, timezone: 'Asia/Kathmandu', vars: {} },
    ]),
    recentSends: jest.fn(async () => []),
    tipsOff: jest.fn(async () => new Set<string>()),
    enabledRules: jest.fn(async () => new Set<CampaignRule>(RULES)),
    lastLine: jest.fn(async () => null),
  });

  it('does nothing when another run holds the lock', async () => {
    const deps = {
      ...oneCandidate(),
      send: jest.fn(async () => {}),
      record: jest.fn(async () => 'r1'),
      acquireLock: jest.fn(async () => false),
      releaseLock: jest.fn(async () => {}),
      unrecord: jest.fn(async () => {}),
    };
    expect(await runCampaigns(NOW, deps)).toBe(0);
    expect(deps.gatherCandidates).not.toHaveBeenCalled();
    expect(deps.send).not.toHaveBeenCalled();
  });

  it('claims each send before pushing it', async () => {
    const order: string[] = [];
    const deps = {
      ...oneCandidate(),
      send: jest.fn(async (u: string) => { order.push(`send:${u}`); }),
      record: jest.fn(async (e: { userId: string }) => { order.push(`record:${e.userId}`); return 'r'; }),
      acquireLock: jest.fn(async () => true),
      releaseLock: jest.fn(async () => {}),
      unrecord: jest.fn(async () => {}),
    };
    await runCampaigns(NOW, deps);
    expect(order).toEqual(['record:u1', 'send:u1', 'record:u2', 'send:u2']);
    expect(deps.releaseLock).toHaveBeenCalled();
  });

  it('gives the claim back when the push fails', async () => {
    const deps = {
      ...oneCandidate(),
      send: jest.fn().mockRejectedValueOnce(new Error('push down')).mockResolvedValue(undefined),
      record: jest.fn().mockResolvedValueOnce('rec-1').mockResolvedValueOnce('rec-2'),
      acquireLock: jest.fn(async () => true),
      releaseLock: jest.fn(async () => {}),
      unrecord: jest.fn(async () => {}),
    };
    expect(await runCampaigns(NOW, deps)).toBe(1);
    expect(deps.unrecord).toHaveBeenCalledTimes(1);
    expect(deps.unrecord).toHaveBeenCalledWith('rec-1');
  });
});
