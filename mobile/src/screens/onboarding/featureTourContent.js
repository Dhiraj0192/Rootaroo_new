/**
 * Content for the post-setup feature overview — transcribed verbatim from the
 * Claude Design source (`Rootaroo Onboarding.html`, the five-step flow:
 * Introduction → One ordinary day → Everything in one place → Privacy →
 * Pricing). Copy, ordering, timestamps, icon paths and the pricing maths are
 * the design's, not ours: this module is the single place they live so the
 * five screens stay in sync with the mock and a copy change is a one-file
 * edit.
 *
 * Colour/typography are deliberately NOT here — the screens render this data
 * through the app's own theme tokens (src/shared/theme) so the tour inherits
 * the product's design system rather than the mock's raw hex values.
 */

/* ── Step 1 · Introduction ───────────────────────────────────────────── */

export const intro = {
  brand: 'ROOTAROO',
  // `{name}` is replaced with the household's real name at render time; the
  // mock's "Bhattas" is the fallback when we have nothing better to show.
  titleLead: 'A private home',
  titleTail: 'for the ',
  fallbackHouseholdName: 'Bhattas',
  body: 'Chat, chores, money, calendar and documents — for your household only. No feeds full of strangers.',
  seatLine: ['5 people included', 'in one household'],
  cta: 'See what Rootaroo can do',
  ctaSub: 'A minute inside a real household',
};

/* ── Step 2 · One ordinary day ───────────────────────────────────────── */

export const day = {
  eyebrow: "TUESDAY AT THE BHATTAS'",
  title: 'One ordinary day',
  closing: 'That was Tuesday. Nothing dramatic — and nothing dropped.',
  cta: 'How it fits together',
};

/** The eight beats, in the design's order. `kind` selects the card body. */
export const dayBeats = [
  { time: '7:10', meridiem: 'AM', title: 'The day lays itself out', sub: 'Calendar', kind: 'calendar' },
  { time: '8:35', meridiem: 'AM', title: 'The milk runs out', sub: 'Grocery list · shared instantly', kind: 'grocery' },
  { time: '11:03', meridiem: 'AM', title: 'Everyone talks in one place', sub: 'Family chat', kind: 'chat' },
  { time: '1:20', meridiem: 'PM', title: 'Chores stop being an argument', sub: 'Chores · points earned', kind: 'chores' },
  { time: '3:45', meridiem: 'PM', title: 'One tap beats five texts', sub: 'Ping · a nudge, not a nag', kind: 'ping' },
  { time: '5:30', meridiem: 'PM', title: "Everyone's home safe", sub: 'Check-ins', kind: 'checkins' },
  { time: '8:10', meridiem: 'PM', title: 'Dinner gets split, no spreadsheet', sub: 'Split bills', kind: 'bill' },
  { time: '9:40', meridiem: 'PM', title: 'The papers you always lose', sub: 'Private vault · Face ID', kind: 'vault' },
];

export const calDays = [
  { label: 'MON', num: 14, on: false },
  { label: 'TUE', num: 15, on: true },
  { label: 'WED', num: 16, on: false },
  { label: 'THU', num: 17, on: false },
  { label: 'FRI', num: 18, on: false },
];

export const calEvent = { title: "Maya's dentist", meta: '4:30pm · Sera driving', initial: 'S' };

export const grocery = [
  { name: 'Milk, 2L', by: 'Sera', done: false },
  { name: 'Basmati rice', by: 'Sid', done: false },
  { name: 'Cardamom', by: 'vacancy', done: true },
];

export const chat = {
  outgoing: "Who's picking Maya up?",
  incoming: "I've got her, added to calendar",
  incomingInitial: 'S',
};

export const chores = [
  { title: 'Take out the recycling', meta: 'vacancy · +40 pts', done: true, initial: 'V' },
  { title: 'Water the balcony plants', meta: 'Yours · due 6:00pm', done: false, initial: 'S' },
];

export const ping = { initial: 'V', title: 'Pinged vacancy', body: '"Bread on your way home?"' };

export const checkins = [
  { initial: 'S', state: 'Home 5:12pm', home: true },
  { initial: 'S', state: 'Home 5:30pm', home: true },
  { initial: 'V', state: 'On the way', home: false },
];

export const bill = {
  label: 'DINNER · SPLIT 3 WAYS',
  total: '$21.00',
  owedLabel: "YOU'RE OWED",
  owed: '+$14',
};

export const vault = [
  { name: 'Tenancy agreement.pdf', meta: 'Added by Sid · Face ID only' },
  { name: 'Maya — vaccination card', meta: 'Added by Sera' },
  { name: 'Wifi & utility logins', meta: 'Shared with household' },
];

/* ── Step 3 · Everything in one place ────────────────────────────────── */

export const hub = {
  eyebrow: 'ONE HOUSEHOLD',
  title: 'Nine things, one place',
  body: 'No app-switching, no group chats going quiet. Everything above shares the same household.',
  householdSub: 'Joined by code · nobody else can see in',
  fallbackHouseholdTitle: 'The Bhatta family',
  cta: 'Who can see all this?',
};

/** The nine features, in the design's grid order. Last tile is accented. */
export const hubTiles = [
  { label: 'Family chat', paths: ['M20 12a7.5 7.5 0 0 1-10.9 6.7L4 20l1.4-4.3A7.5 7.5 0 1 1 20 12Z'] },
  { label: 'Feed', paths: ['M4 6h16M4 12h16M4 18h9'] },
  { label: 'Chores', paths: ['M9 11l3 3 7-7', 'M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h8'] },
  { label: 'Grocery', paths: ['M4 5h2l2.2 10.2a2 2 0 0 0 2 1.6h7.2a2 2 0 0 0 2-1.5L21 9H7', 'M10 20.5h.01', 'M17 20.5h.01'] },
  { label: 'Split bills', paths: ['M12 5v14', 'M16 8.5A2.5 2.5 0 0 0 13.5 6h-2a2.5 2.5 0 0 0 0 5h2a2.5 2.5 0 0 1 0 5h-2A2.5 2.5 0 0 1 9 15.5'] },
  { label: 'Calendar', paths: ['M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7Z', 'M8 3v4M16 3v4M4 11h16'] },
  { label: 'Check-ins', paths: ['M12 21s7-4.6 7-10a7 7 0 1 0-14 0c0 5.4 7 10 7 10Z', 'M12 11h.01'] },
  { label: 'Ping', paths: ['M18 15V10a6 6 0 1 0-12 0v5l-1.5 2.5h15L18 15Z', 'M10 20a2 2 0 0 0 4 0'] },
  { label: 'Private vault', paths: ['M7 11V8a5 5 0 0 1 10 0v3', 'M5 11h14v9H5z'] },
];

/* ── Step 4 · Privacy ────────────────────────────────────────────────── */

export const privacy = {
  eyebrow: 'PRIVACY',
  title: ['Your household,', "nobody else's"],
  cta: 'Make it ours',
};

export const privacyRows = [
  {
    title: 'Encrypted on your device',
    body: 'Vault documents are encrypted before they leave your phone.',
    paths: ['M7 11V8a5 5 0 0 1 10 0v3', 'M5 11h14v9H5z'],
  },
  {
    title: 'Face ID to open',
    body: 'Unlocking the vault uses Face ID on this device — nothing else gets in.',
    paths: [
      'M5 8V6.5A1.5 1.5 0 0 1 6.5 5H8',
      'M16 5h1.5A1.5 1.5 0 0 1 19 6.5V8',
      'M19 16v1.5A1.5 1.5 0 0 1 17.5 19H16',
      'M8 19H6.5A1.5 1.5 0 0 1 5 17.5V16',
      'M9 10v1M15 10v1',
      'M9.5 14.5a3.5 3.5 0 0 0 5 0',
    ],
  },
  {
    title: 'You choose the recovery',
    body: 'Back the key up with a passphrase, or keep it zero-knowledge so it never leaves this device.',
    paths: ['M12 3.5l7 2.5v5.5c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6l7-2.5Z', 'M9 12l2 2 4-4'],
  },
  {
    title: 'Household-only by invite',
    body: 'People join with your household code. There is no public profile and no discovery.',
    paths: [
      'M16 19v-1.5A3.5 3.5 0 0 0 12.5 14h-5A3.5 3.5 0 0 0 4 17.5V19',
      'M10 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
      'M18 8.5v5M15.5 11h5',
    ],
  },
];

/* ── Step 5 · Pricing ────────────────────────────────────────────────── */

export const pricing = {
  eyebrow: 'EVERYTHING YOU JUST SAW',
  title: ["Five apps' worth,", 'one household price'],
  oldWayLabel: 'WHAT FAMILIES PAY FOR THIS ELSEWHERE',
  oldWayTotalLabel: 'Five subscriptions',
  oldWayTotal: '~$399',
  divider: 'WITH ROOTAROO',
  savedUnit: 'a year back',
  elsewhereLabel: '~$399 ELSEWHERE',
  yearTab: 'Yearly · save 26%',
  monthTab: 'Monthly',
  sizeLabel: 'Household',
  featuresTitle: 'All nine features',
  featuresSub: 'Chat, chores, bills, calendar, vault',
  featuresBadge: 'INCLUDED',
};

export const oldWay = [
  { name: 'Task app (per seat)', cost: '$60' },
  { name: 'Family calendar', cost: '$39' },
  { name: 'Expense splitter', cost: '$60' },
  { name: 'Document storage', cost: '$60' },
  { name: 'Location tracker', cost: '$180' },
];

/** Pricing constants, lifted from the design's component state. */
export const PRICE = {
  yearBase: 79.99,
  monthBase: 8.99,
  extraPerMonth: 1.99,
  includedSeats: 5,
  minSeats: 1,
  maxSeats: 10,
  elsewhereYearly: 399,
};

/**
 * The design's pricing maths, verbatim. Given a plan and a household size,
 * returns every derived string the pricing screen renders.
 */
export function derivePricing(plan, size) {
  const year = plan === 'year';
  const extras = Math.max(0, size - PRICE.includedSeats);
  const extraCost = (extras * PRICE.extraPerMonth).toFixed(2);
  const yearTotal = (PRICE.yearBase + extras * PRICE.extraPerMonth * 12).toFixed(2);
  const monthTotal = (PRICE.monthBase + extras * PRICE.extraPerMonth).toFixed(2);
  const effYear = year ? yearTotal : (monthTotal * 12).toFixed(2);
  const big = year ? yearTotal : monthTotal;

  return {
    year,
    extras,
    bigWhole: big.split('.')[0],
    bigCents: '.' + big.split('.')[1],
    bigPerShort: year ? 'per year' : 'per month',
    headSub: year
      ? `${size} people · about $${(yearTotal / 12).toFixed(2)} a month`
      : `${size} people · cancel any time`,
    extraLine: extras
      ? `${extras} extra ${extras === 1 ? 'member' : 'members'} · +$${extraCost}/mo`
      : `Add more any time for $${PRICE.extraPerMonth.toFixed(2)}/mo each`,
    savedAmount: '$' + Math.max(0, Math.round(PRICE.elsewhereYearly - effYear)),
    savedSub: year
      ? 'One bill, one login, every feature we add next'
      : `Yearly drops it to $${yearTotal} — save $${(monthTotal * 12 - yearTotal).toFixed(2)} more`,
    goldW: Math.round(Math.min(100, (effYear / PRICE.elsewhereYearly) * 100)) + '%',
    rootYearly: `$${effYear}/YR`,
    payLabel: year ? `Continue · $${yearTotal}/yr` : `Continue · $${monthTotal}/mo`,
    payFine: extras
      ? `${size} members · ${PRICE.includedSeats} included, ${extras} × $${PRICE.extraPerMonth.toFixed(2)}/mo · cancel any time`
      : `${size} of ${PRICE.includedSeats} included members · cancel any time`,
  };
}

/** Route order — also the rail order and the resume order. */
export const TOUR_ROUTES = [
  'FeatureIntro',
  'FeatureDay',
  'FeaturePrivacy',
  'FeaturePricing',
];
