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
 *   - The vault repo opens the sealed file key with the account private key from
 *     the hardware keychain (biometric-gated), then decrypts the file, its name
 *     and its type on this phone. A phone without the key never gets this far:
 *     the vault screen shows the "private space is on another phone" gate instead.
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
  Modal,
  TextInput,
} from 'react-native';
import { showAlert } from '../shared/services/themedAlert';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Pdf from 'react-native-pdf';
import { Video, ResizeMode, Audio } from 'expo-av';
import * as Sharing from 'expo-sharing';
import { useAuthStore } from '../shared/store/authStore';
import { useVaultStore } from '../shared/store/vaultStore';
import { getVaultRepo, isKeyMissing, isMemberKeyChanged } from '../shared/vault/vaultRepo';
import { formatFileSize } from '../shared/utils/format';
import * as ScreenCapture from 'expo-screen-capture';
import { colors, fonts, goldButton, withAlpha } from '../shared/theme';
import { GoldFill } from '../shared/components/GoldButton';
import ConfirmSheet from '../components/ConfirmSheet';
import { KeyboardAvoider } from '../shared/components/KeyboardAware';
function categorize(mimeType = '') {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'other';
}
const AUTO_CLOSE_SECONDS = 300; // 5 minutes — mock: "Auto-closes in 0:48"

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
  const me = useAuthStore((st) => st.user);
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

  // FR-129: Block screenshots at OS level while this screen is mounted
  ScreenCapture.usePreventScreenCapture('vault-viewer');
  ScreenCapture.useScreenshotListener(() => {
    showAlert('Screenshot Blocked', 'Screenshots are disabled for vault documents (FR-129).');
  });
  useEffect(() => {
    loadAndDecrypt();
  }, [documentId]);

  // Stop any playing sound on unmount (exported temp files are deleted by the repo)
  useEffect(() => {
    return () => {
      soundRef.current?.unloadAsync().catch(() => {});
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

  const loadAndDecrypt = useCallback(async () => {
    try {
      setStatusMessage('Decrypting...');
      setDecrypting(true);
      const { doc: opened, dataUri: uri } = await getVaultRepo().open(documentId);
      setDoc(opened);
      setDataUri(uri);
    } catch (err) {
      if (isKeyMissing(err)) {
        showAlert('Private space not on this phone', 'Move it here or restore it from your backup in Privacy & security.', [
          { text: 'OK', onPress: () => navigation.goBack() },
        ]);
      } else {
        showAlert('Could not open this file', err?.response?.data?.message || err?.message || 'Please try again.', [
          { text: 'OK', onPress: () => navigation.goBack() },
        ]);
        setDecryptFailed(true);
      }
    } finally {
      setDecrypting(false);
      setLoading(false);
      setStatusMessage('');
    }
  }, [documentId, navigation]);

  // ── Options: share/export, rename, scope, delete ──

  const handleOpenExternally = async () => {
    if (!doc) return;
    setExporting(true);
    try {
      const canShare = await Sharing.isAvailableAsync();
      if (!canShare) {
        showAlert('Not available', 'Sharing is not available on this device.');
        return;
      }
      // The only path that writes plaintext to disk; the repo deletes it after a minute.
      const { uri } = await getVaultRepo().open(doc, { asFile: true });
      await Sharing.shareAsync(uri, {
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
      await getVaultRepo().rename(doc, name);
      const updated = { ...doc, name };
      setDoc(updated);
      useVaultStore.getState().updateDocument(updated);
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
      await getVaultRepo().remove(doc.id);
      useVaultStore.getState().removeDocument(doc.id);
      navigation.goBack();
    } catch (e) {
      setDeleting(false);
      setShowDeleteConfirm(false);
      showAlert('Error', e?.response?.data?.message || 'Could not delete');
    }
  };

  const switchScope = async () => {
    setShowOptions(false);
    const next = doc.scope === 'household' ? 'personal' : 'household';
    try {
      await getVaultRepo().setScope(doc, next);
      const updated = { ...doc, scope: next };
      setDoc(updated);
      useVaultStore.getState().updateDocument(updated);
    } catch (e) {
      if (isMemberKeyChanged(e)) {
        showAlert('Check a safety number first', 'Someone in your household has a new key. Open the vault and compare safety numbers with them in person before sharing.');
      } else {
        showAlert('Error', e?.response?.data?.message || 'Could not change who can open this file');
      }
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
  const canDelete = doc.mine || me?.role === 'admin';
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
            {doc.mine && (
              <>
                <TouchableOpacity style={styles.sheetOption} onPress={openRename}>
                  <Text style={styles.sheetOptionText}>Rename</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.sheetOption} onPress={switchScope}>
                  <Text style={styles.sheetOptionText}>
                    {doc.scope === 'household' ? 'Make Personal (only me)' : 'Make Household (adults)'}
                  </Text>
                </TouchableOpacity>
              </>
            )}
            {canDelete && (
              <TouchableOpacity
                style={styles.sheetOption}
                onPress={() => {
                  setShowOptions(false);
                  setShowDeleteConfirm(true);
                }}
              >
                <Text style={[styles.sheetOptionText, styles.sheetOptionDanger]}>Delete</Text>
              </TouchableOpacity>
            )}
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
