import { registerAppleDispatcher } from './appleEvents';
import { registerGoogleDispatcher } from './googleEvents';

/** Providers' event processors, attached to the shared billing worker. Idempotent. */
export function registerIapDispatchers(): void {
  registerAppleDispatcher();
  registerGoogleDispatcher();
}
