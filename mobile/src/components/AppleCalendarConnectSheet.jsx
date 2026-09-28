import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  Pressable,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Linking,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, fonts, radius, spacing, withAlpha } from '../shared/theme';
import { GoldFill } from '../shared/components/GoldButton';

const APP_PASSWORD_HELP_URL = 'https://appleid.apple.com/account/manage';

/**
 * Apple Calendar has no OAuth redirect the way Google/Outlook do — CalDAV
 * auth is an Apple ID + an app-specific password the user generates
 * themselves. This is a form/bottom-sheet instead of a single "Connect"
 * button + browser redirect, unavoidably a different shape from the other
 * two providers' connect flow.
 */
export default function AppleCalendarConnectSheet({ visible, loading, onSubmit, onCancel }) {
  const insets = useSafeAreaInsets();
  const [appleId, setAppleId] = useState('');
  const [appSpecificPassword, setAppSpecificPassword] = useState('');

  const canSubmit = appleId.trim().length > 0 && appSpecificPassword.trim().length > 0 && !loading;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
      <Pressable style={styles.overlay} onPress={onCancel}>
        <Pressable style={[styles.sheet, { paddingBottom: insets.bottom + 44 }]}>
          <View style={styles.handle} />
          <Text style={styles.title}>Connect Apple Calendar</Text>
          <Text style={styles.subtitle}>
            Sign in with your Apple ID and an app-specific password — not your regular Apple ID password.
          </Text>

          <Text style={styles.fieldLabel}>Apple ID</Text>
          <TextInput
            style={styles.input}
            value={appleId}
            onChangeText={setAppleId}
            placeholder="you@icloud.com"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            editable={!loading}
          />

          <Text style={styles.fieldLabel}>App-Specific Password</Text>
          <TextInput
            style={styles.input}
            value={appSpecificPassword}
            onChangeText={setAppSpecificPassword}
            placeholder="xxxx-xxxx-xxxx-xxxx"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            editable={!loading}
          />

          <TouchableOpacity onPress={() => Linking.openURL(APP_PASSWORD_HELP_URL)} activeOpacity={0.7}>
            <Text style={styles.helpLink}>How do I generate an app-specific password?</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.confirmBtn, !canSubmit && styles.confirmDisabled]}
            onPress={() => onSubmit({ appleId: appleId.trim(), appSpecificPassword: appSpecificPassword.trim() })}
            disabled={!canSubmit}
            activeOpacity={0.85}
          >
            <GoldFill radius={radius.pill} disabled={!canSubmit} />
            {loading ? (
              <ActivityIndicator size="small" color={colors.onAccent} />
            ) : (
              <Text style={styles.confirmText}>Connect</Text>
            )}
          </TouchableOpacity>
          <TouchableOpacity style={styles.cancelBtn} onPress={onCancel} activeOpacity={0.85} disabled={loading}>
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: withAlpha(colors.shadow, 0.55), justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.canvas,
    borderTopLeftRadius: 32,
    borderTopRightRadius: 32,
    borderWidth: 1,
    borderColor: colors.border,
    borderBottomWidth: 0,
    paddingHorizontal: 24,
    paddingTop: 26,
    alignItems: 'stretch',
    shadowColor: colors.shadow,
    shadowOffset: { width: 0, height: -8 },
    shadowOpacity: 0.14,
    shadowRadius: 40,
    elevation: 12,
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
    marginBottom: 26,
    alignSelf: 'center',
  },
  title: {
    fontSize: 19,
    lineHeight: 25,
    fontWeight: '700',
    fontFamily: fonts.displayBold,
    color: colors.ink,
    marginBottom: 8,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 13,
    lineHeight: 19,
    fontFamily: fonts.body,
    color: colors.textSecondary,
    marginBottom: 20,
    textAlign: 'center',
  },
  fieldLabel: {
    fontSize: 11,
    fontWeight: '600',
    fontFamily: fonts.bodySemiBold,
    letterSpacing: 0.4,
    color: colors.textSecondary,
    marginBottom: 7,
    marginTop: 14,
  },
  input: {
    height: 52,
    borderRadius: radius.card,
    backgroundColor: colors.surface,
    borderWidth: 1.5,
    borderColor: colors.border,
    paddingHorizontal: 16,
    fontSize: 14,
    fontFamily: fonts.body,
    color: colors.ink,
  },
  helpLink: {
    marginTop: 10,
    fontSize: 12.5,
    fontFamily: fonts.bodySemiBold,
    color: colors.gold,
    textAlign: 'center',
  },
  confirmBtn: {
    width: '100%',
    height: 54,
    borderRadius: radius.pill,
    backgroundColor: colors.gold,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 24,
    marginBottom: spacing.md,
  },
  confirmDisabled: { opacity: 0.5 },
  confirmText: {
    fontSize: 15,
    fontWeight: '600',
    fontFamily: fonts.displayBold,
    color: colors.onAccent,
  },
  cancelBtn: {
    width: '100%',
    height: 54,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1.5,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelText: {
    fontSize: 15,
    fontWeight: '600',
    fontFamily: fonts.displayBold,
    color: colors.ink,
  },
});
