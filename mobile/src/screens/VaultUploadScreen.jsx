/**
 * VaultUploadScreen — document encryption and upload (SCREEN 29).
 *
 * Design: dark overlay + white bottom sheet with "Choose file" / "Take photo"
 * cards and a gold progress bar ("Uploading {name}…"). Presented as a
 * transparentModal so the vault list shows dimmed behind the sheet.
 *
 * Security: unchanged — AES-256-GCM per file, IV via crypto.getRandomValues,
 * AES key wrapped with TOFU-verified own RSA public key, ciphertext → Cloudinary.
 */
import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  StatusBar,
  Modal,
  TextInput,
} from 'react-native';
import { showAlert } from '../shared/services/themedAlert';
import Svg, { Path, Rect, Circle } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { File, Paths } from 'expo-file-system';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { ensureCamera } from '../shared/permissions';
import { vaultApi } from '../shared/api/vault';
import { useVaultStore } from '../shared/store/vaultStore';
import { useAuthStore } from '../shared/store/authStore';
import {
  importPublicKey,
  generateAesKey,
  encryptBuffer,
  wrapKey,
} from '../shared/crypto/vaultCrypto';
import { getPrivateKey } from '../shared/crypto/secureKeyStore';
import { verifyPublicKey } from '../shared/crypto/keyPinStore';
import { setupVaultKeys } from '../shared/crypto/vaultSetup';
import { colors, fonts, goldButton, radius, withAlpha } from '../shared/theme';
import { GoldFill } from '../shared/components/GoldButton';
import { KeyboardAvoider } from '../shared/components/KeyboardAware';
const MAX_SIZE = 20 * 1024 * 1024;

/** Normalize a document-picker or image-picker asset into { uri, name, mimeType, size }. */
function normalizeAsset(a) {
  const name = a.name || a.fileName || 'document';
  const mimeType =
    a.mimeType || (name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/jpeg');
  const size = a.size ?? a.fileSize ?? 0;
  return {
    uri: a.uri,
    name,
    mimeType,
    size,
  };
}
export default function VaultUploadScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [fileName, setFileName] = useState('');
  const [keyState, setKeyState] = useState('checking');
  const [showBackupChoice, setShowBackupChoice] = useState(false);
  const [namePrompt, setNamePrompt] = useState({
    visible: false,
    value: '',
    defaultName: '',
    resolve: null,
  });
  React.useEffect(() => {
    (async () => {
      try {
        const myKey = await vaultApi.getMyKey();
        setKeyState(myKey ? 'ready' : 'needs_key');
      } catch {
        setKeyState('needs_key');
      }
    })();
  }, []);

  /** Prompt user for a passphrase using a modal-style Alert. */
  const promptPassphrase = () =>
    new Promise((resolve, reject) => {
      Alert.prompt(
        'Set Vault Passphrase',
        'Choose a strong passphrase. This encrypts your private key backup on the server. A weak passphrase = weak backup.',
        [
          {
            text: 'Cancel',
            style: 'cancel',
            onPress: () => reject(new Error('Cancelled')),
          },
          {
            text: 'Set Passphrase',
            onPress: (pwd) => resolve(pwd || ''),
          },
        ],
        'secure-text',
      );
    });
  const ensureKeys = async (userId) => {
    const existingPriv = await getPrivateKey(userId);
    if (existingPriv) {
      const myKey = await vaultApi.getMyKey();
      if (myKey?.publicKey) return myKey.publicKey;
    }
    return new Promise((resolve, reject) => {
      setShowBackupChoice(true);
      globalThis.__vaultKeySetupResolve = resolve;
      globalThis.__vaultKeySetupReject = reject;
      globalThis.__vaultKeySetupUserId = userId;
    });
  };
  const handleBackupChoice = async (choice) => {
    setShowBackupChoice(false);
    const resolve = globalThis.__vaultKeySetupResolve;
    const reject = globalThis.__vaultKeySetupReject;
    const userId = globalThis.__vaultKeySetupUserId;
    if (!resolve || !userId) return;
    try {
      let publicKeySpki;
      if (choice === 'passphrase') {
        const passphrase = await promptPassphrase();
        publicKeySpki = await setupVaultKeys(userId, 'passphrase', passphrase);
      } else {
        publicKeySpki = await setupVaultKeys(userId, 'none');
      }
      setKeyState('ready');
      resolve(publicKeySpki);
    } catch (e) {
      reject(e);
    }
  };

  /**
   * Prompt for a document name, pre-filled with the picked file's name.
   * Alert.prompt is iOS-only in React Native (silently no-ops on Android),
   * so this uses a plain cross-platform Modal + TextInput instead — same
   * pattern as the rename dialog in VaultListScreen.jsx.
   */
  const promptDocumentName = (defaultName) =>
    new Promise((resolve) => {
      setNamePrompt({ visible: true, value: defaultName, defaultName, resolve });
    });
  const closeNamePrompt = (value) => {
    namePrompt.resolve?.(value?.trim() || namePrompt.defaultName || 'Document');
    setNamePrompt({ visible: false, value: '', defaultName: '', resolve: null });
  };

  /** Shared encryption + upload pipeline for any picked asset. */
  const processAndUpload = async (asset) => {
    try {
      if (keyState === 'checking') {
        showAlert('Please wait', 'Checking vault key status...');
        return;
      }
      setUploading(true);
      setProgress(0);
      setFileName(asset.name);
      if (asset.size > MAX_SIZE) {
        showAlert('File too large', 'Maximum file size is 20 MB');
        setUploading(false);
        return;
      }
      setProgress(15);
      const user = useAuthStore.getState().user;
      if (!user?.id) {
        showAlert('Error', 'User authentication required.');
        setUploading(false);
        return;
      }
      const userId = user.id;

      // Step: ensure RSA key pair exists (may show backup choice UI)
      setUploading(false); // pause indicator during key setup if needed
      const publicKeySpki =
        keyState === 'needs_key'
          ? await ensureKeys(userId)
          : (await vaultApi.getMyKey())?.publicKey;
      if (!publicKeySpki) {
        showAlert('Error', 'No vault key found. Please set up your vault key first.');
        return;
      }
      setUploading(true);
      setProgress(25);

      // TOFU verification of own public key before wrapping
      const pinResult = await verifyPublicKey(userId, publicKeySpki);
      if (pinResult === 'changed') {
        showAlert(
          '⚠️ Vault Key Mismatch',
          'Your vault public key on the server does not match the key stored on this device. ' +
            'This may indicate a server compromise. Vault upload has been blocked. ' +
            'Do not proceed — contact your administrator.',
          [
            {
              text: 'OK',
            },
          ],
        );
        setUploading(false);
        return;
      }
      setProgress(35);

      // Read file bytes
      const file = new File(asset.uri);
      const fileBytes = await file.arrayBuffer();
      setProgress(45);

      // AES-256-GCM key + encrypt — IV is crypto.getRandomValues
      const aesKey = await generateAesKey();
      const { iv, encryptedBytes } = await encryptBuffer(aesKey, fileBytes);
      setProgress(60);

      // Wrap AES key with TOFU-verified own RSA public key
      const publicKey = await importPublicKey(publicKeySpki);
      const wrappedKey = await wrapKey(aesKey, publicKey);
      setProgress(75);

      // Write encrypted bytes to temp cache
      const tempFile = new File(
        Paths.cache,
        `vault_enc_${Date.now()}_${Math.random().toString(36).substring(7)}`,
      );
      await tempFile.write(new Uint8Array(encryptedBytes));
      setProgress(85);

      // Upload
      const document = await vaultApi.uploadDocument(
        {
          name: asset.name || 'Document',
          mimeType: asset.mimeType,
          sizeBytes: asset.size || 0,
          encryptedKey: wrappedKey,
          iv,
        },
        {
          uri: tempFile.uri,
          name: asset.name || 'encrypted_file',
          type: 'application/octet-stream',
        },
      );

      // Cleanup
      try {
        await tempFile.delete();
      } catch {
        /* ignore */
      }
      if (document) {
        useVaultStore.getState().prependDocument(document);
        setProgress(100);
        showAlert('Uploaded', `${asset.name} encrypted and uploaded successfully`, [
          {
            text: 'OK',
            onPress: () => navigation.goBack(),
          },
        ]);
      }
    } catch (error) {
      showAlert(
        'Upload Failed',
        error?.response?.data?.message || error?.message || 'Could not upload file',
      );
    } finally {
      setUploading(false);
    }
  };
  const handlePickDocument = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['application/pdf', 'image/*'],
        copyToCacheDirectory: true,
      });
      if (result.canceled || !result.assets?.[0]) return;
      const asset = normalizeAsset(result.assets[0]);
      const name = await promptDocumentName(asset.name);
      await processAndUpload({ ...asset, name });
    } catch (e) {
      showAlert('Error', e?.message || 'Could not pick file');
    }
  };
  const handleTakePhoto = async () => {
    try {
      if (!(await ensureCamera())) return;
      const result = await ImagePicker.launchCameraAsync({
        quality: 0.8,
      });
      if (result.canceled || !result.assets?.[0]) return;
      const asset = normalizeAsset(result.assets[0]);
      const name = await promptDocumentName(asset.name);
      await processAndUpload({ ...asset, name });
    } catch (e) {
      showAlert('Error', e?.message || 'Could not take photo');
    }
  };

  // ── Backup Choice (key setup) — dark full screen ─────────────────────────────
  if (showBackupChoice) {
    return (
      <View style={[styles.root, styles.backupScreen]}>
        <StatusBar barStyle="light-content" backgroundColor={colors.shadow} />
        <View style={styles.backupContent}>
          <Text style={styles.backupTitle}>Vault Key Backup</Text>
          <Text style={styles.backupSubtitle}>
            Your vault key pair needs to be created. Choose a backup mode:
          </Text>

          <TouchableOpacity
            style={styles.backupOption}
            onPress={() => handleBackupChoice('passphrase')}
            activeOpacity={0.85}
          >
            <Text style={styles.backupOptionTitle}>🔑 Passphrase Backup (Opt-in)</Text>
            <Text style={styles.backupOptionDesc}>
              Your private key is encrypted with a passphrase you set and stored on the server. You
              can recover vault access on a new device if you remember the passphrase.{'\n\n'}
              ⚠️ A weak passphrase = a weak backup. The server cannot decrypt this, but an attacker
              with server access could attempt offline brute-force.
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.backupOption, styles.backupOptionDefault]}
            onPress={() => handleBackupChoice('none')}
            activeOpacity={0.85}
          >
            <Text style={styles.backupOptionTitle}>🔒 Zero-Knowledge (Recommended)</Text>
            <Text style={styles.backupOptionDesc}>
              No server backup. Your private key exists only on this device's hardware keychain,
              protected by biometrics.{'\n\n'}
              ⚠️ If this device is lost, vault access is permanently gone. There is no recovery path
              — this is by design.
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.backupCancel}
            onPress={() => {
              setShowBackupChoice(false);
              globalThis.__vaultKeySetupReject?.(new Error('Backup choice cancelled'));
            }}
          >
            <Text style={styles.backupCancelText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // ── Checking key status — dark full screen ───────────────────────────────────
  if (keyState === 'checking') {
    return (
      <View style={[styles.root, styles.checkingScreen]}>
        <StatusBar barStyle="light-content" backgroundColor={colors.shadow} />
        <ActivityIndicator size="large" color={colors.gold} />
      </View>
    );
  }

  // ── Bottom sheet (SCREEN 29) ─────────────────────────────────────────────────
  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor="transparent" />
      <TouchableOpacity
        style={styles.backdrop}
        activeOpacity={1}
        onPress={() => !uploading && navigation.goBack()}
      />

      <View
        style={[
          styles.sheet,
          {
            paddingBottom: insets.bottom + 44,
          },
        ]}
      >
        <View style={styles.handle} />
        <Text style={styles.sheetTitle}>Add a document</Text>

        <View style={styles.optionsRow}>
          <TouchableOpacity
            style={styles.optionCard}
            onPress={handlePickDocument}
            disabled={uploading}
            activeOpacity={0.7}
          >
            <Svg width={26} height={26} viewBox="0 0 24 24" style={styles.optionIcon}>
              <Path
                d="M12 4v12M6 10l6-6 6 6"
                stroke={colors.textSecondary}
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
              />
              <Path
                d="M4 18h16"
                stroke={colors.textSecondary}
                strokeWidth="1.5"
                strokeLinecap="round"
                fill="none"
              />
            </Svg>
            <Text style={styles.optionLabel}>Choose file</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.optionCard}
            onPress={handleTakePhoto}
            disabled={uploading}
            activeOpacity={0.7}
          >
            <Svg width={26} height={26} viewBox="0 0 24 24" style={styles.optionIcon}>
              <Rect
                x="3"
                y="7"
                width="18"
                height="13"
                rx="2"
                stroke={colors.textSecondary}
                strokeWidth="1.5"
                fill="none"
              />
              <Path
                d="M8 7l1.5-3h5L16 7"
                stroke={colors.textSecondary}
                strokeWidth="1.5"
                strokeLinejoin="round"
                fill="none"
              />
              <Circle
                cx="12"
                cy="13.5"
                r="3.5"
                stroke={colors.textSecondary}
                strokeWidth="1.5"
                fill="none"
              />
            </Svg>
            <Text style={styles.optionLabel}>Take photo</Text>
          </TouchableOpacity>
        </View>

        {uploading && (
          <View style={styles.progressWrap}>
            <View style={styles.progressTrack}>
              <View
                style={[
                  styles.progressFill,
                  {
                    width: `${Math.min(progress, 95)}%`,
                  },
                ]}
              />
            </View>
            <Text style={styles.progressText}>Uploading {fileName}…</Text>
          </View>
        )}
      </View>

      {/* ── Name this document ── */}
      <Modal
        visible={namePrompt.visible}
        transparent
        animationType="fade"
        onRequestClose={() => closeNamePrompt(namePrompt.value)}
        statusBarTranslucent
        navigationBarTranslucent
      >
        <KeyboardAvoider style={styles.namePromptOverlay}>
          <View style={styles.namePromptCard}>
            <Text style={styles.namePromptTitle}>Name this document</Text>
            <TextInput
              style={styles.namePromptInput}
              value={namePrompt.value}
              onChangeText={(v) => setNamePrompt((p) => ({ ...p, value: v }))}
              autoFocus
              placeholder="Document name"
              placeholderTextColor={colors.textMuted}
              maxLength={255}
            />
            <View style={styles.namePromptButtons}>
              <TouchableOpacity
                style={styles.namePromptCancel}
                onPress={() => closeNamePrompt(namePrompt.defaultName)}
                activeOpacity={0.7}
              >
                <Text style={styles.namePromptCancelText}>Skip</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.namePromptSave}
                onPress={() => closeNamePrompt(namePrompt.value)}
                activeOpacity={0.85}
              >
                <GoldFill radius={10} />
                <Text style={styles.namePromptSaveText}>Save</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoider>
      </Modal>
    </View>
  );
}
const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  // ── Overlay + sheet (SCREEN 29) ──
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: withAlpha(colors.shadow, 0.55),
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.surface,
    borderTopLeftRadius: 32,
    borderTopRightRadius: 32,
    paddingTop: 14,
    paddingHorizontal: 24,
    shadowColor: colors.shadow,
    shadowOffset: {
      width: 0,
      height: -8,
    },
    shadowOpacity: 0.14,
    shadowRadius: 40,
    elevation: 16,
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
    alignSelf: 'center',
    marginBottom: 22,
  },
  sheetTitle: {
    fontSize: 18,
    fontFamily: fonts.displayBold,
    color: colors.ink,
    textAlign: 'center',
    marginBottom: 26,
  },
  optionsRow: {
    flexDirection: 'row',
    gap: 14,
  },
  optionCard: {
    flex: 1,
    borderRadius: radius.cardLg,
    paddingVertical: 24,
    paddingHorizontal: 12,
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: colors.border,
  },
  optionIcon: {
    marginBottom: 10,
  },
  optionLabel: {
    fontSize: 13,
    fontFamily: fonts.bodyMedium,
    color: colors.ink,
  },
  progressWrap: {
    marginTop: 22,
  },
  progressTrack: {
    height: 6,
    backgroundColor: colors.canvasElevated,
    borderRadius: 3,
    overflow: 'hidden',
    marginBottom: 10,
  },
  progressFill: {
    height: '100%',
    backgroundColor: colors.gold,
    borderRadius: 3,
  },
  progressText: {
    fontSize: 12,
    fontFamily: fonts.body,
    color: colors.textSecondary,
  },
  // ── Backup choice (dark) ──
  backupScreen: {
    backgroundColor: colors.surfaceRaised,
  },
  backupContent: {
    flex: 1,
    paddingHorizontal: 24,
    paddingTop: 72,
  },
  backupTitle: {
    fontSize: 22,
    fontFamily: fonts.displayBold,
    color: colors.onAccent,
    marginBottom: 8,
  },
  backupSubtitle: {
    fontSize: 14,
    fontFamily: fonts.body,
    color: colors.textFaint,
    lineHeight: 20,
    marginBottom: 22,
  },
  backupOption: {
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: 'transparent',
    borderRadius: radius.cardLg,
    padding: 16,
    marginBottom: 14,
  },
  backupOptionDefault: {
    borderColor: colors.gold,
  },
  backupOptionTitle: {
    fontSize: 15,
    fontFamily: fonts.displayBold,
    color: colors.onAccent,
    marginBottom: 8,
  },
  backupOptionDesc: {
    fontSize: 13,
    fontFamily: fonts.body,
    color: colors.textMutedDark,
    lineHeight: 19,
  },
  backupCancel: {
    paddingVertical: 12,
    alignItems: 'center',
  },
  backupCancelText: {
    color: colors.gold,
    fontSize: 15,
    fontFamily: fonts.bodyMedium,
  },
  // ── Checking (dark) ──
  checkingScreen: {
    backgroundColor: colors.surfaceRaised,
    justifyContent: 'center',
    alignItems: 'center',
  },
  // ── Name this document ──
  namePromptOverlay: {
    flex: 1,
    backgroundColor: withAlpha(colors.shadow, 0.55),
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  namePromptCard: {
    backgroundColor: colors.surface,
    borderRadius: 20,
    padding: 20,
  },
  namePromptTitle: {
    fontSize: 17,
    fontFamily: fonts.displayBold,
    color: colors.ink,
    marginBottom: 14,
  },
  namePromptInput: {
    height: 50,
    borderRadius: 12,
    backgroundColor: colors.canvas,
    borderWidth: 1.5,
    borderColor: colors.border,
    paddingHorizontal: 14,
    fontSize: 15,
    fontFamily: fonts.body,
    color: colors.ink,
    marginBottom: 16,
  },
  namePromptButtons: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
  },
  namePromptCancel: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: colors.surfaceWarm,
  },
  namePromptCancelText: {
    color: colors.textSecondary,
    fontSize: 14,
    fontFamily: fonts.bodySemiBold,
  },
  namePromptSave: {
    paddingHorizontal: 24,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: colors.gold,
    ...goldButton.glow,
  },
  namePromptSaveText: {
    color: goldButton.onGold,
    fontSize: 14,
    fontFamily: fonts.displayBold,
  },
});
