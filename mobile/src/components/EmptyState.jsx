import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { colors, fonts, radius, spacing } from '../shared/theme';
import { GoldFill } from '../shared/components/GoldButton';

/**
 * Centered empty state (design: 09-States-Errors — Empty Feed/Tasks/Vault).
 * 64px icon tile + title + subtitle + optional gold CTA pill.
 */
export default function EmptyState({ icon, title, subtitle, actionLabel, onAction, dark }) {
  return (
    <View style={styles.wrap}>
      <View style={[styles.iconTile, dark && styles.iconTileDark]}>{icon}</View>
      <Text style={[styles.title, dark && styles.titleDark]}>{title}</Text>
      <Text style={[styles.subtitle, dark && styles.subtitleDark]}>{subtitle}</Text>
      {actionLabel && onAction ? (
        <TouchableOpacity style={styles.action} onPress={onAction} activeOpacity={0.85}>
          <GoldFill radius={radius.pill} />
          <Text style={styles.actionText}>{actionLabel}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 48,
    paddingVertical: spacing.xxxl,
  },
  iconTile: {
    width: 64,
    height: 64,
    borderRadius: radius.cardLg,
    backgroundColor: colors.skeleton,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 26,
  },
  iconTileDark: { backgroundColor: colors.surfaceRaised },
  title: {
    fontSize: 21,
    lineHeight: 27,
    fontWeight: '700',
    fontFamily: fonts.displayBold,
    color: colors.ink,
    marginBottom: 10,
    textAlign: 'center',
  },
  titleDark: { color: colors.onAccent },
  subtitle: {
    fontSize: 14,
    lineHeight: 21,
    fontFamily: fonts.body,
    color: colors.textSecondary,
    marginBottom: 30,
    textAlign: 'center',
  },
  subtitleDark: { color: colors.textMutedDark },
  action: {
    height: 54,
    paddingHorizontal: 32,
    borderRadius: radius.pill,
    backgroundColor: colors.gold,
    alignItems: 'center',
    justifyContent: 'center',
    shadowOpacity: 0,
    shadowRadius: 0,
    elevation: 0,
  },
  actionText: {
    fontSize: 15,
    fontWeight: '600',
    fontFamily: fonts.displayBold,
    color: colors.onAccent,
  },
});
