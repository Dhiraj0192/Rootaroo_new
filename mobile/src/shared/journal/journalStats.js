/** Journal stats computed on the phone from decrypted entries. */

import { formatInTimeZone } from 'date-fns-tz';

const GOOD_MOODS = ['happy', 'calm'];

export function countWords(text) {
  const t = (text || '').trim();
  return t ? t.split(/\s+/).length : 0;
}

const localDay = (iso, timezone) => formatInTimeZone(new Date(iso), timezone, 'yyyy-MM-dd');

export function monthStats(entries, { year, month, timezone }) {
  const prefix = `${year}-${String(month).padStart(2, '0')}-`;
  const inMonth = entries
    .map((e) => ({ e, day: localDay(e.createdAt, timezone), t: new Date(e.createdAt).getTime() }))
    .filter((x) => x.day.startsWith(prefix))
    .sort((a, b) => a.t - b.t);

  let wordsThisMonth = 0;
  const moodDays = {};
  const tagCounts = new Map();
  const moodCounts = new Map();
  const moodLast = new Map();
  inMonth.forEach(({ e, day }, i) => {
    wordsThisMonth += countWords(e.text);
    if (e.mood) {
      moodDays[day] = e.mood; // ascending order: latest of the day wins
      moodCounts.set(e.mood, (moodCounts.get(e.mood) || 0) + 1);
      moodLast.set(e.mood, i);
    }
    for (const tag of e.tags || []) tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
  });

  const topTags = [...tagCounts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0))
    .slice(0, 6);

  let moodSummary = null;
  for (const [mood, count] of moodCounts) {
    if (moodSummary === null) { moodSummary = mood; continue; }
    const best = moodCounts.get(moodSummary);
    if (count > best || (count === best && moodLast.get(mood) > moodLast.get(moodSummary))) moodSummary = mood;
  }

  return {
    entriesThisMonth: inMonth.length,
    wordsThisMonth,
    moodDays,
    topTags,
    moodSummary,
    goodDays: Object.values(moodDays).filter((m) => GOOD_MOODS.includes(m)).length,
  };
}

export function onThisDay(entries, { date, timezone }) {
  const year = Number(date.slice(0, 4));
  const monthDay = date.slice(5);
  return entries
    .map((e) => ({ e, day: localDay(e.createdAt, timezone), t: new Date(e.createdAt).getTime() }))
    .filter((x) => x.day.slice(5) === monthDay && Number(x.day.slice(0, 4)) < year)
    .sort((a, b) => b.t - a.t)
    .map(({ e, day }) => ({
      id: e.id,
      createdAt: e.createdAt,
      yearsAgo: year - Number(day.slice(0, 4)),
      snippet: (e.text || '').slice(0, 120),
      mood: e.mood ?? null,
    }));
}
