import React from 'react';
import { View, Text, StyleSheet, Modal, Pressable, TouchableOpacity } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SvgXml } from 'react-native-svg';
import { colors, fonts, goldButton, radius, spacing, withAlpha } from '../shared/theme';
import { GoldFill } from '../shared/components/GoldButton';

const INFO_SVG =
  '<svg width="24" height="24" viewBox="0 0 24 24" fill="none">' +
  `<circle cx="12" cy="12" r="9" stroke="${colors.gold}" stroke-width="1.5"></circle>` +
  `<path d="M12 11v5M12 8h.01" stroke="${colors.gold}" stroke-width="1.5" stroke-linecap="round"></path>` +
  '</svg>';

const WARNING_SVG =
  '<svg width="24" height="24" viewBox="0 0 24 24" fill="none">' +
  `<path d="M12 4l9 16H3l9-16Z" stroke="${colors.danger}" stroke-width="1.5" stroke-linejoin="round"></path>` +
  `<path d="M12 10v4M12 17h.01" stroke="${colors.danger}" stroke-width="1.5" stroke-linecap="round"></path>` +
  '</svg>';

/**
 * Themed drop-in replacement for React Native's native Alert — same
 * (title, message, buttons) shape, rendered as the app's own glass/gold
 * bottom sheet instead of OS chrome. See ConfirmSheet for the single-action
 * confirmation variant this generalizes.
 */
export default function AlertModal({ visible, title, message, buttons, onRequestClose }) {
  const insets = useSafeAreaInsets();
  const list = buttons && buttons.length ? buttons : [{ text: 'OK', style: 'default' }];
  const hasDestructive = list.some((b) => b.style === 'destructive');

  return (
    <Modal visible={!!visible} transparent animationType="slide" onRequestClose={onRequestClose}>
      <Pressable style={styles.overlay} onPress={onRequestClose}>
        <Pressable style={[styles.sheet, { paddingBottom: insets.bottom + 24 }]}>
          <View style={styles.handle} />
          <View style={[styles.iconCircle, !hasDestructive && styles.iconCircleNeutral]}>
            <SvgXml xml={hasDestructive ? WARNING_SVG : INFO_SVG} width={24} height={24} />
          </View>
          {!!title && <Text style={styles.title}>{title}</Text>}
          {!!message && <Text style={styles.message}>{message}</Text>}
          <View style={styles.buttons}>
            {list.map((btn, i) => {
              const isCancel = btn.style === 'cancel';
              const isDestructive = btn.style === 'destructive';
              return (
                <TouchableOpacity
                  key={`${btn.text}-${i}`}
                  style={[
                    styles.btn,
                    isCancel ? styles.btnCancel : isDestructive ? styles.btnDanger : styles.btnGold,
                  ]}
                  onPress={() => {
                    onRequestClose();
                    btn.onPress && btn.onPress();
                  }}
                  activeOpacity={0.85}
                >
                  {!isCancel && !isDestructive && <GoldFill radius={radius.pill} />}
                  <Text style={[styles.btnText, isCancel && styles.btnTextCancel]}>{btn.text}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: withAlpha(colors.shadow, 0.55), justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.canvas,
    borderTopLeftRadius: 32,
    borderTopRightRadius: 32,
    borderWidth: 1,
    borderColor: colors.border,
    borderBottomWidth: 0,
    paddingHorizontal: 24,
    paddingTop: 26,
    alignItems: 'center',
    shadowColor: colors.shadow,
    shadowOffset: { width: 0, height: -8 },
    shadowOpacity: 0.14,
    shadowRadius: 40,
    elevation: 12,
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
    marginBottom: 26,
  },
  iconCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.blushPale,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 22,
  },
  iconCircleNeutral: { backgroundColor: colors.sagePale },
  title: {
    fontSize: 19,
    lineHeight: 25,
    fontWeight: '700',
    fontFamily: fonts.displayBold,
    color: colors.ink,
    marginBottom: 10,
    textAlign: 'center',
  },
  message: {
    fontSize: 14,
    lineHeight: 21,
    fontFamily: fonts.body,
    color: colors.textSecondary,
    marginBottom: 28,
    textAlign: 'center',
  },
  buttons: { width: '100%', gap: spacing.md },
  btn: {
    width: '100%',
    height: 54,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnGold: {
    backgroundColor: colors.gold,
    ...goldButton.glow,
  },
  btnDanger: {
    backgroundColor: colors.danger,
    shadowColor: colors.danger,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.24,
    shadowRadius: 20,
    elevation: 6,
  },
  btnCancel: {
    backgroundColor: colors.surface,
    borderWidth: 1.5,
    borderColor: colors.border,
  },
  btnText: {
    fontSize: 15,
    fontWeight: '600',
    fontFamily: fonts.displayBold,
    color: goldButton.onGold,
  },
  btnTextCancel: { color: colors.ink },
});
