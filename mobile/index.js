// Polyfill WebCrypto (crypto.subtle / getRandomValues) BEFORE any module that
// touches vault crypto is evaluated — Hermes has no WebCrypto by default.
import './src/shared/crypto/cryptoPolyfill';

import { registerRootComponent } from 'expo';
import App from './App';
// Registers the background location task at import time; it must exist before the OS wakes the app for an update.
import './src/shared/location/backgroundShare';

registerRootComponent(App);
