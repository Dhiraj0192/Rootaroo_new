/**
 * VaultSetupScreen — first-time vault key setup.
 *
 * Creates the RSA key pair (stored in the hardware keychain, biometric-gated),
 * so subsequent "Unlock vault" taps trigger the Face ID / fingerprint prompt.
 * The user picks a backup mode:
 *   - Passphrase (recommended): private key is AES-GCM encrypted with a
 *     passphrase and stored on the server for recovery on a new device.
 *   - Zero-knowledge: no backup — device loss = permanent vault loss.
 *
 * On success, sets vaultStore.justSetUpVault so the list auto-unlocks on return.
 */
import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  StatusBar,
} from 'react-native';
import { showAlert } from '../shared/services/themedAlert';
import Svg, { Rect, Path, Circle } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuthStore } from '../shared/store/authStore';
import { useVaultStore } from '../shared/store/vaultStore';
import { setupVaultKeys } from '../shared/crypto/vaultSetup';
import { getPrivateKey } from '../shared/crypto/secureKeyStore';
import { colors, fonts, radius, withAlpha } from '../shared/theme';
import { GoldFill } from '../shared/components/GoldButton';
import { KeyboardAvoider, keyboardScrollProps } from '../shared/components/KeyboardAware';
export default function VaultSetupScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const [backupChoice, setBackupChoice] = useState('passphrase');
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [settingUp, setSettingUp] = useState(false);

  // Safety net — a key already exists, nothing to set up
  useEffect(() => {
    (async () => {
      const user = useAuthStore.getState().user;
      if (!user?.id) return;
      try {
        const priv = await getPrivateKey(user.id);
        if (priv) navigation.goBack();
      } catch {
        // Key exists but auth failed/cancelled — stay on setup; harmless no-op.
      }
    })();
  }, [navigation]);
  const handleCreate = async () => {
    const user = useAuthStore.getState().user;
    if (!user?.id) {
      showAlert('Error', 'Authentication required');
      return;
    }
    if (backupChoice === 'passphrase') {
      if (passphrase.length < 8) {
        showAlert('Weak passphrase', 'Use at least 8 characters.');
        return;
      }
      if (passphrase !== confirm) {
        showAlert('Passphrase mismatch', 'The two passphrases do not match.');
        return;
      }
    }
    setSettingUp(true);
    try {
      await setupVaultKeys(
        user.id,
        backupChoice,
        backupChoice === 'passphrase' ? passphrase : undefined,
      );
      // Let the vault list auto-unlock (biometric) when we return to it
      useVaultStore.setState({
        justSetUpVault: true,
      });
      navigation.goBack();
    } catch (e) {
      showAlert('Setup failed', e?.message || 'Could not set up your vault');
    } finally {
      setSettingUp(false);
    }
  };
  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor={colors.shadow} />

      {/* Header */}
      <View
        style={[
          styles.header,
          {
            paddingTop: insets.top,
            height: 56 + insets.top,
          },
        ]}
      >
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
        <Text style={styles.headerTitle}>Set up vault</Text>
        <View style={styles.backBtn} />
      </View>

      <KeyboardAvoider>
      <ScrollView
        contentContainerStyle={[
          styles.content,
          {
            paddingBottom: insets.bottom + 24,
          },
        ]}
        {...keyboardScrollProps}
        showsVerticalScrollIndicator={false}
      >
        {/* Icon */}
        <Svg width={84} height={84} viewBox="0 0 130 130" style={styles.icon}>
          <Rect
            x="30"
            y="55"
            width="70"
            height="55"
            rx="10"
            stroke={colors.gold}
            strokeWidth="2"
            fill="none"
          />
          <Path
            d="M45 55 V38 a20 20 0 0 1 40 0 V55"
            stroke={colors.gold}
            strokeWidth="2"
            fill="none"
          />
          <Circle cx="65" cy="82" r="6" fill={colors.gold} />
        </Svg>

        <Text style={styles.title}>Protect your vault</Text>
        <Text style={styles.subtitle}>
          Files are encrypted on your device and unlock with Face ID or fingerprint. Add a
          passphrase so you can recover the vault on a new device.
        </Text>

        {/* Backup mode cards */}
        <TouchableOpacity
          style={[styles.option, backupChoice === 'passphrase' && styles.optionSelected]}
          onPress={() => setBackupChoice('passphrase')}
          activeOpacity={0.85}
        >
          <Text style={styles.optionTitle}>🔑 Passphrase backup</Text>
          <Text style={styles.optionDesc}>
            Recommended. Your private key is encrypted with a passphrase and stored on the server.
            Recover on any new device by entering the passphrase.
          </Text>
        </TouchableOpacity>

        {backupChoice === 'passphrase' && (
          <View style={styles.passphraseBox}>
            <TextInput
              style={styles.input}
              placeholder="Passphrase (min 8 characters)"
              placeholderTextColor={colors.textMuted}
              secureTextEntry
              autoCapitalize="none"
              value={passphrase}
              onChangeText={setPassphrase}
            />
            <TextInput
              style={styles.input}
              placeholder="Confirm passphrase"
              placeholderTextColor={colors.textMuted}
              secureTextEntry
              autoCapitalize="none"
              value={confirm}
              onChangeText={setConfirm}
            />
          </View>
        )}

        <TouchableOpacity
          style={[styles.option, backupChoice === 'none' && styles.optionSelected]}
          onPress={() => setBackupChoice('none')}
          activeOpacity={0.85}
        >
          <Text style={styles.optionTitle}>🔒 Zero-knowledge</Text>
          <Text style={styles.optionDesc}>
            No server backup. Your private key exists only on this device's hardware keychain. If
            you lose this device, vault access is permanently gone.
          </Text>
        </TouchableOpacity>

        <Text style={styles.note}>
          Unlocking always uses Face ID / fingerprint on this device. The passphrase is only used
          for recovery on a new device.
        </Text>
      </ScrollView>

      {/* Footer */}
      <View
        style={[
          styles.footer,
          {
            paddingBottom: insets.bottom + 88,
          },
        ]}
      >
        <TouchableOpacity
          style={[styles.createButton, settingUp && styles.buttonDisabled]}
          onPress={handleCreate}
          disabled={settingUp}
          activeOpacity={0.85}
        >
          <GoldFill radius={9999} disabled={settingUp} />
          {settingUp ? (
            <View style={styles.creatingRow}>
              <ActivityIndicator size="small" color={colors.onAccent} />
              <Text style={styles.createButtonText}>Creating secure key…</Text>
            </View>
          ) : (
            <Text style={styles.createButtonText}>Create vault & unlock</Text>
          )}
        </TouchableOpacity>
        {settingUp && (
          <Text style={styles.waitHint}>
            Generating a 4096-bit encryption key — this can take up to a minute. Don't close the
            app.
          </Text>
        )}
      </View>
      </KeyboardAvoider>
    </View>
  );
}
const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.surfaceRaised,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 24,
  },
  backBtn: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backIcon: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.onAccent,
    lineHeight: 20,
  },
  headerTitle: {
    fontSize: 17,
    fontFamily: fonts.displayBold,
    color: colors.onAccent,
  },
  content: {
    paddingHorizontal: 24,
    paddingTop: 24,
  },
  icon: {
    alignSelf: 'center',
    marginBottom: 20,
  },
  title: {
    fontSize: 23,
    lineHeight: 30,
    fontFamily: fonts.displayBold,
    color: colors.onAccent,
    textAlign: 'center',
    marginBottom: 10,
  },
  subtitle: {
    fontSize: 14,
    lineHeight: 21,
    fontFamily: fonts.body,
    color: colors.textFaint,
    textAlign: 'center',
    marginBottom: 24,
  },
  option: {
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: 'transparent',
    borderRadius: radius.cardLg,
    padding: 16,
    marginBottom: 12,
  },
  optionSelected: {
    borderColor: colors.gold,
  },
  optionTitle: {
    fontSize: 15,
    fontFamily: fonts.displayBold,
    color: colors.onAccent,
    marginBottom: 6,
  },
  optionDesc: {
    fontSize: 13,
    lineHeight: 19,
    fontFamily: fonts.body,
    color: colors.textMutedDark,
  },
  passphraseBox: {
    gap: 10,
    marginBottom: 12,
  },
  input: {
    height: 52,
    borderRadius: radius.card,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1.5,
    borderColor: withAlpha(colors.white, 0.1),
    paddingHorizontal: 16,
    fontSize: 14,
    fontFamily: fonts.body,
    color: colors.onAccent,
  },
  note: {
    fontSize: 12,
    lineHeight: 18,
    fontFamily: fonts.body,
    color: colors.textMutedDark,
    textAlign: 'center',
    marginTop: 8,
  },
  footer: {
    paddingHorizontal: 24,
    paddingTop: 12,
  },
  createButton: {
    height: 54,
    borderRadius: 9999,
    backgroundColor: colors.gold,
    alignItems: 'center',
    justifyContent: 'center',
    shadowOpacity: 0,
    shadowRadius: 0,
    elevation: 0,
  },
  creatingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  createButtonText: {
    fontSize: 15,
    fontFamily: fonts.displayBold,
    color: colors.onAccent,
  },
  waitHint: {
    fontSize: 12,
    lineHeight: 18,
    fontFamily: fonts.body,
    color: colors.textMutedDark,
    textAlign: 'center',
    marginTop: 12,
  },
});
