import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { colors, fonts } from '../../../shared/theme';

// Screens a paywalled user can still open. Each is registered in PaywallNavigator and only
// calls household/auth APIs, which sit outside requireEntitlement on the server.
export const PAYWALL_MENU = [
  { label: 'Household settings', screen: 'HouseholdSettings' },
  { label: 'Profile and account', screen: 'EditProfile' },
  { label: 'Delete account', screen: 'AccountDeletion' },
  { label: 'Help center', screen: 'HelpCenter' },
  { label: 'Privacy policy', screen: 'PrivacyPolicy' },
];

export default function PaywallMenu({ navigation }) {
  return (
    <View style={styles.menu}>
      {PAYWALL_MENU.map((item) => (
        <TouchableOpacity
          key={item.screen}
          style={styles.row}
          onPress={() => navigation?.navigate(item.screen)}
          accessibilityRole="button"
          accessibilityLabel={item.label}
        >
          <Text style={styles.rowText}>{item.label}</Text>
          <Text style={styles.chevron}>›</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  menu: { marginTop: 28, backgroundColor: colors.canvasGray, borderRadius: 18, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 14, paddingHorizontal: 18, borderBottomWidth: 1, borderBottomColor: colors.canvas },
  rowText: { fontFamily: fonts.bodySemiBold, color: colors.ink, fontSize: 15 },
  chevron: { fontFamily: fonts.bodyBold, color: colors.textMuted, fontSize: 18 },
});
