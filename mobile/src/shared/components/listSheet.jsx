import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Modal,
  FlatList,
  Animated,
  Easing,
  KeyboardAvoidingView,
  Pressable,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, fonts, withAlpha } from '../theme';
import Avatar from '../../components/Avatar';
import { KEYBOARD_BEHAVIOR } from './KeyboardAware';

// Bottom-sheet pieces shared by the Grocery and To-do list screens.

const OPEN_FADE_MS = 220;
const CLOSE_MS = 200;

/**
 * A sheet that glides up from the bottom while its backdrop fades in, and
 * slides back down before unmounting. (`<Modal animationType="slide">`
 * moves the whole window — backdrop included — as one rigid block.)
 * Sized to its content, capped at 85% of the screen.
 */
export function BottomSheet({ visible, onClose, children, style }) {
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const [mounted, setMounted] = useState(visible);
  const translateY = useRef(new Animated.Value(height)).current;
  const backdrop = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      setMounted(true);
      translateY.setValue(height);
      backdrop.setValue(0);
      Animated.parallel([
        Animated.timing(backdrop, {
          toValue: 1,
          duration: OPEN_FADE_MS,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.spring(translateY, {
          toValue: 0,
          damping: 22,
          stiffness: 220,
          mass: 1,
          overshootClamping: true,
          useNativeDriver: true,
        }),
      ]).start();
    } else if (mounted) {
      Animated.parallel([
        Animated.timing(backdrop, {
          toValue: 0,
          duration: CLOSE_MS,
          useNativeDriver: true,
        }),
        Animated.timing(translateY, {
          toValue: height,
          duration: CLOSE_MS,
          easing: Easing.in(Easing.quad),
          useNativeDriver: true,
        }),
      ]).start(() => setMounted(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  if (!mounted) return null;
  return (
    <Modal
      visible
      transparent
      animationType="none"
      /* RN Modals render in their own native window, which on Android does
         not receive keyboard insets unless these are set — without them the
         avoider below computes a zero offset and the sheet never lifts. */
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}
    >
      {/* The avoider is the full-screen root: `height` shrinks this container
          so the flex-end sheet slides up above the keyboard. */}
      <KeyboardAvoidingView style={sheet.overlay} behavior={KEYBOARD_BEHAVIOR}>
        <Animated.View style={[sheet.backdrop, { opacity: backdrop }]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        </Animated.View>
        <Animated.View
          style={[
            sheet.box,
            { paddingBottom: insets.bottom + 20, transform: [{ translateY }] },
            style,
          ]}
        >
          {children}
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export function Field({ label, children }) {
  return (
    <View style={fieldStyles.field}>
      <Text style={fieldStyles.label}>{label}</Text>
      {children}
    </View>
  );
}

/** Household member picker; tapping the selected member again clears it. */
export function AssigneePickerSheet({ visible, members, selectedId, onSelect, onClose }) {
  return (
    <BottomSheet visible={visible} onClose={onClose}>
      <View style={sheet.pickHeader}>
        <TouchableOpacity onPress={onClose} hitSlop={8}>
          <Text style={sheet.closeText}>Close</Text>
        </TouchableOpacity>
        <Text style={sheet.pickTitle}>Assignee</Text>
        <View style={{ minWidth: 44 }} />
      </View>
      <FlatList
        style={sheet.scroll}
        data={members}
        keyExtractor={(item) => item.userId}
        renderItem={({ item }) => {
          const sel = selectedId === item.userId;
          return (
            <TouchableOpacity
              style={[sheet.memberRow, sel && sheet.memberRowActive]}
              onPress={() => {
                onSelect(sel ? null : item.userId);
                onClose();
              }}
              activeOpacity={0.7}
            >
              <Avatar
                url={item.avatarUrl}
                emoji={item.avatarEmoji}
                name={item.displayName}
                id={item.userId}
                size={40}
              />
              <Text style={sheet.memberName}>{item.displayName}</Text>
              {sel && <Text style={sheet.memberCheck}>✓</Text>}
            </TouchableOpacity>
          );
        }}
      />
    </BottomSheet>
  );
}

const fieldStyles = StyleSheet.create({
  field: {
    marginBottom: 14,
  },
  label: {
    fontSize: 11,
    fontWeight: '600',
    fontFamily: fonts.bodySemiBold,
    letterSpacing: 0.4,
    color: colors.textSecondary,
    marginBottom: 7,
  },
});

export const sheet = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: withAlpha(colors.shadow, 0.55),
  },
  box: {
    backgroundColor: colors.canvasElevated,
    borderTopLeftRadius: 32,
    borderTopRightRadius: 32,
    borderWidth: 1,
    borderColor: colors.border,
    borderBottomWidth: 0,
    paddingTop: 14,
    paddingHorizontal: 24,
    /* Hugs its content; the cap only matters for long content or when the
       keyboard squeezes it — then sheet.scroll (flexShrink) gives way and
       scrolls instead of the sheet running off screen. */
    maxHeight: '85%',
  },
  scroll: {
    flexGrow: 0,
    flexShrink: 1,
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
    alignSelf: 'center',
    marginBottom: 18,
  },
  title: {
    fontSize: 17,
    fontWeight: '600',
    fontFamily: fonts.displayBold,
    color: colors.ink,
    textAlign: 'center',
    marginBottom: 18,
  },
  pickHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
  },
  closeText: {
    fontSize: 15,
    fontWeight: '500',
    fontFamily: fonts.bodyMedium,
    color: colors.goldDeep,
    minWidth: 44,
  },
  pickTitle: {
    fontSize: 16,
    fontWeight: '600',
    fontFamily: fonts.displayBold,
    color: colors.ink,
  },
  memberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
  },
  memberRowActive: {
    opacity: 0.7,
  },
  memberName: {
    flex: 1,
    fontSize: 15,
    fontWeight: '600',
    fontFamily: fonts.bodySemiBold,
    color: colors.ink,
  },
  memberCheck: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.goldDeep,
  },
});
