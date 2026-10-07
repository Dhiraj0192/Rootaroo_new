import React from 'react';
import { Text, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useBillingStore } from '../../shared/store/billingStore';
import { useAuthStore } from '../../shared/store/authStore';
import PaywallMenu from './components/PaywallMenu';
import { colors, fonts } from '../../shared/theme';

export default function PaywallMemberScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const admins = useBillingStore((s) => s.status?.adminNames ?? []);
  const refresh = useBillingStore((s) => s.refresh);
  const who = admins.length > 0 ? admins.join(' or ') : 'your household admin';
  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ paddingTop: insets.top + 60, paddingBottom: insets.bottom + 24, paddingHorizontal: 24 }}>
      <Text style={styles.title}>{`Ask ${who} to renew Rootaroo`}</Text>
      <Text style={styles.sub}>Your household's subscription has ended. Everything is saved and comes back as soon as it's renewed.</Text>
      <TouchableOpacity style={styles.cta} onPress={() => refresh()} accessibilityRole="button">
        <Text style={styles.ctaText}>Retry</Text>
      </TouchableOpacity>
      <PaywallMenu navigation={navigation} />
      <TouchableOpacity onPress={() => useAuthStore.getState().logout()}><Text style={styles.link}>Sign out</Text></TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.canvas },
  title: { fontFamily: fonts.display, color: colors.ink, fontSize: 24, fontWeight: '800' },
  sub: { fontFamily: fonts.bodySemiBold, color: colors.textSecondary, marginTop: 12 },
  cta: { marginTop: 32, backgroundColor: colors.gold, borderRadius: 99, paddingVertical: 15, alignItems: 'center' },
  ctaText: { fontFamily: fonts.bodyBold, color: colors.canvas, fontSize: 16, fontWeight: '800' },
  link: { fontFamily: fonts.bodyBold, color: colors.textMuted, marginTop: 20, textAlign: 'center' },
});
