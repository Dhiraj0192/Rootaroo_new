import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  StatusBar,
  Platform,
  ActivityIndicator,
  ScrollView,
} from 'react-native';
import { showAlert } from '../shared/services/themedAlert';
import { useAuthStore } from '../shared/store/authStore';
import { authApi } from '../shared/api/auth';
import { colors, fonts, withAlpha } from '../shared/theme';
import { GoldFill } from '../shared/components/GoldButton';
import { KeyboardAvoider, keyboardScrollProps } from '../shared/components/KeyboardAware';
import { useTabBarDockHeight } from '../shared/hooks/useTabBarDockHeight';
export default function AccountDeletionScreen({ navigation }) {
  const logout = useAuthStore((s) => s.logout);
  const dockHeight = useTabBarDockHeight();
  const [password, setPassword] = useState('');
  const [step, setStep] = useState('confirm');
  const [loading, setLoading] = useState(false);
  const handleSchedule = async () => {
    if (!password) {
      showAlert('Error', 'Enter your password to confirm.');
      return;
    }
    setLoading(true);
    try {
      await authApi.scheduleDeletion(password);
      setStep('scheduled');
    } catch (e) {
      const msg = e?.response?.data?.error || 'Failed. Wrong password?';
      showAlert('Error', msg);
    } finally {
      setLoading(false);
    }
  };
  const handleCancel = async () => {
    setLoading(true);
    try {
      await authApi.cancelDeletion();
      showAlert('Cancelled', 'Your account deletion has been cancelled.');
      navigation.goBack();
    } catch (e) {
      const msg = e?.response?.data?.error || 'Failed to cancel.';
      showAlert('Error', msg);
    } finally {
      setLoading(false);
    }
  };
  const handleConfirmImmediate = async () => {
    showAlert(
      'Permanent Deletion',
      'This will immediately delete your account and all data. This cannot be undone.',
      [
        {
          text: 'Cancel',
          style: 'cancel',
        },
        {
          text: 'Delete Forever',
          style: 'destructive',
          onPress: async () => {
            setLoading(true);
            try {
              await authApi.confirmDeletion(password);
              setStep('done');
            } catch (e) {
              const msg = e?.response?.data?.error || 'Deletion failed.';
              showAlert('Error', msg);
            } finally {
              setLoading(false);
            }
          },
        },
      ],
    );
  };
  const handleLogout = () => {
    logout();
  };
  if (step === 'done') {
    return (
      <View style={styles.container}>
        <StatusBar barStyle="light-content" backgroundColor={colors.legacyNavySoft} />
        <View style={styles.inner}>
          <Text style={styles.doneIcon}>{'\u{1F4A5}'}</Text>
          <Text style={styles.doneTitle}>Account Deleted</Text>
          <Text style={styles.doneSub}>
            Your account and all associated data have been permanently removed.
          </Text>
          <TouchableOpacity style={styles.primaryBtn} onPress={handleLogout}>
            <GoldFill radius={10} />
            <Text style={styles.primaryText}>GO BACK TO LOGIN</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }
  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor={colors.canvasSoft} />
      <KeyboardAvoider>
      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: dockHeight + 16 }]}
        {...keyboardScrollProps}
      >
        {step === 'confirm' && (
          <>
            <Text style={styles.dangerIcon}>{'\u26A0\uFE0F'}</Text>
            <Text style={styles.heading}>Delete Account</Text>
            <Text style={styles.warning}>
              This will schedule your account for deletion in 30 days. You can cancel anytime during
              this period. All your data — households, messages, tasks, and documents — will be
              permanently removed.
            </Text>

            <Text style={styles.label}>CONFIRM WITH PASSWORD</Text>
            <TextInput
              style={styles.input}
              value={password}
              onChangeText={setPassword}
              placeholder="Enter your password"
              placeholderTextColor={withAlpha(colors.legacyNavy, 0.2)}
              secureTextEntry
            />

            <TouchableOpacity
              style={styles.dangerBtn}
              onPress={handleSchedule}
              activeOpacity={0.85}
              disabled={loading}
            >
              {loading ? (
                <ActivityIndicator color={colors.onAccent} />
              ) : (
                <Text style={styles.dangerText}>SCHEDULE DELETION</Text>
              )}
            </TouchableOpacity>

            <TouchableOpacity style={styles.linkBtn} onPress={handleConfirmImmediate}>
              <Text style={styles.linkDanger}>Delete immediately instead</Text>
            </TouchableOpacity>

            <TouchableOpacity onPress={() => navigation.goBack()}>
              <Text style={styles.cancelText}>Keep my account</Text>
            </TouchableOpacity>
          </>
        )}

        {step === 'scheduled' && (
          <>
            <Text style={styles.scheduledIcon}>{'\u{1F551}'}</Text>
            <Text style={styles.heading}>Deletion Scheduled</Text>
            <Text style={styles.warning}>
              Your account is scheduled for deletion in 30 days. You can cancel this anytime by
              logging in and visiting this page.
            </Text>

            <TouchableOpacity
              style={styles.primaryBtn}
              onPress={handleCancel}
              activeOpacity={0.85}
              disabled={loading}
            >
              <GoldFill radius={10} disabled={loading} />
              {loading ? (
                <ActivityIndicator color={colors.legacyNavySoft} />
              ) : (
                <Text style={styles.primaryText}>CANCEL DELETION</Text>
              )}
            </TouchableOpacity>

            <TouchableOpacity onPress={() => navigation.goBack()}>
              <Text style={styles.cancelText}>Go back</Text>
            </TouchableOpacity>
          </>
        )}
      </ScrollView>
      </KeyboardAvoider>
    </View>
  );
}
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.canvasSoft,
  },
  inner: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
  },
  scroll: {
    alignItems: 'center',
    paddingTop: Platform.OS === 'ios' ? 80 : 50,
    paddingHorizontal: 28,
    paddingBottom: 40,
  },
  dangerIcon: {
    fontSize: 40,
    marginBottom: 12,
  },
  scheduledIcon: {
    fontSize: 40,
    marginBottom: 12,
  },
  doneIcon: {
    fontSize: 48,
    marginBottom: 12,
  },
  heading: {
    fontFamily: fonts.bodyBold,
    fontSize: 20,
    fontWeight: '700',
    color: colors.legacyNavy,
    textAlign: 'center',
    marginBottom: 10,
  },
  doneTitle: {
    fontFamily: fonts.bodyBold,
    fontSize: 22,
    fontWeight: '700',
    color: colors.legacyNavy,
    textAlign: 'center',
    marginBottom: 8,
  },
  doneSub: {
    fontFamily: fonts.body,
    fontSize: 13,
    color: withAlpha(colors.legacyNavy, 0.4),
    textAlign: 'center',
    lineHeight: 18,
    marginBottom: 24,
  },
  warning: {
    fontFamily: fonts.body,
    fontSize: 13,
    color: withAlpha(colors.legacyNavy, 0.5),
    textAlign: 'center',
    lineHeight: 18,
    marginBottom: 24,
    maxWidth: 300,
  },
  label: {
    fontFamily: fonts.bodySemiBold,
    width: '100%',
    fontSize: 10,
    fontWeight: '600',
    color: withAlpha(colors.legacyNavy, 0.35),
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    marginBottom: 6,
  },
  input: {
    width: '100%',
    height: 44,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: withAlpha(colors.legacyNavy, 0.08),
    borderRadius: 8,
    paddingHorizontal: 14,
    fontSize: 14,
    color: colors.legacyNavy,
    marginBottom: 16,
  },
  primaryBtn: {
    width: '100%',
    height: 46,
    backgroundColor: colors.gold,
    borderRadius: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    marginBottom: 14,
    shadowOpacity: 0,
    shadowRadius: 0,
    elevation: 0,
  },
  primaryText: {
    fontFamily: fonts.bodyBold,
    fontSize: 14,
    fontWeight: '700',
    color: colors.legacyNavySoft,
    letterSpacing: 0.8,
  },
  dangerBtn: {
    width: '100%',
    height: 46,
    backgroundColor: colors.dangerStrong,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10,
  },
  dangerText: {
    fontFamily: fonts.bodyBold,
    fontSize: 14,
    fontWeight: '700',
    color: colors.onAccent,
    letterSpacing: 0.8,
  },
  linkBtn: {
    marginBottom: 14,
  },
  linkDanger: {
    fontFamily: fonts.bodyMedium,
    fontSize: 12,
    fontWeight: '500',
    color: colors.dangerStrong,
  },
  cancelText: {
    fontFamily: fonts.bodyMedium,
    fontSize: 12,
    fontWeight: '500',
    color: withAlpha(colors.legacyNavy, 0.3),
    marginBottom: 8,
  },
});
