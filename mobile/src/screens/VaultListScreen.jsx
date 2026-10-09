/**
 * VaultListScreen — document vault (SCREEN 25 Locked + SCREEN 26 Unlocked).
 *
 * Design: dark theme from 05-Bills-Vault.html.
 *  - Locked (25): gold padlock, "Unlock vault" → native OS biometric prompt via
 *    getPrivateKey (hardware keychain requireAuthentication).
 *  - Unlocked (26): "Auto-locks in m:ss" countdown, 2-col grid of ink cards, gold FAB "+".
 * Long-press a card → white bottom sheet (View / Rename / Delete).
 */
import React, { useEffect, useMemo, useState, useCallback } from 'react';
import {
  AppState,
  SectionList,
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  RefreshControl,
  Modal,
  ActivityIndicator,
  StatusBar,
  TextInput,
} from 'react-native';
import { showAlert } from '../shared/services/themedAlert';
import Svg, { SvgXml, Rect, Path, Circle } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useVaultStore } from '../shared/store/vaultStore';
import { useAuthStore } from '../shared/store/authStore';
import { getVaultRepo } from '../shared/vault/vaultRepo';
import { fingerprint, loadAccountPrivateKey } from '../shared/crypto/accountKey';
import Avatar from '../components/Avatar';
import { formatFileSize, formatDate } from '../shared/utils/format';
import { colors, fonts, goldButton, radius, withAlpha } from '../shared/theme';
import { GoldFill } from '../shared/components/GoldButton';
import EmptyState from '../components/EmptyState';
import ErrorState from '../components/ErrorState';
import LoadingSkeleton from '../components/LoadingSkeleton';
import OfflineBanner from '../components/OfflineBanner';
import ConfirmSheet from '../components/ConfirmSheet';
import { KeyboardAvoider } from '../shared/components/KeyboardAware';
const AUTO_LOCK_SECONDS = 300; // 5 minutes (mock: "Auto-locks in 4:52")

const VAULT_SVG =
  '<svg width="26" height="26" viewBox="0 0 24 24" fill="none">' +
  `<rect x="3" y="7" width="18" height="13" rx="2" stroke="${colors.gold}" stroke-width="1.5"></rect>` +
  `<path d="M8 7l1.5-3h5L16 7" stroke="${colors.gold}" stroke-width="1.5" stroke-linejoin="round"></path>` +
  `<circle cx="12" cy="13.5" r="3.5" stroke="${colors.gold}" stroke-width="1.5"></circle>` +
  '</svg>';

/** Coarse type label shown on the top of each card (mock {{ d.type }}). */
function documentType(mimeType) {
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType?.startsWith('image/')) return 'image';
  return 'document';
}
const chunk = (list, size) => {
  const rows = [];
  for (let i = 0; i < list.length; i += size) rows.push(list.slice(i, i + size));
  return rows;
};
function formatLockTime(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
export default function VaultListScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const { documents, loading, refreshing, error } = useVaultStore();
  const me = useAuthStore((s) => s.user);
  const [changedMembers, setChangedMembers] = useState([]);
  const [safetySheet, setSafetySheet] = useState({ visible: false, prints: {} });
  const [locked, setLocked] = useState(true);
  const [unlockLoading, setUnlockLoading] = useState(false);
  const [autoLockSeconds, setAutoLockSeconds] = useState(AUTO_LOCK_SECONDS);
  const [showActionSheet, setShowActionSheet] = useState({
    visible: false,
    document: null,
  });
  const [renameModal, setRenameModal] = useState({
    visible: false,
    document: null,
    value: '',
  });
  const [deleteDoc, setDeleteDoc] = useState(null);

  // Auto-lock countdown runs only while unlocked
  useEffect(() => {
    if (locked) return;
    const id = setInterval(() => {
      setAutoLockSeconds((s) => (s <= 1 ? 0 : s - 1));
    }, 1000);
    return () => clearInterval(id);
  }, [locked]);
  useEffect(() => {
    if (autoLockSeconds === 0 && !locked) setLocked(true);
  }, [autoLockSeconds, locked]);
  const handleUnlock = useCallback(async () => {
    setUnlockLoading(true);
    try {
      const user = useAuthStore.getState().user;
      if (!user?.id) return;

      // Loading the key fires the Face ID / fingerprint prompt (hardware keychain
      // requireAuthentication). The gate around this screen guarantees this phone holds it.
      let key;
      try {
        key = await loadAccountPrivateKey(user.id);
      } catch {
        // Authentication failed or was cancelled: stay locked.
        showAlert(
          'Authentication failed',
          'Could not verify your fingerprint or Face ID. Please try again.',
        );
        return;
      }
      if (!key) {
        showAlert('Private space not on this phone', 'Move it here or restore it from your backup in Privacy & security.');
        return;
      }
      setLocked(false);
      setAutoLockSeconds(AUTO_LOCK_SECONDS);
    } finally {
      setUnlockLoading(false);
    }
  }, []);

  // Fetch documents when vault becomes unlocked
  const syncSharing = useCallback(async () => {
    try {
      const repo = getVaultRepo();
      await repo.grantPending();
      setChangedMembers((await repo.memberKeyStatus()).changed);
    } catch {
      /* best effort, silent */
    }
  }, []);
  useEffect(() => {
    if (!locked) {
      useVaultStore.getState().fetchDocuments();
      syncSharing();
    }
  }, [locked, syncSharing]);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      getVaultRepo().onAppStateChange(next);
      if (next === 'active' && !locked) syncSharing();
    });
    return () => sub.remove();
  }, [locked, syncSharing]);
  useEffect(() => {
    if (locked) getVaultRepo().clear();
  }, [locked]);
  useEffect(() => () => getVaultRepo().clear(), []);
  const closeSafetySheet = () => setSafetySheet({ visible: false, prints: {} });
  const openSafetySheet = async () => {
    const prints = {};
    for (const m of changedMembers) {
      prints[m.userId] = {
        before: m.pinnedKey ? await fingerprint(m.pinnedKey) : '-',
        now: await fingerprint(m.publicKey),
      };
    }
    setSafetySheet({ visible: true, prints });
  };
  const trustMember = async (m) => {
    try {
      await getVaultRepo().confirmMemberKey(m.userId, m.publicKey);
      const left = changedMembers.filter((x) => x.userId !== m.userId);
      setChangedMembers(left);
      if (!left.length) closeSafetySheet();
      syncSharing();
    } catch {
      showAlert('Error', 'Could not save that. Please try again.');
    }
  };
  const handleRefresh = useCallback(async () => {
    await useVaultStore.getState().fetchDocuments(true);
  }, []);
  const loadMore = useCallback(async () => {
    await useVaultStore.getState().fetchMoreDocuments();
  }, []);
  const openViewer = (document) => {
    navigation.navigate('VaultViewer', {
      documentId: document.id,
    });
  };
  const handleDelete = (document) => {
    setDeleteDoc(document);
  };
  const confirmDelete = async () => {
    if (!deleteDoc) return;
    try {
      await getVaultRepo().remove(deleteDoc.id);
      useVaultStore.getState().removeDocument(deleteDoc.id);
      setDeleteDoc(null);
      showAlert('Deleted', 'Document deleted successfully');
    } catch (e) {
      setDeleteDoc(null);
      showAlert('Error', e?.response?.data?.message || 'Could not delete');
    }
  };
  const openRename = (document) => {
    setRenameModal({
      visible: true,
      document,
      value: document.name,
    });
  };
  const closeRename = () =>
    setRenameModal({
      visible: false,
      document: null,
      value: '',
    });
  const confirmRename = async () => {
    const doc = renameModal.document;
    const name = renameModal.value.trim();
    if (!doc || !name) {
      closeRename();
      return;
    }
    try {
      await getVaultRepo().rename(doc, name);
      useVaultStore.getState().updateDocument({
        ...doc,
        name,
      });
    } catch (e) {
      showAlert('Error', e?.response?.data?.message || 'Could not rename');
    } finally {
      closeRename();
    }
  };
  const openActionSheet = (document) =>
    setShowActionSheet({
      visible: true,
      document,
    });
  const closeActionSheet = () =>
    setShowActionSheet({
      visible: false,
      document: null,
    });
  const renderCard = (item) => (
    <TouchableOpacity
      key={item.id}
      style={styles.card}
      onPress={() => (item.pending
        ? showAlert('Not ready yet', 'This file opens once another family member opens Rootaroo on their phone.')
        : openViewer(item))}
      onLongPress={() => openActionSheet(item)}
      delayLongPress={350}
      activeOpacity={0.85}
    >
      <View style={styles.cardTop}>
        <Text style={styles.cardType} numberOfLines={1}>
          {documentType(item.mimeType)}
        </Text>
        {item.pending && (
          <View style={styles.pendingBadge}>
            <Text style={styles.pendingBadgeText}>Waiting</Text>
          </View>
        )}
      </View>
      <View>
        <Text style={styles.cardName} numberOfLines={2}>
          {item.name}
        </Text>
        <Text style={styles.cardMeta} numberOfLines={1}>
          {formatFileSize(item.sizeBytes)} · {formatDate(item.createdAt)}
        </Text>
        {item.uploadedBy && (
          <View style={styles.cardUploader}>
            <Avatar
              url={item.uploadedBy.avatarUrl}
              emoji={item.uploadedBy.avatarEmoji}
              name={item.uploadedBy.displayName}
              id={item.uploadedBy.id}
              size={16}
            />
            <Text style={styles.cardUploaderText} numberOfLines={1}>
              {item.uploadedBy.displayName}
            </Text>
          </View>
        )}
      </View>
    </TouchableOpacity>
  );

  const renderRow = ({ item: row }) => (
    <View style={styles.gridRow}>
      {row.map(renderCard)}
      {row.length === 1 && <View style={styles.cardSpacer} />}
    </View>
  );
  const sections = useMemo(
    () => [
      { title: 'Household', data: chunk(documents.filter((d) => d.scope === 'household'), 2) },
      { title: 'Personal', data: chunk(documents.filter((d) => d.scope !== 'household'), 2) },
    ].filter((sec) => sec.data.length),
    [documents],
  );

  /** Loading / error / empty content for the grid — never a bare black screen. */
  const renderListState = () => {
    if (loading) {
      return <LoadingSkeleton variant="vault" dark />;
    }
    if (error) {
      return (
        <View style={styles.stateWrap}>
          <ErrorState
            dark
            onRetry={handleRefresh}
            onGoHome={() => navigation.navigate('KnowsDashboard')}
          />
        </View>
      );
    }
    return (
      <View style={styles.stateWrap}>
        <EmptyState
          dark
          icon={<SvgXml xml={VAULT_SVG} width={26} height={26} />}
          title="No documents yet"
          subtitle="Add passports, IDs, or anything else worth keeping safe."
          actionLabel="Upload a document"
          onAction={() => navigation.navigate('VaultUpload')}
        />
      </View>
    );
  };

  // ── Locked state (SCREEN 25) ──
  if (locked) {
    return (
      <View style={styles.root}>
        <StatusBar barStyle="light-content" backgroundColor={colors.shadow} />

        <View
          style={[
            styles.header,
            {
              paddingTop: insets.top,
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
        </View>

        <View style={styles.locked}>
          <View style={styles.lockedBody}>
            <Svg width={110} height={110} viewBox="0 0 130 130" style={styles.lockIcon}>
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
            <Text style={styles.lockTitle}>Document vault</Text>
            <Text style={styles.lockSubtitle}>
              Passports, IDs, and other important files, protected behind biometric unlock.
            </Text>
          </View>
        </View>

        <View
          style={[
            styles.lockedFooter,
            {
              paddingBottom: insets.bottom + 24,
            },
          ]}
        >
          <TouchableOpacity
            style={[styles.unlockButton, unlockLoading && styles.buttonDisabled]}
            onPress={handleUnlock}
            disabled={unlockLoading}
            activeOpacity={0.85}
          >
            <GoldFill radius={9999} disabled={unlockLoading} />
            {unlockLoading ? (
              <ActivityIndicator size="small" color={colors.onAccent} />
            ) : (
              <Text style={styles.unlockButtonText}>Unlock vault</Text>
            )}
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // ── Unlocked state (SCREEN 26) ──
  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor={colors.shadow} />

      <View
        style={[
          styles.header,
          {
            paddingTop: insets.top,
            height: 56 + insets.top,
            gap: 12,
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
        <Text style={styles.headerTitle}>Vault</Text>
        <Text style={styles.lockCountdown}>Auto-locks in {formatLockTime(autoLockSeconds)}</Text>
      </View>

      <View style={styles.bannerWrap}>
        <OfflineBanner dark onRetry={handleRefresh} />
      </View>

      {changedMembers.length > 0 && (
        <TouchableOpacity style={styles.keyBanner} onPress={openSafetySheet} activeOpacity={0.85}>
          <Text style={styles.keyBannerTitle}>
            {changedMembers.map((m) => m.displayName).join(', ')} has a new key
          </Text>
          <Text style={styles.keyBannerBody}>Sharing with them is paused. Tap to compare safety numbers.</Text>
        </TouchableOpacity>
      )}

      <SectionList
        sections={sections}
        renderItem={renderRow}
        renderSectionHeader={({ section }) => <Text style={styles.sectionTitle}>{section.title}</Text>}
        keyExtractor={(row) => row[0].id}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={styles.gridContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={colors.gold}
            colors={[colors.gold]}
          />
        }
        onEndReached={loadMore}
        onEndReachedThreshold={0.3}
        ListEmptyComponent={renderListState}
        ListFooterComponent={
          loading && documents.length > 0 ? (
            <ActivityIndicator color={colors.gold} style={styles.listFooter} />
          ) : null
        }
      />

      <TouchableOpacity
        style={[
          styles.fab,
          {
            bottom: insets.bottom + 40,
          },
        ]}
        onPress={() => navigation.navigate('VaultUpload')}
        activeOpacity={0.85}
      >
        <GoldFill radius={28} />
        <Text style={styles.fabText}>+</Text>
      </TouchableOpacity>

      {/* ── Long-press action sheet (white bottom sheet over dark vault) ── */}
      <Modal
        visible={showActionSheet.visible}
        transparent
        animationType="slide"
        onRequestClose={closeActionSheet}
      >
        <View style={styles.overlay}>
          <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={closeActionSheet} />
          <View
            style={[
              styles.sheet,
              {
                paddingBottom: insets.bottom + 24,
              },
            ]}
          >
            <View style={styles.handle} />
            <Text style={styles.sheetTitle} numberOfLines={1}>
              {showActionSheet.document?.name}
            </Text>
            <TouchableOpacity
              style={styles.sheetOption}
              onPress={() => {
                if (showActionSheet.document) openViewer(showActionSheet.document);
                closeActionSheet();
              }}
            >
              <Text style={styles.sheetOptionText}>View</Text>
            </TouchableOpacity>
            {showActionSheet.document?.mine && !showActionSheet.document?.unreadable && !showActionSheet.document?.pending && (
              <TouchableOpacity
                style={styles.sheetOption}
                onPress={() => {
                  if (showActionSheet.document) openRename(showActionSheet.document);
                  closeActionSheet();
                }}
              >
                <Text style={styles.sheetOptionText}>Rename</Text>
              </TouchableOpacity>
            )}
            {(showActionSheet.document?.mine || me?.role === 'admin') && (
              <TouchableOpacity
                style={styles.sheetOption}
                onPress={() => {
                  if (showActionSheet.document) handleDelete(showActionSheet.document);
                  closeActionSheet();
                }}
              >
                <Text style={[styles.sheetOptionText, styles.sheetOptionDanger]}>Delete</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity style={styles.sheetOption} onPress={closeActionSheet}>
              <Text style={styles.sheetOptionText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* ── Rename modal ── */}
      <Modal
        visible={renameModal.visible}
        transparent
        animationType="fade"
        onRequestClose={closeRename}
        statusBarTranslucent
        navigationBarTranslucent
      >
        <KeyboardAvoider style={styles.renameOverlay}>
          <View style={styles.renameCard}>
            <Text style={styles.renameTitle}>Rename document</Text>
            <TextInput
              style={styles.renameInput}
              value={renameModal.value}
              onChangeText={(v) =>
                setRenameModal((m) => ({
                  ...m,
                  value: v,
                }))
              }
              autoFocus
              placeholder="New name"
              placeholderTextColor={colors.textMuted}
              maxLength={120}
            />
            <View style={styles.renameButtons}>
              <TouchableOpacity
                style={styles.renameCancel}
                onPress={closeRename}
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

      {/* ── Compare safety numbers ── */}
      <Modal visible={safetySheet.visible} transparent animationType="slide" onRequestClose={closeSafetySheet}>
        <View style={styles.overlay}>
          <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={closeSafetySheet} />
          <View style={[styles.sheet, { paddingBottom: insets.bottom + 24 }]}>
            <View style={styles.handle} />
            <Text style={styles.sheetTitle}>Compare safety numbers</Text>
            <Text style={styles.safetyHelp}>
              Ask them, in person, to read the safety number on their phone. Only trust the new key if it matches the
              Now number.
            </Text>
            {changedMembers.map((m) => (
              <View key={m.userId} style={styles.safetyBlock}>
                <Text style={styles.safetyName}>{m.displayName}</Text>
                <Text style={styles.safetyLabel}>Before</Text>
                <Text style={styles.safetyPrint}>{safetySheet.prints[m.userId]?.before}</Text>
                <Text style={styles.safetyLabel}>Now</Text>
                <Text style={styles.safetyPrint}>{safetySheet.prints[m.userId]?.now}</Text>
                <TouchableOpacity style={styles.trustBtn} onPress={() => trustMember(m)} activeOpacity={0.85}>
                  <GoldFill radius={10} />
                  <Text style={styles.renameSaveText}>They match, trust it</Text>
                </TouchableOpacity>
              </View>
            ))}
            <TouchableOpacity style={styles.sheetOption} onPress={closeSafetySheet}>
              <Text style={styles.sheetOptionText}>Not now</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Delete document confirmation sheet */}
      <ConfirmSheet
        visible={!!deleteDoc}
        title="Delete Document"
        subtitle={deleteDoc ? `Delete "${deleteDoc.name}"? This cannot be undone.` : ''}
        confirmLabel="Delete"
        onConfirm={confirmDelete}
        onCancel={() => setDeleteDoc(null)}
      />
    </View>
  );
}
const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.surfaceRaised,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  stateWrap: {
    flex: 1,
  },
  bannerWrap: {
    paddingHorizontal: 24,
    paddingTop: 4,
    paddingBottom: 8,
  },
  // Skeleton grid (first-load placeholder)
  skeletonContainer: {
    gap: 14,
    paddingTop: 8,
  },
  skeletonRow: {
    flexDirection: 'row',
    gap: 14,
  },
  skeletonCard: {
    flex: 1,
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.cardLg,
    padding: 16,
    height: 122,
    justifyContent: 'space-between',
    opacity: 0.9,
  },
  skeletonType: {
    width: 44,
    height: 11,
    borderRadius: 3,
    backgroundColor: colors.textMutedDark,
    opacity: 0.5,
  },
  skeletonLine: {
    height: 14,
    borderRadius: 3,
    backgroundColor: colors.textMutedDark,
    opacity: 0.4,
    marginTop: 8,
    width: '80%',
  },
  skeletonLineShort: {
    height: 11,
    borderRadius: 3,
    backgroundColor: colors.textMutedDark,
    opacity: 0.35,
    marginTop: 6,
    width: '55%',
  },
  // ── Locked (SCREEN 25) ──
  locked: {
    flex: 1,
  },
  lockedBody: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 40,
  },
  lockIcon: {
    marginBottom: 26,
  },
  lockTitle: {
    fontSize: 25,
    lineHeight: 33,
    fontFamily: fonts.displayBold,
    color: colors.onAccent,
    textAlign: 'center',
    marginBottom: 12,
  },
  lockSubtitle: {
    fontSize: 14,
    lineHeight: 21,
    fontFamily: fonts.body,
    color: colors.textFaint,
    textAlign: 'center',
  },
  lockedFooter: {
    paddingHorizontal: 32,
  },
  unlockButton: {
    height: 54,
    borderRadius: 9999,
    backgroundColor: colors.gold,
    alignItems: 'center',
    justifyContent: 'center',
    ...goldButton.glow,
  },
  unlockButtonText: {
    fontSize: 15,
    fontFamily: fonts.displayBold,
    color: colors.onAccent,
  },
  // ── Header (shared: locked back-only row + unlocked title row) ──
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
    fontSize: 20,
    fontWeight: '700',
    color: colors.onAccent,
    lineHeight: 20,
  },
  headerTitle: {
    flex: 1,
    fontSize: 17,
    fontFamily: fonts.displayBold,
    color: colors.onAccent,
  },
  lockCountdown: {
    fontSize: 12,
    fontFamily: fonts.mono,
    color: colors.gold,
  },
  // Grid
  gridContent: {
    paddingHorizontal: 24,
    paddingTop: 12,
    paddingBottom: 104,
    flexGrow: 1,
  },
  gridRow: {
    flexDirection: 'row',
    gap: 14,
    marginBottom: 14,
  },
  card: {
    flex: 1,
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.cardLg,
    padding: 16,
    height: 142,
    justifyContent: 'space-between',
  },
  cardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  cardSpacer: {
    flex: 1,
  },
  pendingBadge: {
    backgroundColor: withAlpha(colors.gold, 0.2),
    borderRadius: 8,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  pendingBadgeText: {
    fontSize: 10,
    fontFamily: fonts.bodySemiBold,
    color: colors.gold,
  },
  sectionTitle: {
    fontSize: 13,
    fontFamily: fonts.displayBold,
    color: colors.textFaint,
    marginTop: 6,
    marginBottom: 10,
  },
  keyBanner: {
    marginHorizontal: 24,
    marginBottom: 8,
    padding: 14,
    borderRadius: radius.cardLg,
    backgroundColor: withAlpha(colors.danger, 0.18),
    borderWidth: 1,
    borderColor: colors.danger,
  },
  keyBannerTitle: {
    fontSize: 14,
    fontFamily: fonts.displayBold,
    color: colors.onAccent,
  },
  keyBannerBody: {
    fontSize: 12,
    fontFamily: fonts.body,
    color: colors.textFaint,
    marginTop: 2,
  },
  safetyHelp: {
    fontSize: 13,
    lineHeight: 19,
    fontFamily: fonts.body,
    color: colors.textSecondary,
    textAlign: 'center',
    marginBottom: 12,
  },
  safetyBlock: {
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    gap: 4,
  },
  safetyName: {
    fontSize: 15,
    fontFamily: fonts.displayBold,
    color: colors.ink,
  },
  safetyLabel: {
    fontSize: 11,
    fontFamily: fonts.bodySemiBold,
    color: colors.textMuted,
    marginTop: 4,
  },
  safetyPrint: {
    fontSize: 14,
    fontFamily: fonts.mono,
    color: colors.ink,
  },
  trustBtn: {
    marginTop: 10,
    height: 44,
    borderRadius: 10,
    backgroundColor: colors.gold,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardType: {
    fontSize: 11,
    fontFamily: fonts.mono,
    color: colors.textFaint,
  },
  cardName: {
    fontSize: 14,
    lineHeight: 19,
    fontFamily: fonts.displayBold,
    color: colors.onAccent,
  },
  cardMeta: {
    fontSize: 11,
    fontFamily: fonts.body,
    color: colors.textMutedDark,
    marginTop: 4,
  },
  cardUploader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 6,
  },
  cardUploaderText: {
    flex: 1,
    fontSize: 10,
    fontFamily: fonts.body,
    color: colors.textMutedDark,
  },
  listFooter: {
    marginVertical: 16,
  },
  // FAB
  fab: {
    position: 'absolute',
    right: 24,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.gold,
    alignItems: 'center',
    justifyContent: 'center',
    ...goldButton.glow,
  },
  fabText: {
    fontSize: 24,
    fontFamily: fonts.displayBold,
    color: goldButton.onGold,
    lineHeight: 28,
  },
  // Empty
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  emptyIcon: {
    fontSize: 56,
    marginBottom: 12,
  },
  emptyTitle: {
    fontSize: 18,
    fontFamily: fonts.displayBold,
    color: colors.onAccent,
    marginBottom: 6,
  },
  emptySubtitle: {
    fontSize: 14,
    fontFamily: fonts.body,
    color: colors.textFaint,
    textAlign: 'center',
  },
  emptyAddButton: {
    backgroundColor: colors.gold,
    paddingHorizontal: 24,
    paddingVertical: 14,
    borderRadius: 9999,
    marginTop: 16,
    shadowOpacity: 0,
    shadowRadius: 0,
    elevation: 0,
  },
  emptyAddButtonText: {
    color: colors.onAccent,
    fontSize: 15,
    fontFamily: fonts.displayBold,
  },
  // ── Action sheet (white bottom sheet) ──
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
  sheetTitle: {
    fontSize: 16,
    fontFamily: fonts.displayBold,
    color: colors.ink,
    textAlign: 'center',
    marginBottom: 8,
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
