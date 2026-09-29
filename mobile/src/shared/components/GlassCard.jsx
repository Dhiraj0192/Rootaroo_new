import React from 'react';
import { View, StyleSheet, TouchableOpacity } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { colors, withAlpha } from '../theme';

/**
 * The app's one goldish-glass recipe — consolidated out of DashboardScreen's
 * local `Card`/`CardSheen` (its most mature implementation) so every screen
 * reaches for the same component instead of re-deriving the effect.
 *
 * A GlassCard is: a translucent dark-glass panel (`colors.surface` fill,
 * `colors.border` rim) with a diagonal sheen gradient laid over it. The sheen
 * `tone` is the accent knob:
 *
 *   neutral → faint white sheen. The default "this is a card" surface.
 *   gold    → warm honey sheen. Reserve for the ONE most important panel on
 *             a screen — a featured/highlight card, a hero stat, a premium
 *             call-to-action. Using it on every card erases the hierarchy it
 *             exists to create.
 *   blue    → cool navy-to-gold sheen. For hero/streak-style panels that want
 *             depth without reading as "the gold one."
 *
 * Text/icons placed on top should keep using the normal on-dark tokens
 * (`colors.ink`, `colors.textSecondary`, …) — the sheen is a background
 * effect only and never touches foreground contrast.
 */
const SHEEN = {
  neutral: [withAlpha(colors.white, 0.11), withAlpha(colors.white, 0.025)],
  gold: [withAlpha(colors.goldGlow, 0.18), withAlpha(colors.goldGlow, 0.035)],
  blue: [withAlpha(colors.navyLift, 0.55), withAlpha(colors.goldGlow, 0.06)],
};

export function GlassSheen({ radius = 22, tone = 'neutral' }) {
  return (
    <LinearGradient
      colors={SHEEN[tone] || SHEEN.neutral}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={[StyleSheet.absoluteFill, { borderRadius: radius }]}
      pointerEvents="none"
    />
  );
}

export default function GlassCard({ children, style, radius = 22, tone = 'neutral', onPress, ...rest }) {
  const Wrapper = onPress ? TouchableOpacity : View;
  return (
    <Wrapper
      style={[styles.card, { borderRadius: radius }, style]}
      onPress={onPress}
      activeOpacity={onPress ? 0.8 : undefined}
      {...rest}
    >
      <GlassSheen radius={radius} tone={tone} />
      {children}
    </Wrapper>
  );
}

// Slightly more subtle than the app-wide `colors.surface`/`colors.border` —
// this is the exact fill/rim Dashboard's cards were tuned with (its glass
// panels are the most refined in the app), kept as-is rather than snapped to
// the generic tokens so consolidating call sites onto this component doesn't
// shift anyone's existing look.
const GLASS_FILL = withAlpha(colors.white, 0.045);
const GLASS_BORDER = withAlpha(colors.white, 0.09);

const styles = StyleSheet.create({
  card: {
    backgroundColor: GLASS_FILL,
    borderWidth: 1,
    borderColor: GLASS_BORDER,
    padding: 22,
    // No shadow/elevation: Android draws it through the see-through fill as
    // a faint inner box.
  },
});
