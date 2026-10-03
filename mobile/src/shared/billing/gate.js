/**
 * Section 7.4: a signed-in member whose entitlement is not allowed gets the paywall.
 * Unknown (first launch, offline) is not blocked: the server's 402 decides.
 */
export function chooseRootView({ isAuthenticated, gate }) {
  if (!isAuthenticated) return 'auth';
  return gate === 'blocked' ? 'paywall' : 'main';
}
