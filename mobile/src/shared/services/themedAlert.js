let _handler = null;

/** Called once by AlertHost on mount. */
export function registerAlertHandler(fn) {
  _handler = fn;
}

/** True once the AlertHost is mounted and an alert would actually show. */
export function canShowAlert() {
  return _handler !== null;
}

/**
 * Themed drop-in replacement for React Native's `Alert.alert`. Same
 * (title, message, buttons) signature, rendered as the app's own glass/gold
 * bottom sheet (AlertModal) instead of native OS chrome.
 */
export function showAlert(title, message, buttons) {
  if (!_handler) {
    if (__DEV__) console.warn('showAlert called before AlertHost mounted');
    return;
  }
  _handler(title, message, buttons);
}
