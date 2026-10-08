import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useBillingStore, selectGate } from '../../../shared/store/billingStore';
import { openBillingPortal } from '../../../shared/billing/purchase';
import { colors, fonts } from '../../../shared/theme';

/** Section 7.4: shown over MainTabs while a failed renewal is in its grace period. */
export default function GraceBanner() {
  const insets = useSafeAreaInsets();
  const gate = useBillingStore(selectGate);
  const status = useBillingStore((s) => s.status);
  const [hidden, setHidden] = useState(false);
  if (gate !== 'grace' || hidden) return null;
  const until = status?.entitlement?.graceUntil ? new Date(status.entitlement.graceUntil).toLocaleDateString() : 'soon';
  return (
    <View style={[styles.wrap, { paddingTop: insets.top + 6 }]} accessibilityRole="alert">
      <Text style={styles.text}>{`Payment failed. Access ends ${until}.`}</Text>
      {status?.isAdmin ? (
        <TouchableOpacity onPress={() => openBillingPortal().catch(() => {})} accessibilityRole="button"><Text style={styles.action}>Fix payment</Text></TouchableOpacity>
      ) : null}
      <TouchableOpacity onPress={() => setHidden(true)} accessibilityLabel="Hide"><Text style={styles.close}>×</Text></TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 50, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingBottom: 8, backgroundColor: colors.danger },
  text: { flex: 1, fontFamily: fonts.bodyBold, color: colors.white, fontSize: 13 },
  action: { fontFamily: fonts.bodyBold, color: colors.white, textDecorationLine: 'underline' },
  close: { color: colors.white, fontSize: 20 },
});
