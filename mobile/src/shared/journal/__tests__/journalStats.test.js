const { monthStats, onThisDay, countWords } = require('../journalStats');

// Decrypted entries as the phone holds them: createdAt from the server, the rest from decryption.
const e = (createdAt, text, mood = null, tags = []) => ({ id: createdAt, createdAt, text, mood, tags });

describe('countWords', () => {
  it('counts words like the server used to', () => {
    expect(countWords('Picnic by the river')).toBe(4);
    expect(countWords('  ')).toBe(0);
    expect(countWords('')).toBe(0);
  });
});

describe('monthStats (computed on the phone now)', () => {
  const entries = [
    e('2026-10-01T08:00:00Z', 'one two three', 'happy', ['family', 'walk']),
    e('2026-10-01T20:00:00Z', 'four', 'calm', ['family']),
    e('2026-10-05T09:00:00Z', 'five six', 'rough', ['work']),
    e('2026-09-30T09:00:00Z', 'last month', 'low', ['work']),
  ];

  it('words this month, mood per day (latest entry of the day wins), top tags and most common mood', () => {
    const s = monthStats(entries, { year: 2026, month: 10, timezone: 'UTC' });
    expect(s.wordsThisMonth).toBe(6);
    expect(s.entriesThisMonth).toBe(3);
    expect(s.moodDays).toEqual({ '2026-10-01': 'calm', '2026-10-05': 'rough' });
    expect(s.topTags).toEqual([{ tag: 'family', count: 2 }, { tag: 'walk', count: 1 }, { tag: 'work', count: 1 }]);
    expect(['happy', 'calm', 'rough']).toContain(s.moodSummary);
  });

  it('uses the household timezone for which day an entry belongs to', () => {
    const late = [e('2026-10-01T20:00:00Z', 'late night', 'calm')];
    const s = monthStats(late, { year: 2026, month: 10, timezone: 'Asia/Kathmandu' });
    expect(Object.keys(s.moodDays)).toEqual(['2026-10-02']);
  });

  it('caps top tags at 6', () => {
    const many = Array.from({ length: 10 }, (_, i) => e(`2026-10-0${(i % 9) + 1}T08:00:00Z`, 'x', null, [`t${i}`]));
    expect(monthStats(many, { year: 2026, month: 10, timezone: 'UTC' }).topTags).toHaveLength(6);
  });
});

describe('onThisDay', () => {
  it('finds entries from the same day in earlier years with a 120-character snippet', () => {
    const long = 'a'.repeat(200);
    const list = [
      e('2025-10-08T08:00:00Z', long),
      e('2024-10-08T08:00:00Z', 'two years ago'),
      e('2025-10-09T08:00:00Z', 'not today'),
      e('2026-10-08T08:00:00Z', 'this year'),
    ];
    const found = onThisDay(list, { date: '2026-10-08', timezone: 'UTC' });
    expect(found.map((x) => x.yearsAgo)).toEqual([1, 2]);
    expect(found[0].snippet).toHaveLength(120);
  });
});
