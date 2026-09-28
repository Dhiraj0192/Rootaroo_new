import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Dimensions } from 'react-native';
import { colors, fonts, goldButton, radius } from '../theme';
import { GoldFill } from './GoldButton';

const { width: SCREEN_W } = Dimensions.get('window');

// Tooltip content for a react-native-spotlight-tour step. The library only
// positions this box (via floating-ui); every visual detail — card, dots,
// buttons — is ours, matching the app's existing navy-glass tour design.
export default function TourTooltip({ title, body, total, current, isLast, next, stop, continueLabel, onContinue }) {
  return (
    <View style={styles.tooltip}>
      <View style={styles.dotsRow}>
        {Array.from({ length: total }).map((_, i) => (
          <View key={i} style={[styles.dot, i === current && styles.dotActive]} />
        ))}
      </View>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.body}>{body}</Text>
      <View style={styles.controlsRow}>
        <TouchableOpacity onPress={stop} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Text style={styles.skipText}>Skip</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.nextButton}
          activeOpacity={0.85}
          onPress={continueLabel ? onContinue : next}
        >
          <GoldFill radius={radius.pill} />
          <Text style={styles.nextText}>{continueLabel ?? (isLast ? 'Done' : 'Next')}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  tooltip: {
    width: SCREEN_W - 48,
    backgroundColor: colors.canvasElevated,
    borderRadius: radius.cardLg,
    padding: 18,
    shadowColor: colors.shadow,
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.35,
    shadowRadius: 24,
    elevation: 10,
  },
  dotsRow: {
    flexDirection: 'row',
    gap: 6,
    marginBottom: 12,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.divider,
  },
  dotActive: {
    width: 20,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.gold,
  },
  title: {
    fontFamily: fonts.displayBold,
    fontSize: 17,
    color: colors.ink,
    marginBottom: 6,
  },
  body: {
    fontFamily: fonts.body,
    fontSize: 13.5,
    lineHeight: 19,
    color: colors.textSecondary,
    marginBottom: 14,
  },
  controlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  skipText: {
    fontFamily: fonts.bodyMedium,
    fontSize: 13,
    color: colors.textSecondary,
  },
  nextButton: {
    height: 40,
    paddingHorizontal: 22,
    backgroundColor: colors.gold,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    ...goldButton.glow,
  },
  nextText: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 14,
    color: goldButton.onGold,
  },
});
