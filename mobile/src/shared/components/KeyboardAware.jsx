import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Keyboard,
  LayoutAnimation,
  Platform,
  ScrollView,
  StyleSheet,
  TouchableWithoutFeedback,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * ═══════════════════════════════════════════════════════════════════
 *  Centralised keyboard handling — the single place this app decides
 *  how the keyboard interacts with layout. Change it here, every
 *  screen follows.
 * ═══════════════════════════════════════════════════════════════════
 *
 * WHY ANDROID ALSO NEEDS AN EXPLICIT AVOIDER NOW
 *
 * The long-standing recipe in this codebase was:
 *
 *     behavior={Platform.OS === 'ios' ? 'padding' : undefined}
 *
 * which relied on Android's `windowSoftInputMode="adjustResize"` shrinking
 * the window so content moved on its own. Expo SDK 54 turns Android
 * edge-to-edge ON by default and it can no longer be disabled (the
 * `edgeToEdgeEnabled` flag is removed in SDK 55). Under edge-to-edge the
 * window is NOT resized when the keyboard opens — the keyboard simply
 * draws over the app. `behavior={undefined}` makes KeyboardAvoidingView a
 * literal no-op, so on Android those screens now do nothing at all.
 *
 * Android therefore needs the same explicit avoidance iOS always did.
 *
 * Docs: https://docs.expo.dev/guides/keyboard-handling/
 *       https://docs.expo.dev/versions/v54.0.0/config/app/
 */

/**
 * The one knob. If a platform ever needs re-tuning, change it here only.
 *
 * iOS   → 'padding' pads the bottom of the avoider by the keyboard height.
 * Android → 'height' shrinks the avoider to the space left above the
 *           keyboard. Preferred over 'padding' here because most screens in
 *           this app pin a footer/CTA with `marginTop:'auto'` or
 *           `justifyContent:'space-between'`, which only reflows correctly
 *           when the container itself gets shorter.
 */
export const KEYBOARD_BEHAVIOR = Platform.OS === 'ios' ? 'padding' : 'height';

/**
 * Props to spread onto a screen's EXISTING ScrollView / FlatList / SectionList
 * so we never nest a second scroller just to get keyboard behaviour.
 *
 * - keyboardShouldPersistTaps 'handled' → a tap on a button while the keyboard
 *   is open fires that button instead of being swallowed by the dismiss.
 * - keyboardDismissMode → drag the list down to dismiss (interactive on iOS).
 */
export const keyboardScrollProps = {
  keyboardShouldPersistTaps: 'handled',
  keyboardDismissMode: Platform.OS === 'ios' ? 'interactive' : 'on-drag',
};

/**
 * <KeyboardAvoider> — wrap a screen that ALREADY has its own ScrollView,
 * FlatList, or a pinned footer/input bar. Adds avoidance without adding a
 * scroll container.
 *
 * `offset` should be the height of any fixed chrome above the avoider. This
 * app sets `headerShown: false` on every navigator, so 0 is correct almost
 * everywhere and is the default.
 */
export function KeyboardAvoider({ children, style, offset = 0, behavior, ...rest }) {
  return (
    <KeyboardAvoidingView
      style={[styles.flex, style]}
      behavior={behavior ?? KEYBOARD_BEHAVIOR}
      keyboardVerticalOffset={offset}
      {...rest}
    >
      {children}
    </KeyboardAvoidingView>
  );
}

/**
 * <KeyboardAwareScrollView> — for screens that have NO scroller of their own.
 * Gives them one, so a short form can still scroll once the keyboard steals
 * half the screen. Content grows to fill the viewport when it is short, which
 * keeps `marginTop:'auto'` footers pinned to the bottom as before.
 */
export function KeyboardAwareScrollView({
  children,
  style,
  contentContainerStyle,
  offset = 0,
  ...rest
}) {
  return (
    <KeyboardAvoider offset={offset} style={style}>
      <ScrollView
        style={styles.flex}
        contentContainerStyle={[styles.grow, contentContainerStyle]}
        showsVerticalScrollIndicator={false}
        {...keyboardScrollProps}
        {...rest}
      >
        {children}
      </ScrollView>
    </KeyboardAvoider>
  );
}

/**
 * <KeyboardFooterScreen> — a scrolling page with a fixed bottom action
 * (Continue / Verify / Save) that must sit in the SAME place every time the
 * keyboard isn't up, and ride just above it when it is.
 *
 * Why not KeyboardAvoidingView: in 'height' mode it measures the screen
 * once, and under edge-to-edge (no window resize) the height it restores
 * after the keyboard closes isn't the one it started with — so a footer
 * pinned under it lands somewhere new after the first keystroke. Here the
 * footer is outside the scroller and only ever moves by the keyboard's
 * *measured* overlap with this view, which is right whether or not the
 * window resizes, and goes back to exactly 0 when the keyboard hides.
 */
const FOOTER_REST_GAP = 28; // above the nav bar / home indicator
const FOOTER_KEYBOARD_GAP = 12; // above the keyboard

export function KeyboardFooterScreen({
  children,
  footer,
  style,
  contentContainerStyle,
  footerStyle,
  ...scrollProps
}) {
  const insets = useSafeAreaInsets();
  const rootRef = useRef(null);
  const [overlap, setOverlap] = useState(0);

  const apply = useCallback((next) => {
    setOverlap((prev) => {
      if (Math.abs(prev - next) < 1) return prev;
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      return next;
    });
  }, []);

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const onShow = (e) => {
      const keyboardTop = e?.endCoordinates?.screenY;
      if (!rootRef.current || typeof keyboardTop !== 'number') return;
      rootRef.current.measureInWindow((_x, y, _w, h) => {
        apply(Math.max(0, y + h - keyboardTop));
      });
    };
    const subs = [
      Keyboard.addListener(showEvent, onShow),
      Keyboard.addListener(hideEvent, () => apply(0)),
    ];
    return () => subs.forEach((sub) => sub.remove());
  }, [apply]);

  const footerPad = overlap > 0 ? overlap + FOOTER_KEYBOARD_GAP : insets.bottom + FOOTER_REST_GAP;

  return (
    <View ref={rootRef} style={[styles.flex, style]} collapsable={false}>
      <ScrollView
        style={styles.flex}
        contentContainerStyle={[styles.grow, contentContainerStyle]}
        showsVerticalScrollIndicator={false}
        {...keyboardScrollProps}
        {...scrollProps}
      >
        {children}
      </ScrollView>
      {footer ? <View style={[footerStyle, { paddingBottom: footerPad }]}>{footer}</View> : null}
    </View>
  );
}

/**
 * <DismissKeyboardView> — tap anywhere that isn't an input to close the
 * keyboard. Only for screens with no scroller (a scroller already gets this
 * via keyboardDismissMode). `accessible={false}` keeps the wrapper out of the
 * screen-reader tree so it doesn't swallow the real controls.
 */
export function DismissKeyboardView({ children, style }) {
  return (
    <TouchableWithoutFeedback accessible={false} onPress={Keyboard.dismiss}>
      <View style={[styles.flex, style]}>{children}</View>
    </TouchableWithoutFeedback>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  grow: { flexGrow: 1 },
});
