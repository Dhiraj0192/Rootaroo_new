import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  StatusBar,
  Modal,
  Pressable,
  Share,
} from 'react-native';
import { showAlert } from '../shared/services/themedAlert';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import QRCodeSvg from 'react-native-qrcode-svg';
import * as Clipboard from 'expo-clipboard';
import { useAuthStore } from '../shared/store/authStore';
import { householdApi } from '../shared/api/household';
import { colors, fonts, goldButton, radius, withAlpha } from '../shared/theme';
import { GoldFill } from '../shared/components/GoldButton';
import ConfirmSheet from '../components/ConfirmSheet';
import Avatar from '../components/Avatar';
import { useTabBarDockHeight } from '../shared/hooks/useTabBarDockHeight';
// Role options match mock Screen 37 exactly — Admin & Member only.
// The QR needs a light quiet zone to stay scannable, so this tile stays warm
// off-white in every theme — it is a scanning surface, not a themed one.
const QR_TILE_BG = '#F4F0E6';

const ROLE_OPTIONS = [
  {
    key: 'admin',
    label: 'Admin',
  },
  {
    key: 'member',
    label: 'Member',
  },
];

// Display mapping — backend `child` renders as Member (mock shows only Admin/Member).
const ROLE_DISPLAY = {
  admin: 'Admin',
  member: 'Member',
  child: 'Member',
};
export default function HouseholdSettingsScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const dockHeight = useTabBarDockHeight();
  const user = useAuthStore((s) => s.user);
  const householdId = useAuthStore((s) => s.householdId);
  const [members, setMembers] = useState([]);
  const [householdName, setHouseholdName] = useState('');
  const [createdAt, setCreatedAt] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [myRole, setMyRole] = useState('');
  const [scheduledDeletionAt, setScheduledDeletionAt] = useState(null);
  const [pendingRequest, setPendingRequest] = useState(null);
  const [pendingLeaveRequest, setPendingLeaveRequest] = useState(null);
  const [leaveReviewLoading, setLeaveReviewLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);
  const [oneTimeInvite, setOneTimeInvite] = useState(null);
  const [generatingInvite, setGeneratingInvite] = useState(false);
  const [oneTimeCodeCopied, setOneTimeCodeCopied] = useState(false);
  const [showRoleModal, setShowRoleModal] = useState(false);
  const [managing, setManaging] = useState(false);
  const [selectedMember, setSelectedMember] = useState(null);
  const [selectedRole, setSelectedRole] = useState('member');

  // Destructive confirm sheets
  const [confirmRemoveMember, setConfirmRemoveMember] = useState(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const currentUserRole = myRole || user?.role || 'member';
  const isAdmin = currentUserRole === 'admin';
  const isChild = currentUserRole === 'child';
  const joinLink = inviteCode ? `rootaru://join?code=${inviteCode}` : null;
  const memberCountLabel = `${members.length} member${members.length === 1 ? '' : 's'}`;
  const joinedOn = (iso) =>
    iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : null;
  const load = useCallback(async () => {
    if (!householdId) {
      setLoading(false);
      return;
    }
    try {
      const [hh, memberList, pending, pendingLeave] = await Promise.all([
        householdApi.getHousehold(householdId),
        householdApi.getMembers(householdId),
        householdApi.getMyPendingActionRequest(householdId),
        // 403s for non-admins — harmless, just means nothing to review.
        householdApi.getPendingLeaveRequest(householdId).catch(() => null),
      ]);
      setHouseholdName(hh.name);
      setInviteCode(hh.inviteCode);
      setMyRole(hh.role);
      setCreatedAt(hh.createdAt);
      setScheduledDeletionAt(hh.scheduledDeletionAt);
      setMembers(memberList);
      setPendingRequest(pending);
      setPendingLeaveRequest(pendingLeave);
    } catch {
      showAlert('Error', 'Failed to load household settings.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [householdId]);
  useEffect(() => {
    load();
  }, [load]);
  const handleCopyInvite = async () => {
    if (!inviteCode) return;
    await Clipboard.setStringAsync(inviteCode);
    setCodeCopied(true);
    setTimeout(() => setCodeCopied(false), 2000);
  };
  const handleShareInvite = async () => {
    if (!inviteCode) return;
    try {
      await Share.share({
        message: `Join our household on Rootaroo! Use invite code: ${inviteCode}`,
      });
    } catch {
      /* dismissed */
    }
  };
  // Non-admin members (not children — server blocks them) can't see the
  // household's permanent invite code, but can generate their own one-time,
  // 7-day-expiring one instead — safer than exposing a standing, reusable
  // credential to everyone, and doesn't require the admin to hand it out.
  const handleGenerateInvite = async () => {
    if (!householdId) return;
    setGeneratingInvite(true);
    try {
      const invite = await householdApi.generateInvite(householdId);
      setOneTimeInvite(invite);
    } catch (e) {
      showAlert('Error', e?.response?.data?.error || 'Failed to generate invite.');
    } finally {
      setGeneratingInvite(false);
    }
  };
  const handleCopyOneTimeInvite = async () => {
    if (!oneTimeInvite) return;
    await Clipboard.setStringAsync(oneTimeInvite.code);
    setOneTimeCodeCopied(true);
    setTimeout(() => setOneTimeCodeCopied(false), 2000);
  };
  const handleShareOneTimeInvite = async () => {
    if (!oneTimeInvite) return;
    try {
      await Share.share({
        message: `Join our household on Rootaroo! Use invite code: ${oneTimeInvite.code}`,
      });
    } catch {
      /* dismissed */
    }
  };
  const handleSaveRole = async () => {
    if (!selectedMember || !householdId) return;

    // The server's changeRole endpoint refuses `role: 'admin'` outright — a
    // single-admin household can only mint a new admin via the dedicated
    // transfer endpoint, which demotes the caller in the same swap. Route
    // that case there instead of letting it hit the server and 400.
    if (selectedRole === 'admin') {
      showAlert(
        'Transfer Admin Role?',
        `${selectedMember.displayName} will become the household admin and you'll become a regular member.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Transfer',
            style: 'destructive',
            onPress: async () => {
              setActionLoading(true);
              try {
                await householdApi.transferAdmin(householdId, selectedMember.userId);
                setMembers((p) =>
                  p.map((m) => {
                    if (m.userId === selectedMember.userId) return { ...m, role: 'admin' };
                    if (m.userId === user?.id) return { ...m, role: 'member' };
                    return m;
                  }),
                );
                setMyRole('member');
                setShowRoleModal(false);
                setSelectedMember(null);
              } catch (e) {
                showAlert('Error', e?.response?.data?.error || 'Failed to transfer admin.');
              } finally {
                setActionLoading(false);
              }
            },
          },
        ],
      );
      return;
    }

    setActionLoading(true);
    try {
      await householdApi.changeRole(householdId, selectedMember.userId, selectedRole);
      setMembers((p) =>
        p.map((m) =>
          m.userId === selectedMember.userId
            ? {
                ...m,
                role: selectedRole,
              }
            : m,
        ),
      );
      setShowRoleModal(false);
      setSelectedMember(null);
    } catch (e) {
      showAlert('Error', e?.response?.data?.error || 'Failed to change role.');
    } finally {
      setActionLoading(false);
    }
  };
  const handleRemoveMember = (member) => {
    setShowRoleModal(false);
    setConfirmRemoveMember(member);
  };
  const confirmRemoveMemberNow = async () => {
    if (!confirmRemoveMember || !householdId) return;
    setActionLoading(true);
    try {
      await householdApi.removeMember(householdId, confirmRemoveMember.userId);
      setMembers((p) => p.filter((m) => m.userId !== confirmRemoveMember.userId));
    } catch (e) {
      showAlert('Error', e?.response?.data?.error || 'Failed to remove member.');
    } finally {
      setActionLoading(false);
      setConfirmRemoveMember(null);
    }
  };
  const openRoleModal = (member) => {
    setSelectedMember(member);
    setSelectedRole(member.role === 'admin' ? 'admin' : 'member');
    setShowRoleModal(true);
  };
  const handleLeave = () => {
    if (isAdmin) {
      showAlert('Transfer Admin First', 'Transfer admin to another member before leaving.');
      return;
    }
    setConfirmLeave(true);
  };
  const confirmLeaveNow = async () => {
    if (!householdId) return;
    setActionLoading(true);
    try {
      await householdApi.leave(householdId);
      showAlert('Request submitted', 'Your request to leave has been submitted for review.');
      await load();
    } catch (e) {
      showAlert('Error', e?.response?.data?.error || 'Failed to leave.');
    } finally {
      setActionLoading(false);
      setConfirmLeave(false);
    }
  };
  const handleApproveLeaveRequest = async () => {
    if (!householdId || !pendingLeaveRequest) return;
    setLeaveReviewLoading(true);
    try {
      await householdApi.approveLeaveRequest(householdId, pendingLeaveRequest.id);
      setPendingLeaveRequest(null);
      await load();
    } catch (e) {
      showAlert('Error', e?.response?.data?.error || 'Failed to approve the leave request.');
    } finally {
      setLeaveReviewLoading(false);
    }
  };
  const handleRejectLeaveRequest = async () => {
    if (!householdId || !pendingLeaveRequest) return;
    setLeaveReviewLoading(true);
    try {
      await householdApi.rejectLeaveRequest(householdId, pendingLeaveRequest.id);
      setPendingLeaveRequest(null);
    } catch (e) {
      showAlert('Error', e?.response?.data?.error || 'Failed to decline the leave request.');
    } finally {
      setLeaveReviewLoading(false);
    }
  };
  const handleDeleteNest = () => {
    setConfirmDelete(true);
  };
  const confirmDeleteNow = async () => {
    setConfirmDelete(false);
    if (!householdId) return;
    setActionLoading(true);
    try {
      await householdApi.requestDeletion(householdId);
      showAlert('Request submitted', 'Your household deletion request has been submitted for review.');
      await load();
    } catch (e) {
      showAlert('Error', e?.response?.data?.error || 'Failed to submit deletion request.');
    } finally {
      setActionLoading(false);
    }
  };
  const handleCancelScheduledDeletion = async () => {
    if (!householdId) return;
    setActionLoading(true);
    try {
      await householdApi.cancelDeletion(householdId);
      await load();
    } catch (e) {
      showAlert('Error', e?.response?.data?.error || 'Failed to cancel.');
    } finally {
      setActionLoading(false);
    }
  };

  // ── Loading ─────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <View
        style={[
          styles.centered,
          {
            paddingTop: insets.top,
          },
        ]}
      >
        <ActivityIndicator size="large" color={colors.gold} />
      </View>
    );
  }
  if (!householdId) {
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
        <View style={styles.header}>
          <TouchableOpacity style={styles.backBtn} onPress={() => navigation.goBack()}>
            <Text style={styles.backIcon}>‹</Text>
          </TouchableOpacity>
          <View style={styles.headerText}>
            <Text style={styles.headerTitle}>Household</Text>
          </View>
        </View>
        <View style={styles.centered}>
          <Text
            style={{
              fontSize: 48,
              marginBottom: 16,
            }}
          >
            🏡
          </Text>
          <Text style={styles.emptyTitle}>No Household</Text>
          <Text style={styles.emptyDesc}>You need to create or join a household first.</Text>
        </View>
      </View>
    );
  }

  // ── Main render ─────────────────────────────────────────────────────────
  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <StatusBar barStyle="light-content" backgroundColor={colors.canvas} />

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.scrollContent, { paddingBottom: dockHeight + 16 }]}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              load();
            }}
            tintColor={colors.gold}
          />
        }
      >
        {/* ── Header ── */}
        <View style={styles.header}>
          <TouchableOpacity
            style={styles.backBtn}
            onPress={() => navigation.goBack()}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityRole="button"
            accessibilityLabel="Go back"
          >
            <Text style={styles.backIcon}>‹</Text>
          </TouchableOpacity>
          <View style={styles.headerText}>
            <Text style={styles.headerTitle}>Household</Text>
            <Text style={styles.headerSub} numberOfLines={1}>
              {memberCountLabel}
              {householdName ? ` · ${householdName}` : ''}
            </Text>
          </View>
        </View>

        {/* ── Members ── */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Text style={styles.cardHeaderLabel}>MEMBERS</Text>
            {/* Rows are only tappable for an admin, and there was previously no
                hint of that at all — "Manage" both reveals the affordance and
                gives the chevrons somewhere to come from. */}
            {isAdmin && members.length > 1 && (
              <TouchableOpacity
                onPress={() => setManaging((m) => !m)}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                accessibilityRole="button"
              >
                <Text style={styles.cardHeaderAction}>{managing ? 'Done' : 'Manage'}</Text>
              </TouchableOpacity>
            )}
          </View>

          {members.map((member, i) => {
            const isSelf = member.userId === user?.id;
            const canManage = isAdmin && !isSelf && managing;
            const joined = joinedOn(member.joinedAt);
            return (
              <TouchableOpacity
                key={member.userId}
                disabled={!canManage}
                activeOpacity={0.7}
                onPress={() => openRoleModal(member)}
                style={[styles.memberRow, i === members.length - 1 && styles.memberRowLast]}
              >
                <Avatar
                  url={member.avatarUrl}
                  emoji={member.avatarEmoji}
                  name={member.displayName}
                  id={member.userId}
                  size={44}
                />
                <View style={styles.memberInfo}>
                  <Text style={styles.memberName} numberOfLines={1}>
                    {member.displayName}
                  </Text>
                  <Text style={styles.memberMeta} numberOfLines={1}>
                    {isSelf ? 'You' : ROLE_DISPLAY[member.role] || 'Member'}
                    {joined ? ` · joined ${joined}` : ''}
                  </Text>
                </View>
                {member.role === 'admin' && (
                  <View style={styles.adminPill}>
                    <Text style={styles.adminPillText}>ADMIN</Text>
                  </View>
                )}
                {canManage && <Text style={styles.rowChevron}>›</Text>}
              </TouchableOpacity>
            );
          })}
        </View>

        {/* ── Invite ──
            Admin-only: the server returns `inviteCode: null` to non-admins by
            design (the code is a standing credential), so for a member this
            card would render nothing but placeholder dashes. */}
        {isAdmin && (
          <View style={styles.card}>
            <Text style={styles.inviteTitle}>Invite to household</Text>
            <Text style={styles.inviteSub}>Scan or share the code to join instantly</Text>
            <View style={styles.inviteBody}>
              <View style={styles.qrTile}>
                {joinLink ? (
                  <QRCodeSvg
                    value={joinLink}
                    size={118}
                    color={colors.shadow}
                    backgroundColor={QR_TILE_BG}
                  />
                ) : (
                  <ActivityIndicator color={colors.gold} />
                )}
              </View>
              <View style={styles.inviteRight}>
                <Text style={styles.joinCodeLabel}>JOIN CODE</Text>
                <Text style={styles.joinCode} selectable>
                  {inviteCode || '--------'}
                </Text>
                <TouchableOpacity
                  style={styles.copyBtn}
                  onPress={handleCopyInvite}
                  activeOpacity={0.85}
                >
                  <GoldFill radius={radius.pill} />
                  <Text style={styles.copyBtnText}>{codeCopied ? 'Copied!' : 'Copy code'}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.shareBtn}
                  onPress={handleShareInvite}
                  activeOpacity={0.85}
                >
                  <Text style={styles.shareBtnText}>Share link</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        )}

        {/* ── Invite section for non-admin members: a one-time, 7-day-expiring
            code (generateInvitation) instead of the household's permanent
            one — safer to hand every member than a standing, reusable
            credential. Children can't invite at all (server-enforced).
            Styled to match the admin card above. */}
        {!isAdmin && !isChild && (
          <View style={styles.card}>
            <Text style={styles.inviteTitle}>Invite to household</Text>
            {oneTimeInvite ? (
              <>
                <Text style={styles.inviteSub}>
                  One-time code — expires{' '}
                  {new Date(oneTimeInvite.expiresAt).toLocaleDateString('en-US', {
                    month: 'long',
                    day: 'numeric',
                  })}
                </Text>
                <View style={styles.inviteBody}>
                  <View style={styles.qrTile}>
                    <QRCodeSvg
                      value={oneTimeInvite.shareLink}
                      size={118}
                      color={colors.shadow}
                      backgroundColor={QR_TILE_BG}
                    />
                  </View>
                  <View style={styles.inviteRight}>
                    <Text style={styles.joinCodeLabel}>JOIN CODE</Text>
                    <Text style={styles.joinCode} selectable>
                      {oneTimeInvite.code}
                    </Text>
                    <TouchableOpacity
                      style={styles.copyBtn}
                      onPress={handleCopyOneTimeInvite}
                      activeOpacity={0.85}
                    >
                      <GoldFill radius={radius.pill} />
                      <Text style={styles.copyBtnText}>
                        {oneTimeCodeCopied ? 'Copied!' : 'Copy code'}
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.shareBtn}
                      onPress={handleShareOneTimeInvite}
                      activeOpacity={0.85}
                    >
                      <Text style={styles.shareBtnText}>Share link</Text>
                    </TouchableOpacity>
                  </View>
                </View>
                <TouchableOpacity
                  onPress={handleGenerateInvite}
                  disabled={generatingInvite}
                  activeOpacity={0.7}
                  style={{ marginTop: 14 }}
                >
                  <Text style={styles.inviteSub}>
                    {generatingInvite ? 'Generating…' : 'Generate a new code'}
                  </Text>
                </TouchableOpacity>
              </>
            ) : (
              <>
                <Text style={styles.inviteSub}>
                  Generate a one-time invite code to bring someone new into the household.
                </Text>
                <TouchableOpacity
                  style={[styles.copyBtn, { marginTop: 14 }]}
                  onPress={handleGenerateInvite}
                  disabled={generatingInvite}
                  activeOpacity={0.85}
                >
                  <GoldFill radius={radius.pill} disabled={generatingInvite} />
                  {generatingInvite ? (
                    <ActivityIndicator color={colors.onAccent} />
                  ) : (
                    <Text style={styles.copyBtnText}>Generate invite code</Text>
                  )}
                </TouchableOpacity>
              </>
            )}
          </View>
        )}

        {/* ── Leave / delete ── */}
        <View style={styles.card}>
          {isAdmin && pendingLeaveRequest && (
            <View style={styles.deletionBanner}>
              <Text style={styles.deletionBannerText}>
                {(pendingLeaveRequest.requestedByName || 'A member')} wants to leave the household.
              </Text>
              <View style={styles.leaveReviewRow}>
                <TouchableOpacity
                  onPress={handleApproveLeaveRequest}
                  activeOpacity={0.7}
                  disabled={leaveReviewLoading}
                >
                  <Text style={styles.deletionBannerCancel}>Approve</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={handleRejectLeaveRequest}
                  activeOpacity={0.7}
                  disabled={leaveReviewLoading}
                >
                  <Text style={[styles.deletionBannerCancel, styles.leaveReviewDecline]}>Decline</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

          {pendingRequest && (
            <View style={styles.deletionBanner}>
              <Text style={styles.deletionBannerText}>
                {pendingRequest.type === 'leave'
                  ? 'Your request to leave this household is pending review.'
                  : 'Your household deletion request is pending review.'}
              </Text>
            </View>
          )}

          <TouchableOpacity
            style={styles.actionRow}
            onPress={handleLeave}
            activeOpacity={0.7}
            disabled={!!pendingRequest}
          >
            <View style={styles.actionInfo}>
              <Text style={[styles.actionTitle, !!pendingRequest && styles.actionDisabled]}>
                Leave household
              </Text>
              <Text style={styles.actionSub}>You&apos;ll lose access to shared tasks</Text>
            </View>
            <Text style={styles.rowChevron}>›</Text>
          </TouchableOpacity>

          {isAdmin &&
            (scheduledDeletionAt ? (
              <View style={styles.deletionBanner}>
                <Text style={styles.deletionBannerText}>
                  Deletion scheduled for{' '}
                  {new Date(scheduledDeletionAt).toLocaleDateString('en-US', {
                    month: 'long',
                    day: 'numeric',
                    year: 'numeric',
                  })}
                </Text>
                <TouchableOpacity onPress={handleCancelScheduledDeletion} activeOpacity={0.7}>
                  <Text style={styles.deletionBannerCancel}>Cancel deletion</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <>
                <View style={styles.rowDivider} />
                <TouchableOpacity
                  style={styles.actionRow}
                  onPress={handleDeleteNest}
                  activeOpacity={0.7}
                  disabled={!!pendingRequest}
                >
                  <View style={styles.actionInfo}>
                    <Text
                      style={[
                        styles.actionTitle,
                        styles.actionTitleDanger,
                        !!pendingRequest && styles.actionDisabled,
                      ]}
                    >
                      Delete household
                    </Text>
                    <Text style={styles.actionSub}>Permanent — removes all members</Text>
                  </View>
                  <Text style={[styles.rowChevron, styles.rowChevronDanger]}>›</Text>
                </TouchableOpacity>
              </>
            ))}
        </View>

        {actionLoading && (
          <ActivityIndicator size="small" color={colors.gold} style={{ marginTop: 20 }} />
        )}
      </ScrollView>

      {/* ── Role Edit Modal (mock Screen 37) ── */}
      <Modal
        visible={showRoleModal}
        transparent
        animationType="slide"
        onRequestClose={() => setShowRoleModal(false)}
      >
        <Pressable style={styles.modalOverlay} onPress={() => setShowRoleModal(false)}>
          <Pressable
            style={[
              styles.modalSheet,
              {
                paddingBottom: insets.bottom + 44,
              },
            ]}
          >
            <View style={styles.modalHandle} />
            <Text style={styles.modalTitle}>Edit role · {selectedMember?.displayName}</Text>

            <View style={styles.roleOptions}>
              {ROLE_OPTIONS.map((opt) => {
                const active = selectedRole === opt.key;
                return (
                  <TouchableOpacity
                    key={opt.key}
                    style={[
                      styles.roleCard,
                      active ? styles.roleCardActive : styles.roleCardInactive,
                    ]}
                    onPress={() => setSelectedRole(opt.key)}
                    activeOpacity={0.7}
                  >
                    <View
                      style={[
                        styles.roleCircle,
                        active ? styles.roleCircleActive : styles.roleCircleInactive,
                      ]}
                    />
                    <Text style={styles.roleLabel}>{opt.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <TouchableOpacity
              style={[styles.saveBtn, actionLoading && styles.saveBtnLoading]}
              onPress={handleSaveRole}
              disabled={actionLoading}
              activeOpacity={0.85}
            >
              <GoldFill radius={9999} disabled={actionLoading} />
              <Text style={styles.saveBtnText}>{actionLoading ? 'Saving…' : 'Save'}</Text>
            </TouchableOpacity>

            {selectedMember && (
              <TouchableOpacity
                style={styles.removeLink}
                onPress={() => handleRemoveMember(selectedMember)}
                hitSlop={{
                  top: 8,
                  bottom: 8,
                  left: 8,
                  right: 8,
                }}
              >
                <Text style={styles.removeLinkText}>Remove from household</Text>
              </TouchableOpacity>
            )}
          </Pressable>
        </Pressable>
      </Modal>

      {/* Remove member confirmation sheet */}
      <ConfirmSheet
        visible={!!confirmRemoveMember}
        title={`Remove ${confirmRemoveMember?.displayName}?`}
        subtitle="This cannot be undone."
        confirmLabel="Remove"
        onConfirm={confirmRemoveMemberNow}
        onCancel={() => setConfirmRemoveMember(null)}
      />

      {/* Leave household confirmation sheet */}
      <ConfirmSheet
        visible={confirmLeave}
        title="Leave Household?"
        subtitle="You will need a new invite code to rejoin."
        confirmLabel="Leave"
        onConfirm={confirmLeaveNow}
        onCancel={() => setConfirmLeave(false)}
      />

      {/* Delete household confirmation sheet */}
      <ConfirmSheet
        visible={confirmDelete}
        title="Delete Household?"
        subtitle="This submits a deletion request for Rootaroo to review. If approved, the household is deleted in 30 days (cancelable anytime until then)."
        confirmLabel="Submit request"
        onConfirm={confirmDeleteNow}
        onCancel={() => setConfirmDelete(false)}
      />

    </View>
  );
}
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: colors.canvas,
  },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 20, paddingTop: 4 },

  // ── Header ──
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
    // The glyph sits optically right of centre in this face.
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
  headerSub: {
    marginTop: 2,
    fontSize: 13,
    fontFamily: fonts.body,
    color: colors.textMuted,
  },

  // ── Shared card shell ──
  card: {
    marginTop: 14,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderCool,
    borderRadius: radius.xl,
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 12,
    paddingBottom: 4,
  },
  cardHeaderLabel: {
    fontSize: 11,
    letterSpacing: 1.4,
    fontFamily: fonts.bodySemiBold,
    color: colors.textFaint,
  },
  cardHeaderAction: {
    fontSize: 14,
    fontFamily: fonts.bodySemiBold,
    color: colors.gold,
  },

  // ── Member rows ──
  memberRow: { flexDirection: 'row', alignItems: 'center', gap: 13, paddingVertical: 12 },
  memberRowLast: { paddingBottom: 14 },
  memberInfo: { flex: 1 },
  memberName: {
    fontSize: 16,
    fontFamily: fonts.bodyBold,
    color: colors.ink,
  },
  memberMeta: {
    marginTop: 2,
    fontSize: 13,
    fontFamily: fonts.body,
    color: colors.textMuted,
  },
  adminPill: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radius.sm,
    backgroundColor: colors.goldTint,
  },
  adminPillText: {
    fontSize: 10,
    letterSpacing: 0.8,
    fontFamily: fonts.bodyBold,
    color: colors.gold,
  },
  rowChevron: {
    fontSize: 22,
    lineHeight: 24,
    fontFamily: fonts.body,
    color: colors.textFaint,
  },
  rowChevronDanger: { color: withAlpha(colors.danger, 0.7) },
  rowDivider: { height: 1, backgroundColor: colors.divider },

  // ── Invite ──
  inviteTitle: {
    marginTop: 12,
    fontSize: 17,
    fontFamily: fonts.bodyBold,
    color: colors.ink,
  },
  inviteSub: {
    marginTop: 3,
    fontSize: 13,
    fontFamily: fonts.body,
    color: colors.textMuted,
  },
  inviteBody: { flexDirection: 'row', gap: 16, paddingVertical: 16 },
  qrTile: {
    width: 142,
    height: 142,
    borderRadius: radius.lg,
    backgroundColor: QR_TILE_BG,
    alignItems: 'center',
    justifyContent: 'center',
  },
  inviteRight: { flex: 1, justifyContent: 'center' },
  joinCodeLabel: {
    fontSize: 10,
    letterSpacing: 1.3,
    fontFamily: fonts.bodySemiBold,
    color: colors.textFaint,
  },
  joinCode: {
    marginTop: 4,
    fontSize: 19,
    letterSpacing: 1.6,
    fontFamily: fonts.mono,
    color: colors.gold,
  },
  copyBtn: {
    marginTop: 14,
    height: 44,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.gold,
    ...goldButton.glow,
  },
  copyBtnText: {
    fontSize: 14,
    fontFamily: fonts.bodyBold,
    color: goldButton.onGold,
  },
  shareBtn: {
    marginTop: 9,
    height: 44,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceDark,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shareBtnText: {
    fontSize: 14,
    fontFamily: fonts.bodySemiBold,
    color: colors.ink,
  },

  // ── Leave / delete rows ──
  actionRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 15 },
  actionInfo: { flex: 1 },
  actionTitle: {
    fontSize: 16,
    fontFamily: fonts.bodySemiBold,
    color: colors.ink,
  },
  actionTitleDanger: { color: colors.danger },
  actionSub: {
    marginTop: 3,
    fontSize: 13,
    fontFamily: fonts.body,
    color: colors.textMuted,
  },
  actionDisabled: { color: colors.textFaint },

  // ── Pending / scheduled banners ──
  deletionBanner: {
    marginTop: 12,
    marginBottom: 4,
    padding: 14,
    borderRadius: radius.card,
    backgroundColor: colors.dangerSoft,
    borderWidth: 1,
    borderColor: withAlpha(colors.danger, 0.25),
  },
  deletionBannerText: {
    fontSize: 13,
    lineHeight: 19,
    fontFamily: fonts.body,
    color: colors.danger,
  },
  leaveReviewRow: {
    flexDirection: 'row',
    gap: 20,
  },
  leaveReviewDecline: {
    color: colors.danger,
  },
  deletionBannerCancel: {
    marginTop: 10,
    fontSize: 14,
    fontFamily: fonts.bodySemiBold,
    color: colors.gold,
  },

  modalOverlay: {
    flex: 1,
    backgroundColor: withAlpha(colors.shadow, 0.55),
    justifyContent: 'flex-end',
  },
  modalSheet: {
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
    elevation: 12,
  },
  modalHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
    alignSelf: 'center',
    marginBottom: 22,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '600',
    fontFamily: fonts.displayBold,
    color: colors.ink,
    textAlign: 'center',
    marginBottom: 22,
  },
  roleOptions: {
    gap: 12,
    marginBottom: 26,
  },
  roleCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    borderRadius: radius.cardLg,
    paddingVertical: 16,
    paddingHorizontal: 18,
  },
  roleCardActive: {
    backgroundColor: colors.surface,
    shadowColor: colors.shadow,
    shadowOffset: {
      width: 0,
      height: 10,
    },
    shadowOpacity: 0.06,
    shadowRadius: 24,
    elevation: 3,
  },
  roleCardInactive: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  roleCircle: {
    width: 20,
    height: 20,
    borderRadius: 10,
  },
  roleCircleActive: {
    backgroundColor: colors.gold,
  },
  roleCircleInactive: {
    borderWidth: 2,
    borderColor: colors.divider,
  },
  roleLabel: {
    fontSize: 14,
    fontWeight: '500',
    fontFamily: fonts.bodyMedium,
    color: colors.ink,
  },
  saveBtn: {
    width: '100%',
    height: 54,
    backgroundColor: colors.gold,
    borderRadius: 9999,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
    ...goldButton.glow,
  },
  saveBtnLoading: {
    opacity: 0.7,
  },
  saveBtnText: {
    fontSize: 15,
    fontWeight: '600',
    fontFamily: fonts.displayBold,
    color: goldButton.onGold,
  },
  removeLink: {
    alignItems: 'center',
    paddingVertical: 6,
  },
  removeLinkText: {
    fontSize: 13,
    fontWeight: '500',
    fontFamily: fonts.bodyMedium,
    color: colors.danger,
  },
  // Empty state
  emptyTitle: {
    fontFamily: fonts.bodyBold,
    fontSize: 20,
    fontWeight: '700',
    color: colors.ink,
    marginBottom: 8,
  },
  emptyDesc: {
    fontFamily: fonts.body,
    fontSize: 14,
    color: colors.textMuted,
    textAlign: 'center',
    lineHeight: 20,
    paddingHorizontal: 40,
  },
});
