import { chooseRootView } from '../gate';

describe('chooseRootView (7.4)', () => {
  it.each([
    [false, 'blocked', 'auth'], [true, 'blocked', 'paywall'], [true, 'allowed', 'main'],
    [true, 'grace', 'main'], [true, 'unknown', 'main'],
  ])('auth=%s gate=%s -> %s', (isAuthenticated, gate, view) => expect(chooseRootView({ isAuthenticated, gate })).toBe(view));
});
