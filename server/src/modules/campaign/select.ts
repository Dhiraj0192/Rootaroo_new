import { formatInTimeZone } from 'date-fns-tz';
import { RULES, type CampaignRule } from './copy';

export const CAMPAIGN_WEEKLY_CAP = 2;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface Candidate {
  userId: string;
  rule: CampaignRule;
  timezone: string;
  vars: Record<string, string>;
}

export interface RecentSend {
  userId: string;
  rule: string;
  sentAt: Date;
}

/** 21:00-08:00 in the household's timezone. */
export function isQuietHour(now: Date, timezone: string): boolean {
  const hour = Number(formatInTimeZone(now, timezone, 'H'));
  return hour >= 21 || hour < 8;
}

/** At most one push per user: the highest-priority rule that clears opt-out, quiet hours, the weekly cap and the no-repeat rule. */
export function selectSends(
  candidates: Candidate[],
  recentSends: RecentSend[],
  now: Date,
  tipsOffUserIds: Set<string>,
): Candidate[] {
  const since = now.getTime() - WEEK_MS;
  const sentByUser = new Map<string, RecentSend[]>();
  for (const s of recentSends) {
    if (s.sentAt.getTime() < since) continue;
    const list = sentByUser.get(s.userId) ?? [];
    list.push(s);
    sentByUser.set(s.userId, list);
  }

  const byUser = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const list = byUser.get(c.userId) ?? [];
    list.push(c);
    byUser.set(c.userId, list);
  }

  const out: Candidate[] = [];
  for (const [userId, options] of byUser) {
    if (tipsOffUserIds.has(userId)) continue;
    const sent = sentByUser.get(userId) ?? [];
    if (sent.length >= CAMPAIGN_WEEKLY_CAP) continue;
    const eligible = options.filter(
      (c) => !isQuietHour(now, c.timezone) && !sent.some((s) => s.rule === c.rule),
    );
    if (eligible.length === 0) continue;
    eligible.sort((a, b) => RULES.indexOf(a.rule) - RULES.indexOf(b.rule));
    out.push(eligible[0]);
  }
  return out;
}
