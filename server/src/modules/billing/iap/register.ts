import { registerAppleDispatcher } from './appleEvents';

/** Providers' event processors, attached to the shared billing worker. Idempotent. */
export function registerIapDispatchers(): void {
  registerAppleDispatcher();
}
