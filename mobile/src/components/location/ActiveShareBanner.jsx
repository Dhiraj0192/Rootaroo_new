import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { colors, fonts, radius } from '../../shared/theme';
import { formatRemaining } from '../../shared/location/sharePresets';

const FOREGROUND_WARNING =
  'Keep Rootaroo open to keep sharing. Allow "Always" location in Settings to share in the background.';

export default function ActiveShareBanner({ share, now = Date.now(), mode, onStop, style }) {
  if (!share) return null;
  return (
    <View style={[styles.card, style]}>
      <View style={styles.row}>
        <Text style={styles.text} numberOfLines={1}>
          {`Sharing your location · ${formatRemaining(share.expiresAt, now)}`}
        </Text>
        <TouchableOpacity onPress={onStop} accessibilityLabel="Stop sharing" activeOpacity={0.8} hitSlop={8}>
          <Text style={styles.stop}>Stop</Text>
        </TouchableOpacity>
      </View>
      {mode === 'foreground' && <Text style={styles.warning}>{FOREGROUND_WARNING}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.canvasSoft,
    borderRadius: radius.card,
    borderWidth: 1.5,
    borderColor: colors.gold,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  text: { flex: 1, fontFamily: fonts.bodySemiBold, fontSize: 13, color: colors.ink, marginRight: 10 },
  stop: { fontFamily: fonts.bodySemiBold, fontSize: 13, color: colors.dangerOnDark },
  warning: { fontFamily: fonts.body, fontSize: 12, lineHeight: 16, color: colors.textSecondary, marginTop: 6 },
});
