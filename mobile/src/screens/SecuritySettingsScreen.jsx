import React, { useEffect } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Switch, StatusBar } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useJournalLockStore } from '../shared/store/journalLockStore';
import { colors, fonts, radius, withAlpha } from '../shared/theme';
import { useTabBarDockHeight } from '../shared/hooks/useTabBarDockHeight';

export default function SecuritySettingsScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const dockHeight = useTabBarDockHeight();
  const enabled = useJournalLockStore((s) => s.enabled);
  const available = useJournalLockStore((s) => s.available);
  const load = useJournalLockStore((s) => s.load);
  const setEnabled = useJournalLockStore((s) => s.setEnabled);

  useEffect(() => {
    if (enabled === null) load();
  }, [enabled, load]);

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <StatusBar barStyle="light-content" backgroundColor={colors.canvas} />
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => navigation.goBack()}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <Text style={styles.backIcon}>‹</Text>
        </TouchableOpacity>
        <View style={styles.headerText}>
          <Text style={styles.headerTitle}>Privacy & security</Text>
        </View>
      </View>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.scrollContent, { paddingBottom: dockHeight + 16 }]}
      >
        <View style={styles.card}>
          <View style={styles.row}>
            <View style={styles.rowText}>
              <Text style={styles.rowLabel}>Lock journal</Text>
              <Text style={styles.rowSub}>
                Ask for Face ID, fingerprint or passcode when opening your journal.
              </Text>
            </View>
            <Switch
              accessibilityLabel="Lock journal"
              value={!!enabled}
              disabled={!available}
              onValueChange={(v) => setEnabled(v)}
              trackColor={{ false: withAlpha(colors.ink, 0.18), true: colors.gold }}
            />
          </View>
          {!available && (
            <Text style={styles.hint}>Set a screen lock on this device to use journal lock.</Text>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 20, paddingTop: 4 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 14 },
  backBtn: {
    width: 42,
    height: 42,
    borderRadius: radius.card,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backIcon: {
    fontSize: 26,
    fontWeight: '700',
    color: colors.ink,
    lineHeight: 28,
    marginLeft: -2,
  },
  headerText: { flex: 1 },
  headerTitle: {
    fontSize: 27,
    lineHeight: 34,
    fontFamily: fonts.display,
    color: colors.ink,
    letterSpacing: -0.4,
  },
  card: {
    marginTop: 14,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderCool,
    borderRadius: radius.xl,
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 10,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  rowText: { flex: 1 },
  rowLabel: { fontSize: 16, fontFamily: fonts.bodySemiBold, color: colors.ink },
  rowSub: { marginTop: 2, fontSize: 13, fontFamily: fonts.body, color: colors.textMuted },
  hint: { fontSize: 13, fontFamily: fonts.body, color: colors.textMuted },
});
