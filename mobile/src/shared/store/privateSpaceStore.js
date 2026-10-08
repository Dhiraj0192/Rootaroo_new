import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import {
  deleteAccountKey, generateAccountKeyPair, loadAccountPrivateKey, saveAccountKey,
} from '../crypto/accountKey';
import {
  createBackup, defaultKdf, deriveBackupKeys, generateRecoveryCode, normalizeSecret,
} from '../crypto/keyBackup';
import { codeOnNewPhone, parseTransferQr, prepareOnOldPhone, receiveOnNewPhone, startOnNewPhone } from '../crypto/keyTransfer';
import { base64ToBytes, fromUtf8 } from '../crypto/bytes';
import { aesDecrypt, aesKeyFromBytes, publicKeyFromPrivate } from '../crypto/primitives';
import { errorCode } from '../api/authErrors';

const POLL_MS = 3000;
const MAX_WAIT_MS = 5 * 60 * 1000;

const initial = {
  status: 'unknown', // 'unknown' | 'none' | 'here' | 'elsewhere'
  publicKey: null,
  hasBackup: false,
  backup: null, // { kind, attemptsLeft } once loadBackup() ran
  error: null,
  restore: null, // { step: 'email' | 'secret' | 'erased' | 'done', kind, attemptsLeft, error }
  moving: null, // { step: 'starting' | 'qr' | 'compare' | 'done' | 'failed', qr, code, error }
};

const messageOf = (e, fallback) => e?.response?.data?.message || e?.message || fallback;

/**
 * The account key lives on one phone. This store knows whether it is this one,
 * and runs setup, backup, restore and phone-to-phone moves.
 */
export function createPrivateSpaceStore({ api, kdf = defaultKdf, getUserId, getSocket = () => null }) {
  return createStore((set, get) => {
    let restoreCtx = null; // { restoreToken, salt, kdf, kind }
    let pendingMove = null; // { sessionId, key } waiting for the user to confirm the code
    let cancelWait = null;

    const userId = () => {
      const id = getUserId();
      if (!id) throw new Error('Sign in first');
      return id;
    };

    const stopMove = () => {
      cancelWait?.();
      cancelWait = null;
      pendingMove = null;
    };

    /** Encrypts the account key under a new password / recovery code and replaces the server backup. */
    async function saveBackup(accountKey, { backup, secret }) {
      if (backup === 'none') {
        await api.deleteBackup();
        set({ hasBackup: false, backup: null });
        return {};
      }
      const recoveryCode = backup === 'recovery_code' ? generateRecoveryCode() : undefined;
      const made = await createBackup({
        secret: recoveryCode ?? secret, kind: backup, accountKey, kdf,
      });
      await api.putBackup({
        kind: made.kind, salt: made.salt, kdf: made.kdf, authKey: made.authKey, blob: made.blob,
      });
      set({ hasBackup: true, backup: { kind: backup, attemptsLeft: 10 } });
      return recoveryCode ? { recoveryCode } : {};
    }

    /** Resolves with the session once the old phone has sent its payload (socket nudge, poll as fallback). */
    function waitForPayload(sessionId) {
      return new Promise((resolve, reject) => {
        const socket = getSocket();
        let settled = false;
        let timer;
        let timeout;
        const finish = (fn, value) => {
          if (settled) return;
          settled = true;
          clearInterval(timer);
          clearTimeout(timeout);
          socket?.off?.('key-transfer:payload', onEvent);
          fn(value);
        };
        const check = async () => {
          try {
            const session = await api.getSession(sessionId);
            if (session.payload && session.oldEphemeralPublicKey) finish(resolve, session);
          } catch (e) {
            if (e?.response?.status === 404) finish(reject, new Error('This code expired. Start again.'));
          }
        };
        function onEvent(evt) {
          if (evt?.sessionId === sessionId) check();
        }
        socket?.on?.('key-transfer:payload', onEvent);
        timer = setInterval(check, POLL_MS);
        timeout = setTimeout(() => finish(reject, new Error('This code expired. Start again.')), MAX_WAIT_MS);
        cancelWait = () => finish(reject, new Error('cancelled'));
      });
    }

    return {
      ...initial,

      refresh: async () => {
        try {
          const info = await api.getAccountKey();
          if (!info.publicKey) {
            set({ status: 'none', publicKey: null, hasBackup: false, error: null });
          } else if (info.holdsKey) {
            set({ status: 'here', publicKey: info.publicKey, hasBackup: !!info.hasBackup, error: null });
          } else {
            // The server says another phone holds it: a key left here is stale.
            await deleteAccountKey(userId()).catch(() => {});
            set({ status: 'elsewhere', publicKey: info.publicKey, hasBackup: !!info.hasBackup, error: null });
          }
        } catch (e) {
          set({ error: messageOf(e, "Couldn't check your private space") });
        }
      },

      loadBackup: async () => {
        try {
          const info = await api.getBackup();
          set({ backup: info ? { kind: info.kind, attemptsLeft: info.attemptsLeft } : null });
        } catch {
          /* settings falls back to the hasBackup flag */
        }
      },

      setUp: async ({ backup, secret }) => {
        const id = userId();
        const pair = await generateAccountKeyPair();
        await saveAccountKey(id, pair);
        try {
          await api.createAccountKey({ publicKey: pair.publicKey });
        } catch (e) {
          await deleteAccountKey(id).catch(() => {});
          throw e;
        }
        set({ status: 'here', publicKey: pair.publicKey, hasBackup: false, backup: null, error: null });
        if (backup === 'none') return {};
        return saveBackup(pair, { backup, secret });
      },

      /** Needs the key on this phone (biometric prompt); replaces or removes the backup. */
      changeBackup: async ({ backup, secret }) => {
        const accountKey = await loadAccountPrivateKey(userId());
        if (!accountKey) throw new Error('Your private space is not on this phone');
        return saveBackup(accountKey, { backup, secret });
      },

      // ── Restore from backup ──

      startRestore: async () => {
        restoreCtx = null;
        set({ restore: { step: 'email', kind: null, attemptsLeft: null, error: null } });
        try {
          await api.startRestore();
        } catch (e) {
          set({ restore: { step: 'email', kind: null, attemptsLeft: null, error: messageOf(e, "Couldn't send the code") } });
        }
      },

      submitEmailCode: async (emailCode) => {
        try {
          const params = await api.restoreParams({ emailCode });
          restoreCtx = { restoreToken: params.restoreToken, salt: params.salt, kdf: params.kdf, kind: params.kind };
          set({ restore: { step: 'secret', kind: params.kind, attemptsLeft: params.attemptsLeft, error: null } });
        } catch (e) {
          const bad = e?.response?.status === 400;
          set({
            restore: {
              step: 'email', kind: null, attemptsLeft: null,
              error: bad ? 'That code is wrong or has expired' : messageOf(e, "Couldn't check the code"),
            },
          });
        }
      },

      submitSecret: async (secret) => {
        const ctx = restoreCtx;
        if (!ctx) return;
        const { kind } = ctx;
        const keys = await deriveBackupKeys(normalizeSecret(secret, kind), ctx.salt, ctx.kdf, kdf);
        try {
          const { blob } = await api.restore({ restoreToken: ctx.restoreToken, authKey: keys.authKey });
          const plain = await aesDecrypt(await aesKeyFromBytes(base64ToBytes(keys.encKey)), base64ToBytes(blob));
          const accountKey = JSON.parse(fromUtf8(plain));
          plain.fill(0);
          const { publicKey } = get();
          if (accountKey.publicKey !== publicKey || (await publicKeyFromPrivate(accountKey.privateKey)) !== publicKey) {
            throw new Error('The backup does not match your account');
          }
          await saveAccountKey(userId(), accountKey);
          restoreCtx = null;
          set({ status: 'here', restore: { step: 'done', kind, attemptsLeft: null, error: null } });
        } catch (e) {
          const code = errorCode(e);
          if (code === 'BACKUP_ERASED') {
            restoreCtx = null;
            set({ restore: { step: 'erased', kind, attemptsLeft: 0, error: null } });
          } else if (code === 'WRONG_BACKUP_SECRET') {
            set({
              restore: {
                step: 'secret', kind, attemptsLeft: e.response.data.attemptsLeft,
                error: kind === 'recovery_code' ? 'Wrong recovery code' : 'Wrong password',
              },
            });
          } else {
            set({ restore: { step: 'secret', kind, attemptsLeft: get().restore?.attemptsLeft ?? null, error: messageOf(e, "Couldn't restore") } });
          }
        }
      },

      closeRestore: () => {
        restoreCtx = null;
        set({ restore: null });
      },

      // ── Move to this phone (new phone side) ──

      startMoveHere: async () => {
        stopMove();
        set({ moving: { step: 'starting', qr: null, code: null, error: null } });
        try {
          if (!get().publicKey) await get().refresh();
          const { sessionId, qr, state } = await startOnNewPhone({ api });
          set({ moving: { step: 'qr', qr, code: null, error: null } });
          const session = await waitForPayload(sessionId);
          const code = await codeOnNewPhone(state, session.oldEphemeralPublicKey);
          const key = await receiveOnNewPhone(
            state,
            { ephemeralPublicKey: session.oldEphemeralPublicKey, sealed: session.payload },
            get().publicKey,
          );
          pendingMove = { sessionId, key };
          set({ moving: { step: 'compare', qr: null, code, error: null } });
        } catch (e) {
          if (e?.message === 'cancelled') return;
          set({ moving: { step: 'failed', qr: null, code: null, error: messageOf(e, "Couldn't move your private space") } });
        }
      },

      /** The user checked the 6-digit code matches the old phone: keep the key and finish. */
      confirmMove: async () => {
        const pending = pendingMove;
        if (!pending) return;
        const id = userId();
        try {
          await saveAccountKey(id, pending.key);
          await api.completeSession(pending.sessionId);
          pendingMove = null;
          set({ status: 'here', moving: { step: 'done', qr: null, code: null, error: null } });
        } catch (e) {
          await deleteAccountKey(id).catch(() => {});
          pendingMove = null;
          set({ moving: { step: 'failed', qr: null, code: null, error: messageOf(e, "Couldn't finish the move") } });
        }
      },

      cancelMove: () => {
        stopMove();
        set({ moving: null });
      },

      // ── Move away from this phone (old phone side) ──

      /** Returns the code to compare; confirm() asks for biometrics and only then sends the key. */
      approveMove: async (qrString) => {
        const qr = parseTransferQr(qrString);
        const accountKey = await loadAccountPrivateKey(userId());
        if (!accountKey) throw new Error('Your private space is not on this phone');
        const { code, send } = await prepareOnOldPhone({ qr, api, accountKey });
        const confirm = async () => {
          const LocalAuthentication = require('expo-local-authentication');
          const result = await LocalAuthentication.authenticateAsync({ promptMessage: 'Approve moving your private space' });
          if (!result.success) throw new Error('Not approved');
          await send();
        };
        return { code, confirm };
      },

      /** Clears what this session knows (signing out); the key stays on the phone. */
      reset: () => {
        stopMove();
        restoreCtx = null;
        set({ ...initial });
      },

      /** Wipes the key from this phone (signed out by another phone, or account deleted). */
      forget: async () => {
        stopMove();
        restoreCtx = null;
        let id = null;
        try { id = getUserId(); } catch { /* signed out already */ }
        set({ ...initial });
        if (id) await deleteAccountKey(id).catch(() => {});
      },
    };
  });
}

// The default instance is wired lazily: the API client imports this store when a
// phone is revoked, and this store needs the API client.
const lazyApi = new Proxy({}, {
  get: (_, name) => (...args) => require('../api/e2e').e2eApi[name](...args),
});

const appStore = createPrivateSpaceStore({
  api: lazyApi,
  getUserId: () => require('./authStore').useAuthStore.getState().user?.id,
  getSocket: () => require('../socket').getSocket(),
});

export const usePrivateSpaceStore = Object.assign(
  (selector) => useStore(appStore, selector),
  { getState: appStore.getState, setState: appStore.setState, subscribe: appStore.subscribe },
);
