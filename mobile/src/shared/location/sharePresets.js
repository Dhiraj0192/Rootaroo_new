export const SHARE_PRESETS = [
  { label: '15 min', minutes: 15 },
  { label: '1 hour', minutes: 60 },
  { label: '8 hours', minutes: 480 },
];

export const MAX_SHARE_MINUTES = 480;

const MINUTE_MS = 60_000;

export function formatRemaining(expiresAt, now = Date.now()) {
  const ms = new Date(expiresAt).getTime() - now;
  if (!(ms > 0)) return 'Ending now';
  const total = Math.ceil(ms / MINUTE_MS);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} min left`;
  return m === 0 ? `${h} h left` : `${h} h ${m} min left`;
}

export function formatUpdatedAgo(updatedAt, now = Date.now()) {
  if (!updatedAt) return 'Waiting for location';
  const mins = Math.floor((now - new Date(updatedAt).getTime()) / MINUTE_MS);
  if (mins < 1) return 'Updated just now';
  if (mins < 60) return `Updated ${mins} min ago`;
  return `Updated ${Math.floor(mins / 60)} h ago`;
}
