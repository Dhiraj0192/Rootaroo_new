/**
 * Key Pin Store — TOFU (Trust On First Use) public key pinning.
 *
 * Threat model: the server may substitute its own RSA public key when
 * responding to GET /vault/members in order to intercept a key wrapping operation.
 * To detect this, we pin each user's public key on first contact (TOFU) and
 * compare every subsequent server response against the stored pin.
 *
 * If the server-provided key differs from the pinned key, the operation is
 * blocked and the user is explicitly notified. The new key is never silently
 * accepted — the user must re-verify before the pin is updated.
 *
 * TOFU limitation: the very first key fetch has no prior pin to compare against.
 * This is the same trust model as SSH. A MitM on day-zero first contact could
 * substitute a key and it would be trusted. This is a documented, explicit
 * tradeoff. A future fast-follow will add fingerprint display at key-setup time
 * to close this window.
 *
 * Storage: pins live in SecureStore without requireAuthentication (pins are not
 * secret — a pin is a public key; knowing it does not grant vault access).
 */

import * as SecureStore from 'expo-secure-store';

// New prefix: earlier builds pinned RSA keys here, which must not read as "changed".
const PIN_PREFIX = 'vault_x25519_pin_';

/**
 * Pin a public key for a user on first contact (TOFU).
 * Only call this after receiving 'newly_pinned' from verifyPublicKey.
 */
export async function pinPublicKey(userId, spkiB64) {
  await SecureStore.setItemAsync(`${PIN_PREFIX}${userId}`, spkiB64);
}

/**
 * Retrieve the pinned public key for a user, or null if not yet pinned.
 */
export async function getPublicKeyPin(userId) {
  return SecureStore.getItemAsync(`${PIN_PREFIX}${userId}`);
}

/**
 * Verify a server-provided public key against the local TOFU pin.
 *
 * Returns:
 *   'trusted'      — key matches existing pin; safe to use
 *   'newly_pinned' — no prior pin; key has been pinned; safe to use (TOFU moment)
 *   'changed'      — key differs from stored pin; DO NOT USE; alert user
 *
 * The caller is responsible for blocking the operation and notifying the user
 * when this returns 'changed'.
 */
export async function verifyPublicKey(userId, spkiB64) {
  const pinned = await getPublicKeyPin(userId);

  if (pinned === null) {
    // First contact — pin this key (TOFU)
    await pinPublicKey(userId, spkiB64);
    return 'newly_pinned';
  }

  if (pinned === spkiB64) {
    return 'trusted';
  }

  // Key changed — block and alert
  return 'changed';
}

/**
 * Explicitly update the pin for a user after the user has verified the key
 * change out-of-band (e.g., "I verified — proceed" in the UI).
 *
 * This function must ONLY be called after explicit user confirmation.
 * Never call it automatically in response to a changed-key event.
 */
export async function updatePublicKeyPin(userId, newSpkiB64) {
  await SecureStore.setItemAsync(`${PIN_PREFIX}${userId}`, newSpkiB64);
}

/**
 * Delete the pin for a user (used when a member is revoked and their key
 * should no longer be trusted for future key ceremonies).
 */
export async function deletePublicKeyPin(userId) {
  await SecureStore.deleteItemAsync(`${PIN_PREFIX}${userId}`);
}

/**
 * Verify all keys in a batch (household key list from server).
 * Returns each userId with its verification result.
 * The caller MUST check the results before proceeding with any wrapping.
 */
export async function verifyHouseholdKeys(keys) {
  return Promise.all(
    keys.map(async (k) => ({
      userId: k.userId,
      publicKey: k.publicKey,
      result: await verifyPublicKey(k.userId, k.publicKey),
    }))
  );
}
