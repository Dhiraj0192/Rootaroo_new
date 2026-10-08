/**
 * WebCrypto polyfill — installs `globalThis.crypto` for the vault's client-side
 * E2EE (RSA-OAEP-4096, AES-256-GCM, PBKDF2-SHA256).
 *
 * Hermes does not ship a WebCrypto API, so we delegate to react-native-quick-crypto
 * (a native module). NOTE: this requires a development build — it does NOT work
 * in Expo Go (the native module isn't bundled there).
 *
 * Import this FIRST, before any module that touches vault crypto, so
 * `crypto.subtle` is present when vault code captures it at load time.
 */
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { polyfillGlobal } = require('react-native/Libraries/Utilities/PolyfillFunctions');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const QuickCrypto = require('react-native-quick-crypto');

  const hasCrypto = typeof globalThis.crypto?.subtle !== 'undefined';
  if (!hasCrypto && QuickCrypto) {
    polyfillGlobal('crypto', () => (QuickCrypto.default || QuickCrypto));
  }
} catch (err) {
  // Native module unavailable (e.g. running in Expo Go) — the app still boots;
  // vault setup/decrypt surfaces a clear "WebCrypto unavailable" error instead.
  if (__DEV__) {
    console.warn(
      '[crypto] react-native-quick-crypto could not be loaded — vault E2EE needs a dev build. Reason:',
      err?.message || err
    );
  }
}
