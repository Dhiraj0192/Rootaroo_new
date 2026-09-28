/**
 * VaultViewerScreen — fetch, decrypt, and display a vault document in-memory (SCREEN 28).
 *
 * Security invariants:
 *   - Decrypted plaintext is never written to disk (FR-128), EXCEPT for the
 *     explicit, user-initiated "Open with another app" action below — the only
 *     way to hand a file to a third-party app is via a real file URI, so that
 *     path briefly writes to the app-private cache directory and deletes it
 *     again shortly after (or on unmount). No other code path touches disk.
 *   - Screenshots are blocked at the OS level via expo-screen-capture.
 *   - The RSA private key is loaded from the hardware keychain (biometric-gated).
 *   - On recovery: if the private key is missing, we branch on backup mode:
 *       'passphrase' → prompt passphrase, decrypt server backup, restore keychain,
 *                      then re-pin own public key to the TOFU store so the restored
 *                      key is trusted for future ceremony operations.
 *       'none'       → vault access is permanently lost on this device by design.
 *                      The user sees an explicit, honest message — not a generic error.
 *       null         → key setup was never completed; direct user to set up vault.
 *
 * Design: full-bleed dark viewer — header/footer float as translucent overlays
 * over the content so every file type gets a true full-screen preview:
 *   image → <Image>, pdf → react-native-pdf, video → expo-av <Video>,
 *   audio → expo-av playback UI, everything else → file-info card + "Open with…".
 * An "Auto-closes in m:ss" countdown dismisses the viewer at 0.
 */
import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Image,
  ActivityIndicator,
  TouchableOpacity,
  StatusBar,
  Alert,
  Modal,
  TextInput,
} from 'react-native';
import { showAlert } from '../shared/services/themedAlert';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Pdf from 'react-native-pdf';
import { Video, ResizeMode, Audio } from 'expo-av';
import * as Sharing from 'expo-sharing';
import * as FileSystem from 'expo-file-system';
import { vaultApi } from '../shared/api/vault';
import { useAuthStore } from '../shared/store/authStore';
import {
  importPrivateKey,
  unwrapKey,
  decryptFile,
  decryptPrivateKeyFromBackup,
} from '../shared/crypto/vaultCrypto';
import { getPrivateKey, storePrivateKey, getBackupMode } from '../shared/crypto/secureKeyStore';
import { verifyPublicKey } from '../shared/crypto/keyPinStore';
import { formatFileSize } from '../shared/utils/format';
import * as ScreenCapture from 'expo-screen-capture';
import { colors, fonts, goldButton, withAlpha } from '../shared/theme';
import { GoldFill } from '../shared/components/GoldButton';
import ConfirmSheet from '../components/ConfirmSheet';
import { KeyboardAvoider } from '../shared/components/KeyboardAware';
function categorize(mimeType) {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'other';
}
const AUTO_CLOSE_SECONDS = 300; // 5 minutes — mock: "Auto-closes in 0:48"
const TEMP_FILE_LIFETIME_MS = 60_000; // best-effort cleanup window for "Open with…" exports

function formatLockTime(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
export default function VaultViewerScreen({ navigation, route }) {
  const insets = useSafeAreaInsets();
  const { documentId } = route.params;
  const [doc, setDoc] = useState(null);
  const [loading, setLoading] = useState(true);
  const [decrypting, setDecrypting] = useState(false);
  const [dataUri, setDataUri] = useState(null);
  const [decryptFailed, setDecryptFailed] = useState(false);
  const [statusMessage, setStatusMessage] = useState('Loading...');
  const [autoCloseSeconds, setAutoCloseSeconds] = useState(AUTO_CLOSE_SECONDS);
  const [showOptions, setShowOptions] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [audioStatus, setAudioStatus] = useState('idle');
  const soundRef = useRef(null);
  const tempFileRef = useRef(null);

  // FR-129: Block screenshots at OS level while this screen is mounted
  ScreenCapture.usePreventScreenCapture('vault-viewer');
  ScreenCapture.useScreenshotListener(() => {
    showAlert('Screenshot Blocked', 'Screenshots are disabled for vault documents (FR-129).');
  });
  useEffect(() => {
    loadAndDecrypt();
  }, [documentId]);

  // Clean up any playing sound + exported temp file on unmount
  useEffect(() => {
    return () => {
      soundRef.current?.unloadAsync().catch(() => {});
      if (tempFileRef.current) {
        FileSystem.deleteAsync(tempFileRef.current, {
          idempotent: true,
        }).catch(() => {});
      }
    };
  }, []);

  // Auto-close countdown once the document is loaded/decrypted
  useEffect(() => {
    if (loading || decrypting || !doc) return;
    const id = setInterval(() => {
      setAutoCloseSeconds((s) => (s <= 1 ? 0 : s - 1));
    }, 1000);
    return () => clearInterval(id);
  }, [loading, decrypting, doc]);
  useEffect(() => {
    if (autoCloseSeconds === 0 && doc) navigation.goBack();
  }, [autoCloseSeconds, doc, navigation]);

  /**
   * Prompt for passphrase using a native secure-text Alert.
   */
  const promptPassphrase = () =>
    new Promise((resolve, reject) => {
      Alert.prompt(
        'Enter Vault Passphrase',
        'Your vault private key is missing on this device. Enter your passphrase to restore access:',
        [
          {
            text: 'Cancel',
            style: 'cancel',
            onPress: () => reject(new Error('Cancelled')),
          },
          {
            text: 'Unlock',
            onPress: (pwd) => resolve(pwd || ''),
          },
        ],
        'secure-text',
      );
    });

  /**
   * Attempt to restore a missing private key from the server-backed passphrase
   * encrypted blob. Salt is now embedded in the blob, so this works even on a
   * fresh reinstall where SecureStore (and the local backup mode flag) has been wiped.
   */
  const attemptPassphraseRecovery = async (userId) => {
    const myKeyBackup = await vaultApi.getMyKey();
    if (!myKeyBackup?.privateKeyEncrypted || myKeyBackup.privateKeyEncrypted === 'none') {
      return null;
    }
    const passphrase = await promptPassphrase();
    const recoveredJwk = await decryptPrivateKeyFromBackup(
      myKeyBackup.privateKeyEncrypted,
      passphrase,
    );
    await storePrivateKey(userId, recoveredJwk);
    if (myKeyBackup.publicKey) {
      const pinResult = await verifyPublicKey(userId, myKeyBackup.publicKey);
      if (pinResult === 'changed') {
        const { updatePublicKeyPin } = await import('../shared/crypto/keyPinStore');
        await updatePublicKeyPin(userId, myKeyBackup.publicKey);
      }
    }
    return recoveredJwk;
  };
  const loadAndDecrypt = useCallback(async () => {
    try {
      setStatusMessage('Loading document...');
      const document = await vaultApi.getDocument(documentId);
      setDoc(document);
      setDecrypting(true);
      setStatusMessage('Fetching vault key...');
      let wrappedKey = null;
      try {
        const keyRes = await vaultApi.getDocumentKey(documentId);
        wrappedKey = keyRes.wrappedKey;
      } catch {
        wrappedKey = document.encryptedKey || null;
      }
      if (!wrappedKey || !document.iv) {
        setDecryptFailed(true);
        return;
      }
      setStatusMessage('Downloading encrypted document...');
      const encryptedResponse = await fetch(document.downloadUrl);
      const encryptedArrayBuffer = await encryptedResponse.arrayBuffer();
      const user = useAuthStore.getState().user;
      if (!user?.id) {
        setDecryptFailed(true);
        return;
      }
      setStatusMessage('Authenticating...');
      let privateKeyJwk;
      try {
        privateKeyJwk = await getPrivateKey(user.id);
      } catch {
        showAlert('Authentication failed', 'Could not verify your fingerprint or Face ID.', [
          {
            text: 'OK',
            onPress: () => navigation.goBack(),
          },
        ]);
        return;
      }
      if (!privateKeyJwk) {
        const backupMode = await getBackupMode(user.id);
        if (backupMode === 'none') {
          showAlert(
            'Vault Access Lost',
            'This vault was set up in zero-knowledge mode — no server backup was created. ' +
              'The private key only existed on your original device.\n\n' +
              'Vault access on this device cannot be recovered. This is by design.',
            [
              {
                text: 'OK',
                onPress: () => navigation.goBack(),
              },
            ],
          );
          return;
        }
        setStatusMessage('Recovering vault key from backup...');
        try {
          privateKeyJwk = await attemptPassphraseRecovery(user.id);
        } catch (recoveryErr) {
          const msg = recoveryErr?.message?.includes('Cancelled')
            ? 'Recovery cancelled.'
            : 'Wrong passphrase — decryption failed. Please try again.';
          showAlert('Recovery Failed', msg);
          setDecryptFailed(true);
          return;
        }
        if (!privateKeyJwk) {
          showAlert(
            'No Vault Key',
            backupMode === null
              ? 'No vault key backup was found on the server for this account. ' +
                  'If you used zero-knowledge mode, vault access cannot be recovered. ' +
                  'If you expected a passphrase backup, contact your administrator.'
              : 'Could not recover vault key. The passphrase backup may be missing or corrupted.',
            [
              {
                text: 'OK',
                onPress: () => navigation.goBack(),
              },
            ],
          );
          return;
        }
      }
      setStatusMessage('Decrypting...');
      const privateKey = await importPrivateKey(privateKeyJwk);
      const aesKey = await unwrapKey(wrappedKey, privateKey);
      const encryptedBytes = new Uint8Array(encryptedArrayBuffer);
      const authTag = encryptedBytes.slice(encryptedBytes.length - 16);
      const ciphertext = encryptedBytes.slice(0, encryptedBytes.length - 16);
      const ab2b64 = (buf) => {
        const bytes = new Uint8Array(buf);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
        return btoa(binary);
      };

      // FR-128: Decrypt in-memory — plaintext never touches disk
      const arrayBuffer = await decryptFile(
        aesKey,
        ab2b64(ciphertext.buffer),
        document.iv,
        ab2b64(authTag.buffer),
      );
      const base64 = ab2b64(arrayBuffer);
      setDataUri(`data:${document.mimeType};base64,${base64}`);
    } catch (err) {
      if (!doc) {
        showAlert(
          'Error',
          `Could not load document: ${err?.response?.status ?? ''} ${err?.response?.data?.error || err?.message || 'unknown error'}`,
        );
        navigation.goBack();
      } else {
        showAlert('Decryption Failed', err?.message || 'Could not decrypt document');
        setDecryptFailed(true);
      }
    } finally {
      setDecrypting(false);
      setLoading(false);
      setStatusMessage('');
    }
  }, [documentId, navigation]);

  // ── Options: share/export, rename, delete ──

  const scheduleTempFileCleanup = (uri) => {
    tempFileRef.current = uri;
    setTimeout(() => {
      if (tempFileRef.current === uri) {
        FileSystem.deleteAsync(uri, {
          idempotent: true,
        }).catch(() => {});
        tempFileRef.current = null;
      }
    }, TEMP_FILE_LIFETIME_MS);
  };
  const handleOpenExternally = async () => {
    if (!dataUri || !doc) return;
    setExporting(true);
    try {
      const canShare = await Sharing.isAvailableAsync();
      if (!canShare) {
        showAlert('Not available', 'Sharing is not available on this device.');
        return;
      }
      const base64 = dataUri.split(',')[1] ?? '';
      const ext = doc.name.includes('.') ? doc.name.split('.').pop() : 'bin';
      const tempUri = `${FileSystem.cacheDirectory}vault_export_${Date.now()}.${ext}`;
      await FileSystem.writeAsStringAsync(tempUri, base64, {
        encoding: FileSystem.EncodingType.Base64,
      });
      scheduleTempFileCleanup(tempUri);
      await Sharing.shareAsync(tempUri, {
        mimeType: doc.mimeType,
        dialogTitle: doc.name,
      });
    } catch (e) {
      showAlert('Could not open file', e?.message || 'Please try again.');
    } finally {
      setExporting(false);
    }
  };
  const openRename = () => {
    setShowOptions(false);
    setRenameValue(doc?.name || '');
    setRenaming(true);
  };
  const confirmRename = async () => {
    const name = renameValue.trim();
    if (!doc || !name) {
      setRenaming(false);
      return;
    }
    try {
      const updated = await vaultApi.updateDocument(doc.id, {
        name,
      });
      setDoc(updated);
    } catch (e) {
      showAlert('Error', e?.response?.data?.message || 'Could not rename');
    } finally {
      setRenaming(false);
    }
  };
  const confirmDelete = async () => {
    if (!doc) return;
    setDeleting(true);
    try {
      await vaultApi.deleteDocument(doc.id);
      navigation.goBack();
    } catch (e) {
      setDeleting(false);
      setShowDeleteConfirm(false);
      showAlert('Error', e?.response?.data?.message || 'Could not delete');
    }
  };

  // ── Audio playback ──

  const toggleAudio = async () => {
    if (!dataUri) return;
    try {
      if (!soundRef.current) {
        const { sound } = await Audio.Sound.createAsync(
          {
            uri: dataUri,
          },
          {
            shouldPlay: true,
          },
          (status) => {
            if (status.isLoaded && status.didJustFinish) setAudioStatus('paused');
          },
        );
        soundRef.current = sound;
        setAudioStatus('playing');
        return;
      }
      const status = await soundRef.current.getStatusAsync();
      if (status.isLoaded && status.isPlaying) {
        await soundRef.current.pauseAsync();
        setAudioStatus('paused');
      } else {
        await soundRef.current.playAsync();
        setAudioStatus('playing');
      }
    } catch (e) {
      showAlert('Playback failed', e?.message || 'Could not play audio');
    }
  };
  if (loading || decrypting) {
    return (
      <View style={[styles.root, styles.center]}>
        <StatusBar barStyle="light-content" backgroundColor={colors.shadow} />
        <ActivityIndicator size="large" color={colors.gold} />
        <Text style={styles.statusText}>{statusMessage}</Text>
      </View>
    );
  }
  if (!doc) return null;
  const category = categorize(doc.mimeType);
  const renderContent = () => {
    if (!dataUri || decryptFailed) {
      return (
        <View style={styles.fileCard}>
          <Text style={styles.fileIcon}>⚠️</Text>
          <Text style={styles.fileCardTitle} numberOfLines={2}>
            {doc.name}
          </Text>
          <Text style={styles.fileCardMeta}>Preview unavailable</Text>
        </View>
      );
    }
    switch (category) {
      case 'image':
        return (
          <Image
            source={{
              uri: dataUri,
            }}
            style={StyleSheet.absoluteFillObject}
            resizeMode="contain"
          />
        );
      case 'pdf':
        return (
          <Pdf
            source={{
              uri: dataUri,
            }}
            style={StyleSheet.absoluteFillObject}
            onError={(e) => showAlert('PDF error', String(e))}
          />
        );
      case 'video':
        return (
          <Video
            source={{
              uri: dataUri,
            }}
            style={StyleSheet.absoluteFillObject}
            useNativeControls
            resizeMode={ResizeMode.CONTAIN}
            shouldPlay
          />
        );
      case 'audio':
        return (
          <View style={styles.fileCard}>
            <Text style={styles.fileIcon}>🎵</Text>
            <Text style={styles.fileCardTitle} numberOfLines={2}>
              {doc.name}
            </Text>
            <Text style={styles.fileCardMeta}>{formatFileSize(doc.sizeBytes)}</Text>
            <TouchableOpacity style={styles.playBtn} onPress={toggleAudio} activeOpacity={0.85}>
              <GoldFill radius={9999} />
              <Text style={styles.playBtnText}>
                {audioStatus === 'playing' ? '⏸ Pause' : '▶ Play'}
              </Text>
            </TouchableOpacity>
          </View>
        );
      default:
        return (
          <View style={styles.fileCard}>
            <Text style={styles.fileIcon}>📄</Text>
            <Text style={styles.fileCardTitle} numberOfLines={2}>
              {doc.name}
            </Text>
            <Text style={styles.fileCardMeta}>
              {doc.mimeType} · {formatFileSize(doc.sizeBytes)}
            </Text>
            <Text style={styles.fileCardHint}>No in-app preview for this file type.</Text>
            <TouchableOpacity
              style={styles.openBtn}
              onPress={handleOpenExternally}
              disabled={exporting}
              activeOpacity={0.85}
            >
              <GoldFill radius={9999} disabled={exporting} />
              {exporting ? (
                <ActivityIndicator size="small" color={colors.onAccent} />
              ) : (
                <Text style={styles.openBtnText}>Open with another app</Text>
              )}
            </TouchableOpacity>
          </View>
        );
    }
  };
  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor={colors.shadow} />

      {/* Content — always full-bleed, header/footer float above it */}
      <View style={styles.content}>{renderContent()}</View>

      {/* Header overlay: back chevron + doc name + options */}
      <View
        style={[
          styles.header,
          {
            paddingTop: insets.top + 10,
          },
        ]}
      >
        <TouchableOpacity
          style={styles.headerBtn}
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
        <Text style={styles.headerTitle} numberOfLines={1}>
          {doc.name}
        </Text>
        <TouchableOpacity
          style={styles.headerBtn}
          onPress={() => setShowOptions(true)}
          hitSlop={{
            top: 8,
            bottom: 8,
            left: 8,
            right: 8,
          }}
        >
          <Text style={styles.optionsIcon}>⋯</Text>
        </TouchableOpacity>
      </View>

      {/* Footer overlay: auto-close countdown */}
      <View
        style={[
          styles.footer,
          {
            paddingBottom: insets.bottom + 16,
          },
        ]}
        pointerEvents="none"
      >
        <Text style={styles.autoClose}>Auto-closes in {formatLockTime(autoCloseSeconds)}</Text>
      </View>

      {/* Options action sheet */}
      <Modal
        visible={showOptions}
        transparent
        animationType="slide"
        onRequestClose={() => setShowOptions(false)}
      >
        <View style={styles.overlay}>
          <TouchableOpacity
            style={styles.backdrop}
            activeOpacity={1}
            onPress={() => setShowOptions(false)}
          />
          <View
            style={[
              styles.sheet,
              {
                paddingBottom: insets.bottom + 24,
              },
            ]}
          >
            <View style={styles.handle} />
            <TouchableOpacity
              style={styles.sheetOption}
              onPress={() => {
                setShowOptions(false);
                handleOpenExternally();
              }}
              disabled={!dataUri}
            >
              <Text style={styles.sheetOptionText}>Open with another app</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.sheetOption} onPress={openRename}>
              <Text style={styles.sheetOptionText}>Rename</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.sheetOption}
              onPress={() => {
                setShowOptions(false);
                setShowDeleteConfirm(true);
              }}
            >
              <Text style={[styles.sheetOptionText, styles.sheetOptionDanger]}>Delete</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.sheetOption} onPress={() => setShowOptions(false)}>
              <Text style={styles.sheetOptionText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Rename modal */}
      <Modal
        visible={renaming}
        transparent
        animationType="fade"
        onRequestClose={() => setRenaming(false)}
        statusBarTranslucent
        navigationBarTranslucent
      >
        <KeyboardAvoider style={styles.renameOverlay}>
          <View style={styles.renameCard}>
            <Text style={styles.renameTitle}>Rename document</Text>
            <TextInput
              style={styles.renameInput}
              value={renameValue}
              onChangeText={setRenameValue}
              autoFocus
              placeholder="New name"
              placeholderTextColor={colors.textMuted}
              maxLength={120}
            />
            <View style={styles.renameButtons}>
              <TouchableOpacity
                style={styles.renameCancel}
                onPress={() => setRenaming(false)}
                activeOpacity={0.7}
              >
                <Text style={styles.renameCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.renameSave}
                onPress={confirmRename}
                activeOpacity={0.85}
              >
                <GoldFill radius={10} />
                <Text style={styles.renameSaveText}>Save</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoider>
      </Modal>

      {/* Delete confirmation */}
      <ConfirmSheet
        visible={showDeleteConfirm}
        title="Delete Document"
        subtitle={`Delete "${doc.name}"? This cannot be undone.`}
        confirmLabel="Delete"
        loading={deleting}
        onConfirm={confirmDelete}
        onCancel={() => setShowDeleteConfirm(false)}
      />
    </View>
  );
}
const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.surfaceRaised,
  },
  center: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  statusText: {
    fontSize: 14,
    fontFamily: fonts.body,
    color: colors.textFaint,
    marginTop: 12,
  },
  content: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  header: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingBottom: 10,
    backgroundColor: withAlpha(colors.shadow, 0.72),
  },
  headerBtn: {
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
  optionsIcon: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.onAccent,
    lineHeight: 20,
  },
  headerTitle: {
    flex: 1,
    fontSize: 15,
    fontFamily: fonts.displayBold,
    color: colors.onAccent,
  },
  footer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    paddingTop: 12,
  },
  autoClose: {
    fontSize: 12,
    fontFamily: fonts.mono,
    color: colors.gold,
    backgroundColor: withAlpha(colors.shadow, 0.72),
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 9999,
    overflow: 'hidden',
  },
  fileCard: {
    width: 280,
    alignItems: 'center',
    paddingVertical: 32,
    paddingHorizontal: 24,
    backgroundColor: colors.surfaceRaised,
    borderRadius: 20,
  },
  fileIcon: {
    fontSize: 40,
    marginBottom: 14,
  },
  fileCardTitle: {
    fontSize: 15,
    fontFamily: fonts.displayBold,
    color: colors.onAccent,
    textAlign: 'center',
    marginBottom: 6,
  },
  fileCardMeta: {
    fontSize: 12,
    fontFamily: fonts.mono,
    color: colors.textMutedDark,
    textAlign: 'center',
  },
  fileCardHint: {
    fontSize: 12,
    fontFamily: fonts.body,
    color: colors.textFaint,
    textAlign: 'center',
    marginTop: 10,
    marginBottom: 4,
  },
  openBtn: {
    marginTop: 16,
    height: 46,
    paddingHorizontal: 24,
    borderRadius: 9999,
    backgroundColor: colors.gold,
    alignItems: 'center',
    justifyContent: 'center',
    ...goldButton.glow,
  },
  openBtnText: {
    fontSize: 14,
    fontFamily: fonts.displayBold,
    color: colors.onAccent,
  },
  playBtn: {
    marginTop: 16,
    height: 46,
    paddingHorizontal: 28,
    borderRadius: 9999,
    backgroundColor: colors.gold,
    alignItems: 'center',
    justifyContent: 'center',
    ...goldButton.glow,
  },
  playBtnText: {
    fontSize: 14,
    fontFamily: fonts.displayBold,
    color: goldButton.onGold,
  },
  // ── Options action sheet ──
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: withAlpha(colors.shadow, 0.55),
  },
  sheet: {
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
    marginBottom: 18,
  },
  sheetOption: {
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  sheetOptionText: {
    fontSize: 15,
    fontFamily: fonts.bodyMedium,
    color: colors.ink,
    textAlign: 'center',
  },
  sheetOptionDanger: {
    color: colors.danger,
  },
  // ── Rename modal ──
  renameOverlay: {
    flex: 1,
    backgroundColor: withAlpha(colors.shadow, 0.55),
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  renameCard: {
    backgroundColor: colors.surface,
    borderRadius: 20,
    padding: 20,
  },
  renameTitle: {
    fontSize: 17,
    fontFamily: fonts.displayBold,
    color: colors.ink,
    marginBottom: 14,
  },
  renameInput: {
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
  renameButtons: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
  },
  renameCancel: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: colors.surfaceWarm,
  },
  renameCancelText: {
    color: colors.textSecondary,
    fontSize: 14,
    fontFamily: fonts.bodySemiBold,
  },
  renameSave: {
    paddingHorizontal: 24,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: colors.gold,
    ...goldButton.glow,
  },
  renameSaveText: {
    color: goldButton.onGold,
    fontSize: 14,
    fontFamily: fonts.displayBold,
  },
});
