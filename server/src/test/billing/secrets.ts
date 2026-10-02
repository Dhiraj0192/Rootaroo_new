// Fake key-shaped values are assembled at runtime so no literal ever reaches git
// (the pre-commit scanner flags literals, see scripts/scan-secrets.js).
export function fakeKey(prefix: 'sk_test' | 'rk_test' | 'sk_live' | 'rk_live'): string {
  return [prefix, `Fake${'x'.repeat(20)}`].join('_');
}

export function fakeWebhookSecret(label = 'unit'): string {
  return ['whsec', `${label}Secret0123456789`].join('_');
}
