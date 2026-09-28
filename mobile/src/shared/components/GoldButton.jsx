import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { colors, fonts, goldButton, radius } from '../theme';

/**
 * The lit gold surface, as an overlay you drop inside a button you already
 * have. Two absolutely-positioned layers, both non-interactive:
 *
 *   the gradient  — the four weighted stops that make it read as metal
 *   the specular  — a 1px lit top edge, standing in for CSS's inset shadow,
 *                   which React Native has no equivalent for
 *
 * Render it as the FIRST child so the label paints on top of it, and pass the
 * host's own `borderRadius` so both layers follow its corners:
 *
 *   <TouchableOpacity style={styles.primaryBtn}>
 *     <GoldFill radius={radius.pill} />
 *     <Text style={styles.primaryBtnText}>Save</Text>
 *   </TouchableOpacity>
 *
 * This is the canonical primary button treatment, app-wide — the exact
 * surface WelcomeScreen's "Get Started" button uses. Onboarding and every
 * in-app primary button now share it; there is no separate "softer" in-app
 * tier any more. `goldButton.glow` is not spread anywhere: the amber
 * drop-shadow was removed app-wide, so this is the gradient + specular edge
 * only, no shadow.
 */
export function GoldFill({ radius: r = radius.pill, disabled = false }) {
  // A disabled button paints its own muted background; laying the gradient
  // over it would erase that and leave a button that looks tappable when it
  // isn't. Render nothing and let the host's disabled style show through.
  if (disabled) return null;
  return (
    <>
      <LinearGradient
        colors={goldButton.colors}
        locations={goldButton.locations}
        start={goldButton.start}
        end={goldButton.end}
        style={[StyleSheet.absoluteFill, { borderRadius: r }]}
        pointerEvents="none"
      />
      <View
        style={[
          StyleSheet.absoluteFill,
          { borderRadius: r, borderTopWidth: 1, borderTopColor: goldButton.specular },
        ]}
        pointerEvents="none"
      />
    </>
  );
}

/**
 * A complete primary button using that surface — for new call sites, so
 * they don't have to re-derive the height, radius, and label treatment.
 * Same canonical `colors.gold` + GoldFill treatment as every other primary
 * button in the app.
 */
export default function GoldButton({
  label,
  onPress,
  disabled,
  style,
  textStyle,
  children,
  ...rest
}) {
  return (
    <TouchableOpacity
      style={[styles.btn, disabled && styles.btnDisabled, style]}
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.85}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      {...rest}
    >
      {!disabled && <GoldFill radius={radius.pill} />}
      {children ?? <Text style={[styles.label, textStyle]}>{label}</Text>}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  btn: {
    width: '100%',
    height: 54,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.gold,
  },
  btnDisabled: {
    backgroundColor: colors.btnDisabledBg,
  },
  label: {
    fontSize: 15.5,
    letterSpacing: -0.15,
    fontFamily: fonts.display,
    color: goldButton.onGold,
  },
});
