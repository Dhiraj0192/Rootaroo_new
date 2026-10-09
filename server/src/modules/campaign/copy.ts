export const RULES = [
  'task_due_tomorrow',
  'new_member_first_post',
  'no_checkin_today',
  'inactive_7d',
  'inactive_3d',
] as const;

export type CampaignRule = (typeof RULES)[number];

// Placeholders: {name} first name, {household}, {task}, {member}, {days}.
export const COPY: Record<CampaignRule, string[]> = {
  inactive_3d: [
    'The fridge misses you. Well, the family does. Pop in? 🧲',
    "{household} has news you haven't seen yet 👀",
    'Three days without you and the chore chart is getting ideas.',
    'Psst. Your family left you some updates.',
  ],
  inactive_7d: [
    "It's been a week! The family group chat is getting suspiciously quiet without you.",
    'A whole week? Even the roo has been asking about you. (We assume.)',
    '{household} kept the lights on. Come see what you missed 🏡',
    'Your roo misses you. Hop back in? 🦘',
  ],
  task_due_tomorrow: [
    '"{task}" is due tomorrow. Future-you says thanks in advance 🙏',
    '"{task}" is due tomorrow. Knock it out tonight and sleep easy 😴',
    'Heads up: "{task}" is due tomorrow. Two minutes now beats panic later.',
  ],
  no_checkin_today: [
    "Quiet day at {household}? Drop a check-in so everyone knows you're good 📍",
    "Nobody's checked in today. Be the hero the family group needs.",
  ],
  new_member_first_post: [
    'Welcome to {household}! Say hi with your first post 👋',
    "The family's waiting to hear from you, {name}. Even a photo of lunch counts 🥪",
  ],
};

const FALLBACKS: Record<string, string> = {
  household: 'your household',
  task: 'your task',
  name: 'there',
  member: 'someone new',
  days: '',
};

/** Pick a line, skipping the one this user got last time for the rule, and fill in the placeholders. */
export function pickLine(
  rule: CampaignRule,
  vars: Record<string, string | undefined>,
  rand: () => number = Math.random,
  lastLine?: string | null,
): string {
  const lines = COPY[rule];
  let index = Math.floor(rand() * lines.length) % lines.length;
  if (lastLine && lines[index] === lastLine) index = (index + 1) % lines.length;
  return lines[index]
    .replace(/\{(\w+)\}/g, (_, key: string) => vars[key] || FALLBACKS[key] || '')
    .replace(/ {2,}/g, ' ')
    .trim();
}
