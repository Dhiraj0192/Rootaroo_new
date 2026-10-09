/**
 * VaultUploadScreen — document encryption and upload (SCREEN 29).
 *
 * Design: dark overlay + white bottom sheet with "Choose file" / "Take photo"
 * cards and a gold progress bar ("Uploading {name}…"). Presented as a
 * transparentModal so the vault list shows dimmed behind the sheet.
 *
 * Security: the vault repo encrypts the file, its name and its type on this
 * phone (AES-256-GCM, fresh key per file) and seals the file key to this
 * phone's account key, plus every member's key for Household files.
 */
import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  StatusBar,
  Modal,
  TextInput,
} from 'react-native';
import { showAlert } from '../shared/services/themedAlert';
import Svg, { Path, Rect, Circle } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { ensureCamera } from '../shared/permissions';
import { useVaultStore } from '../shared/store/vaultStore';
import { getVaultRepo, isMemberKeyChanged } from '../shared/vault/vaultRepo';
import { usePrivateSpaceStore } from '../shared/store/privateSpaceStore';
import { colors, fonts, goldButton, radius, withAlpha } from '../shared/theme';
import { GoldFill } from '../shared/components/GoldButton';
import { KeyboardAvoider } from '../shared/components/KeyboardAware';
import { readBytes, deleteTemp } from '../shared/vault/vaultDevice';
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
  const [scope, setScope] = useState('personal');
  const [namePrompt, setNamePrompt] = useState({
    visible: false,
    value: '',
    defaultName: '',
    resolve: null,
  });
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

  /**
   * Reads the picked file into memory straight away and deletes the plain copy.
   * The picker's copy lives in the app cache, which Android may wipe at any time
   * when storage is low, so it must not wait through the name prompt.
   */
  const takeBytes = async (asset) => {
    if (asset.size > MAX_SIZE) return asset; // rejected in processAndUpload; never load it
    const bytes = await readBytes(asset.uri);
    await deleteTemp(asset.uri);
    return { ...asset, bytes, size: asset.size || bytes.length };
  };

  /** Shared encryption + upload pipeline for any picked asset. */
  const processAndUpload = async (asset) => {
    try {
      setUploading(true);
      setProgress(0);
      setFileName(asset.name);
      if (asset.size > MAX_SIZE) {
        showAlert('File too large', 'Maximum file size is 20 MB');
        setUploading(false);
        return;
      }
      setProgress(15);
      const { status, publicKey } = usePrivateSpaceStore.getState();
      if (status !== 'here' || !publicKey) {
        setUploading(false);
        showAlert('Set up your private space first', 'Your documents are locked with a key that lives on this phone.', [
          { text: 'Not now', style: 'cancel' },
          { text: 'Set up', onPress: () => navigation.replace('PrivateSpaceSetup') },
        ]);
        return;
      }
      setProgress(40);

      const document = await getVaultRepo().upload({
        bytes: asset.bytes,
        uri: asset.uri,
        name: asset.name || 'Document',
        mimeType: asset.mimeType,
        scope,
      });
      setProgress(90);
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
      if (isMemberKeyChanged(error)) {
        showAlert(
          'Check a safety number first',
          `${error.members.map((m) => m.displayName).join(', ')} has a new key. Open the vault and compare safety numbers with them in person before sharing.`,
          [{ text: 'OK', onPress: () => navigation.goBack() }],
        );
        return;
      }
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
      const asset = await takeBytes(normalizeAsset(result.assets[0]));
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
      const asset = await takeBytes(normalizeAsset(result.assets[0]));
      const name = await promptDocumentName(asset.name);
      await processAndUpload({ ...asset, name });
    } catch (e) {
      showAlert('Error', e?.message || 'Could not take photo');
    }
  };

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

        <View style={styles.scopeRow}>
          {[['personal', 'Personal'], ['household', 'Household']].map(([value, label]) => (
            <TouchableOpacity
              key={value}
              style={[styles.scopeBtn, scope === value && styles.scopeBtnOn]}
              onPress={() => setScope(value)}
              disabled={uploading}
              activeOpacity={0.8}
            >
              <Text style={[styles.scopeText, scope === value && styles.scopeTextOn]}>{label}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <Text style={styles.scopeHelp}>
          {scope === 'household'
            ? 'Household files can be opened by everyone in your household.'
            : 'Personal files can only be opened by you, on this phone.'}
        </Text>

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
    // Opaque: a glass fill lets the screen behind show through the sheet.
    backgroundColor: colors.surfaceRaised,
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
  scopeRow: {
    flexDirection: 'row',
    backgroundColor: colors.canvasElevated,
    borderRadius: 12,
    padding: 3,
    marginBottom: 10,
  },
  scopeBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    alignItems: 'center',
  },
  scopeBtnOn: {
    backgroundColor: colors.surface,
  },
  scopeText: {
    fontSize: 14,
    fontFamily: fonts.bodyMedium,
    color: colors.textSecondary,
  },
  scopeTextOn: {
    color: colors.ink,
    fontFamily: fonts.bodySemiBold,
  },
  scopeHelp: {
    fontSize: 12,
    lineHeight: 17,
    fontFamily: fonts.body,
    color: colors.textMuted,
    textAlign: 'center',
    marginBottom: 20,
  },
  progressText: {
    fontSize: 12,
    fontFamily: fonts.body,
    color: colors.textSecondary,
  },
  // ── Name this document ──
  namePromptOverlay: {
    flex: 1,
    backgroundColor: withAlpha(colors.shadow, 0.55),
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  namePromptCard: {
    backgroundColor: colors.surfaceRaised,
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
