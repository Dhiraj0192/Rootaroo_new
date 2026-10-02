import * as SecureStore from 'expo-secure-store';

// Separate from authPersist's token storage on purpose — this tracks a
// per-member UI-state date, not credentials, and has its own lifecycle
// (survives logout of a *different* member, must not be wiped by
// clearTokens()).
const KEY_PREFIX = 'rootaroo_daily_welcome_';

// SecureStore keys must be alphanumeric/./-/_ only — memberId is a uuid so
// this is already safe, but guard against any stray character anyway.
function keyFor(memberId) {
  return `${KEY_PREFIX}${String(memberId).replace(/[^a-zA-Z0-9._-]/g, '_')}`;
}

/** Local calendar date as YYYY-MM-DD, in the device's own timezone. */
export function todayLocalDate() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export async function getLastWelcomeDate(memberId) {
  if (!memberId) return null;
  return SecureStore.getItemAsync(keyFor(memberId));
}

export async function setLastWelcomeDate(memberId, dateStr) {
  if (!memberId) return;
  await SecureStore.setItemAsync(keyFor(memberId), dateStr);
}
