import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  StatusBar,
} from 'react-native';
import { showAlert } from '../shared/services/themedAlert';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { notificationApi } from '../shared/api/notification';
import PreferenceToggle from '../components/PreferenceToggle';
import { colors, fonts } from '../shared/theme';
// Activity group (mock Screen 38)
const ACTIVITY_ROWS = [
  {
    label: 'New tasks',
    key: 'taskAssigned',
  },
  {
    label: 'Task completed',
    key: 'taskCompleted',
  },
  {
    label: 'Feed posts',
    key: 'newPost',
  },
  {
    label: 'Chat messages',
    key: 'chatMessage',
  },
  {
    label: 'New member joined',
    key: 'memberJoined',
  },
];

// Reminders group (mock Screen 38)
const REMINDER_ROWS = [
  {
    label: 'Bill due reminders',
    key: 'newExpense',
  },
  {
    label: 'Check-in alerts',
    key: 'checkIn',
  },
  {
    label: 'Calendar events',
    key: 'calendarEvent',
  },
];

// Tips group: subtitle explains the cap; the server defaults `tips` on.
const TIP_ROWS = [
  {
    label: 'Tips and nudges',
    key: 'tips',
    subtitle: 'Occasional reminders to check in with your family. Max 2 a week.',
  },
];

const ALL_PREF_KEYS = [...ACTIVITY_ROWS, ...REMINDER_ROWS, ...TIP_ROWS].map((row) => row.key);
const DEFAULT_PREFS = {
  tips: true,
  newPost: true,
  taskAssigned: true,
  taskCompleted: true,
  checkIn: true,
  newExpense: true,
  chatMessage: true,
  calendarEvent: true,
  memberJoined: true,
};
// A response without `tips` (older server) means the default, on.
const withDefaults = (prefs) => ({ tips: true, ...prefs });

export default function NotificationPreferencesScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const [prefs, setPrefs] = useState(DEFAULT_PREFS);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    (async () => {
      try {
        setPrefs(withDefaults(await notificationApi.getPreferences()));
      } catch {
        showAlert('Error', 'Could not load notification preferences.');
      } finally {
        setLoading(false);
      }
    })();
  }, []);
  const handleToggle = useCallback(async (key, next) => {
    setPrefs((p) => ({
      ...p,
      [key]: next,
    }));
    try {
      const saved = await notificationApi.updatePreferences({
        [key]: next,
      });
      setPrefs(withDefaults(saved));
    } catch {
      // Revert optimistic update on failure.
      setPrefs((p) => ({
        ...p,
        [key]: !next,
      }));
      showAlert('Error', 'Could not save preference.');
    }
  }, []);
  const allOn = ALL_PREF_KEYS.every((key) => prefs[key]);
  const handleToggleAll = useCallback(
    async (next) => {
      const snapshot = prefs;
      const patch = Object.fromEntries(ALL_PREF_KEYS.map((key) => [key, next]));
      setPrefs((p) => ({ ...p, ...patch }));
      try {
        const saved = await notificationApi.updatePreferences(patch);
        setPrefs(withDefaults(saved));
      } catch {
        setPrefs(snapshot);
        showAlert('Error', 'Could not save preference.');
      }
    },
    [prefs],
  );
  if (loading) {
    return (
      <View
        style={[
          styles.root,
          {
            paddingTop: insets.top,
          },
        ]}
      >
        <ActivityIndicator
          size="large"
          color={colors.gold}
          style={{
            flex: 1,
          }}
        />
      </View>
    );
  }
  return (
    <View
      style={[
        styles.root,
        {
          paddingTop: insets.top,
        },
      ]}
    >
      <StatusBar barStyle="light-content" backgroundColor={colors.canvas} />

      {/* Header (mock Screen 38) */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => navigation.goBack()}
          hitSlop={{
            top: 8,
            bottom: 8,
            left: 8,
            right: 8,
          }}
        >
          <Text style={styles.backIcon}>‹</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Notifications</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.scrollContent,
          {
            paddingBottom: insets.bottom + 40,
          },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {/* Master toggle */}
        <View style={[styles.row, styles.masterRow]}>
          <Text style={styles.masterLabel}>All notifications</Text>
          <PreferenceToggle value={allOn} onChange={handleToggleAll} />
        </View>

        {/* Activity */}
        <Text style={[styles.sectionLabel, styles.sectionLabelGap]}>Activity</Text>
        {ACTIVITY_ROWS.map((row) => (
          <View key={row.key} style={styles.row}>
            <Text style={styles.rowLabel}>{row.label}</Text>
            <PreferenceToggle
              value={prefs[row.key]}
              onChange={(next) => handleToggle(row.key, next)}
            />
          </View>
        ))}

        {/* Reminders */}
        <Text style={[styles.sectionLabel, styles.sectionLabelGap]}>Reminders</Text>
        {REMINDER_ROWS.map((row) => (
          <View key={row.key} style={styles.row}>
            <Text style={styles.rowLabel}>{row.label}</Text>
            <PreferenceToggle
              value={prefs[row.key]}
              onChange={(next) => handleToggle(row.key, next)}
            />
          </View>
        ))}

        {/* Tips */}
        <Text style={[styles.sectionLabel, styles.sectionLabelGap]}>Tips</Text>
        {TIP_ROWS.map((row) => (
          <View key={row.key} style={styles.row}>
            <View style={styles.rowText}>
              <Text style={styles.rowLabel}>{row.label}</Text>
              <Text style={styles.rowSubtitle}>{row.subtitle}</Text>
            </View>
            <PreferenceToggle
              value={prefs[row.key]}
              onChange={(next) => handleToggle(row.key, next)}
            />
          </View>
        ))}
      </ScrollView>
    </View>
  );
}
const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.canvas,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 24,
    paddingTop: 12,
  },
  // Header (mock Screen 38)
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: 56,
    paddingHorizontal: 24,
  },
  backBtn: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backIcon: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.ink,
    lineHeight: 26,
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: '700',
    fontFamily: fonts.displayBold,
    color: colors.ink,
  },
  headerSpacer: {
    width: 32,
  },
  // Section label
  sectionLabel: {
    fontSize: 11,
    fontWeight: '600',
    fontFamily: fonts.bodySemiBold,
    letterSpacing: 0.4,
    color: colors.textMuted,
    marginBottom: 14,
  },
  sectionLabelGap: {
    marginTop: 26,
    marginBottom: 14,
  },
  // Toggle row
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  rowText: {
    flex: 1,
    paddingRight: 16,
  },
  rowLabel: {
    fontSize: 14,
    fontFamily: fonts.body,
    color: colors.ink,
  },
  rowSubtitle: {
    marginTop: 4,
    fontSize: 12,
    fontFamily: fonts.body,
    color: colors.textMuted,
  },
  // Master "All notifications" toggle
  masterRow: {
    borderBottomWidth: 0,
  },
  masterLabel: {
    fontSize: 15,
    fontFamily: fonts.bodySemiBold,
    fontWeight: '600',
    color: colors.ink,
  },
});
