import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  Image,
  Modal,
} from 'react-native';
import { showAlert } from '../shared/services/themedAlert';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { chatApi } from '../shared/api/chat';
import { householdApi } from '../shared/api/household';
import { useAuthStore } from '../shared/store/authStore';
import { colors, fonts, goldButton, radius, spacing, withAlpha } from '../shared/theme';
import { GoldFill } from '../shared/components/GoldButton';
import { useTabBarDockHeight } from '../shared/hooks/useTabBarDockHeight';
const AVATAR_COLORS = [colors.gold, colors.avatarTan, colors.avatarLilac, colors.avatarSage, colors.avatarSky];
function initials(name) {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}
export default function GroupMembersScreen({ route }) {
  const { conversationId, title, type } = route.params;
  const insets = useSafeAreaInsets();
  const dockHeight = useTabBarDockHeight();
  const nav = useNavigation();
  const currentUserId = useAuthStore((s) => s.user?.id || '');
  const householdId = useAuthStore((s) => s.householdId);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [groupMembers, setGroupMembers] = useState([]);
  const [householdMembers, setHouseholdMembers] = useState([]);
  const [createdBy, setCreatedBy] = useState(null);
  const [convType, setConvType] = useState(type);
  const [pickerVisible, setPickerVisible] = useState(false);

  // "Everyone" membership auto-follows actual household membership (synced
  // server-side on join/leave/remove) — no manual add/remove here, that
  // would silently desync the chat from who's actually in the household.
  const isHousehold = convType === 'household';

  // Group creator OR household admin can manage members.
  const isAdmin =
    !isHousehold &&
    ((createdBy !== null && createdBy === currentUserId) ||
      householdMembers.some((m) => m.userId === currentUserId && m.role === 'admin'));
  const load = useCallback(async () => {
    try {
      setLoading(true);
      const [list, members] = await Promise.all([
        chatApi.listConversations(),
        householdId ? householdApi.getMembers(householdId) : Promise.resolve([]),
      ]);
      const conv = list.find((c) => c.id === conversationId);
      setGroupMembers(conv?.participants || []);
      setCreatedBy(conv?.createdBy || null);
      if (conv?.type) setConvType(conv.type);
      setHouseholdMembers(members);
    } catch {
      // keep existing state
    } finally {
      setLoading(false);
    }
  }, [conversationId, householdId]);
  useEffect(() => {
    load();
  }, [load]);
  const memberById = useMemo(() => {
    const map = new Map();
    householdMembers.forEach((m) => map.set(m.userId, m));
    return map;
  }, [householdMembers]);
  const inGroupIds = useMemo(() => new Set(groupMembers.map((p) => p.id)), [groupMembers]);

  // Merge household members with group membership; participants without a
  // household record (e.g. left household) fall back to a synthetic row.
  const rows = useMemo(() => {
    const list = householdMembers.map((m) => ({
      member: m,
      inGroup: inGroupIds.has(m.userId),
    }));
    groupMembers.forEach((p) => {
      if (!memberById.has(p.id)) {
        list.push({
          member: {
            userId: p.id,
            displayName: p.displayName,
            email: '',
            avatarUrl: p.avatarUrl,
            avatarEmoji: null,
            role: 'member',
            joinedAt: '',
          },
          inGroup: true,
        });
      }
    });
    // Current user always at the top
    return list.sort((a, b) => {
      if (a.member.userId === currentUserId) return -1;
      if (b.member.userId === currentUserId) return 1;
      return a.member.displayName.localeCompare(b.member.displayName);
    });
  }, [householdMembers, groupMembers, memberById, inGroupIds, currentUserId]);

  // Household members eligible to be added to this group (not already in it).
  const addableMembers = useMemo(
    () => rows.filter((r) => !r.inGroup && r.member.userId !== currentUserId),
    [rows, currentUserId],
  );
  const handleAdd = useCallback(
    async (userId) => {
      setBusyId(userId);
      try {
        // Adds the member to the group AND DMs them an invite for this group
        await chatApi.inviteToGroup(conversationId, userId);
        await load();
      } catch (e) {
        showAlert('Error', e?.response?.data?.error || 'Failed to add member');
      } finally {
        setBusyId(null);
      }
    },
    [conversationId, load],
  );
  const handleRemove = useCallback(
    (userId, displayName) => {
      showAlert('Remove Member', `Remove ${displayName} from this group?`, [
        {
          text: 'Cancel',
          style: 'cancel',
        },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            setBusyId(userId);
            try {
              await chatApi.removeParticipant(conversationId, userId);
              await load();
            } catch (e) {
              showAlert('Error', e?.response?.data?.error || 'Failed to remove member');
            } finally {
              setBusyId(null);
            }
          },
        },
      ]);
    },
    [conversationId, load],
  );
  const renderItem = ({ item }) => {
    const { member, inGroup } = item;
    const isSelf = member.userId === currentUserId;
    const isCreator = member.userId === createdBy;
    const isHhAdmin = member.role === 'admin';
    const busy = busyId === member.userId;
    const avatarColor =
      AVATAR_COLORS[Math.abs((member.displayName || '?').charCodeAt(0)) % AVATAR_COLORS.length];
    return (
      <View style={styles.row}>
        <View
          style={[
            styles.avatar,
            {
              backgroundColor: avatarColor,
            },
          ]}
        >
          {member.avatarUrl ? (
            <Image
              source={{
                uri: member.avatarUrl,
              }}
              style={styles.avatarImage}
            />
          ) : (
            <Text style={styles.avatarText}>{initials(member.displayName || '?')}</Text>
          )}
        </View>
        <View style={styles.rowContent}>
          <View style={styles.nameRow}>
            <Text style={styles.rowName} numberOfLines={1}>
              {member.displayName}
              {isSelf ? ' (You)' : ''}
            </Text>
            {isCreator || (isHhAdmin && !isSelf) ? (
              <View style={styles.adminBadge}>
                <Text style={styles.adminBadgeText}>Admin</Text>
              </View>
            ) : null}
          </View>
          {isHousehold
            ? !inGroup && <Text style={styles.rowSub}>Not yet synced to this chat</Text>
            : <Text style={styles.rowSub}>{inGroup ? 'In this group' : 'Not in this group'}</Text>}
        </View>

        {!isAdmin ? null : inGroup ? (
          isSelf || isCreator || isHhAdmin ? (
            <View style={styles.selfBadge}>
              <Text style={styles.selfBadgeText}>{isSelf ? 'You' : 'Admin'}</Text>
            </View>
          ) : (
            <TouchableOpacity
              style={[styles.removeBtn, busy && styles.btnBusy]}
              onPress={() => handleRemove(member.userId, member.displayName)}
              disabled={busy}
              activeOpacity={0.7}
            >
              {busy ? (
                <ActivityIndicator size="small" color={colors.danger} />
              ) : (
                <Text style={styles.removeBtnText}>Remove</Text>
              )}
            </TouchableOpacity>
          )
        ) : (
          <TouchableOpacity
            style={[styles.addBtn, busy && styles.btnBusy]}
            onPress={() => handleAdd(member.userId)}
            disabled={busy}
            activeOpacity={0.7}
          >
            <GoldFill radius={radius.pill} disabled={busy} />
            {busy ? (
              <ActivityIndicator size="small" color={colors.onAccent} />
            ) : (
              <Text style={styles.addBtnText}>Add</Text>
            )}
          </TouchableOpacity>
        )}
      </View>
    );
  };
  const memberCount = groupMembers.length;
  return (
    <View
      style={[
        styles.container,
        {
          paddingTop: insets.top,
        },
      ]}
    >
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => nav.goBack()}
          hitSlop={{
            top: 12,
            bottom: 12,
            left: 12,
            right: 12,
          }}
        >
          <Text style={styles.backIcon}>←</Text>
        </TouchableOpacity>
        <View style={styles.headerTitleContainer}>
          <Text style={styles.headerTitle}>{title || 'Group'}</Text>
          <Text style={styles.headerSubtitle}>
            {memberCount} {memberCount === 1 ? 'member' : 'members'}
          </Text>
        </View>
        <View style={styles.headerSpacer} />
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.gold} />
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(item) => item.member.userId}
          renderItem={renderItem}
          contentContainerStyle={[styles.listContent, { paddingBottom: dockHeight + 16 }]}
          ListHeaderComponent={
            <>
              {isAdmin && (
                <TouchableOpacity
                  style={styles.addMemberRow}
                  onPress={() => setPickerVisible(true)}
                  activeOpacity={0.7}
                >
                  <View style={styles.addMemberIcon}>
                    <Text style={styles.addMemberIconText}>+</Text>
                  </View>
                  <Text style={styles.addMemberLabel}>Add Member</Text>
                  <Text style={styles.addMemberChevron}>›</Text>
                </TouchableOpacity>
              )}
              <Text style={styles.sectionLabel}>HOUSEHOLD MEMBERS</Text>
              {isHousehold ? (
                <Text style={styles.adminHint}>
                  This list always matches your household — join or leave from Household Settings.
                </Text>
              ) : (
                !isAdmin && (
                  <Text style={styles.adminHint}>Only the group admin can add or remove members</Text>
                )
              )}
            </>
          }
          ListEmptyComponent={
            <View style={styles.emptyBox}>
              <Text style={styles.emptyText}>No household members found</Text>
            </View>
          }
        />
      )}

      {/* Add Member picker */}
      <Modal
        visible={pickerVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setPickerVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <TouchableOpacity
            style={styles.modalBackdrop}
            activeOpacity={1}
            onPress={() => setPickerVisible(false)}
          />
          <View style={styles.modalSheet}>
            <View style={styles.modalHandle} />
            <Text style={styles.modalTitle}>Add Member</Text>
            <Text style={styles.modalSubtitle}>Choose a household member to add to this group</Text>

            {addableMembers.length === 0 ? (
              <View style={styles.modalEmpty}>
                <Text style={styles.modalEmptyTitle}>
                  All household members are already in this group
                </Text>
                <Text style={styles.modalEmptyText}>
                  There's no one left to invite to this group.
                </Text>
                <TouchableOpacity
                  style={styles.modalCancelBtn}
                  activeOpacity={0.8}
                  onPress={() => setPickerVisible(false)}
                >
                  <Text style={styles.modalCancelBtnText}>Close</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <FlatList
                data={addableMembers}
                keyExtractor={(item) => item.member.userId}
                renderItem={({ item }) => {
                  const busy = busyId === item.member.userId;
                  const avatarColor =
                    AVATAR_COLORS[
                      Math.abs((item.member.displayName || '?').charCodeAt(0)) %
                        AVATAR_COLORS.length
                    ];
                  return (
                    <View style={styles.modalRow}>
                      <View
                        style={[
                          styles.avatar,
                          {
                            backgroundColor: avatarColor,
                          },
                        ]}
                      >
                        {item.member.avatarUrl ? (
                          <Image
                            source={{
                              uri: item.member.avatarUrl,
                            }}
                            style={styles.avatarImage}
                          />
                        ) : (
                          <Text style={styles.avatarText}>
                            {initials(item.member.displayName || '?')}
                          </Text>
                        )}
                      </View>
                      <View style={styles.rowContent}>
                        <Text style={styles.rowName} numberOfLines={1}>
                          {item.member.displayName}
                        </Text>
                        <Text style={styles.rowSub}>
                          {item.member.role === 'admin' ? 'Household admin' : 'Household member'}
                        </Text>
                      </View>
                      <TouchableOpacity
                        style={[styles.addBtn, busy && styles.btnBusy]}
                        onPress={() => handleAdd(item.member.userId)}
                        disabled={busy}
                        activeOpacity={0.7}
                      >
                        <GoldFill radius={radius.pill} disabled={busy} />
                        {busy ? (
                          <ActivityIndicator size="small" color={colors.onAccent} />
                        ) : (
                          <Text style={styles.addBtnText}>Add</Text>
                        )}
                      </TouchableOpacity>
                    </View>
                  );
                }}
                contentContainerStyle={styles.modalListContent}
              />
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.canvas,
  },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: 12,
    backgroundColor: colors.canvas,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  backBtn: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backIcon: {
    fontSize: 22,
    color: colors.ink,
    fontWeight: '600',
  },
  headerTitleContainer: {
    flex: 1,
    alignItems: 'center',
  },
  headerTitle: {
    fontFamily: fonts.bodyBold,
    fontSize: 17,
    fontWeight: '700',
    color: colors.ink,
  },
  headerSubtitle: {
    fontFamily: fonts.body,
    fontSize: 12,
    color: colors.textMuted,
    marginTop: 2,
  },
  headerSpacer: {
    width: 32,
  },
  sectionLabel: {
    fontFamily: fonts.bodyBold,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    color: colors.textMuted,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.sm,
  },
  adminHint: {
    fontFamily: fonts.body,
    fontSize: 12,
    color: colors.textSecondary,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
    fontStyle: 'italic',
  },
  addMemberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
  },
  addMemberIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.goldLight,
    marginRight: spacing.md,
  },
  addMemberIconText: {
    fontSize: 24,
    fontWeight: '500',
    color: colors.goldDeep,
    lineHeight: 26,
  },
  addMemberLabel: {
    fontFamily: fonts.bodySemiBold,
    flex: 1,
    fontSize: 15,
    fontWeight: '600',
    color: colors.goldDeep,
  },
  addMemberChevron: {
    fontSize: 22,
    color: colors.textMuted,
    fontWeight: '500',
  },
  modalOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  modalBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: withAlpha(colors.black, 0.4),
  },
  modalSheet: {
    backgroundColor: colors.canvas,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingBottom: spacing.xxxl,
    maxHeight: '75%',
  },
  modalHandle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
    marginTop: spacing.sm,
    marginBottom: spacing.sm,
  },
  modalTitle: {
    fontFamily: fonts.bodyBold,
    fontSize: 18,
    fontWeight: '700',
    color: colors.ink,
    textAlign: 'center',
    marginTop: spacing.sm,
  },
  modalSubtitle: {
    fontFamily: fonts.body,
    fontSize: 13,
    color: colors.textSecondary,
    textAlign: 'center',
    marginTop: spacing.xs,
    marginBottom: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  modalListContent: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
  },
  modalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  modalEmpty: {
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.lg,
  },
  modalEmptyTitle: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 15,
    fontWeight: '600',
    color: colors.ink,
    textAlign: 'center',
    marginBottom: spacing.sm,
  },
  modalEmptyText: {
    fontFamily: fonts.body,
    fontSize: 13,
    color: colors.textSecondary,
    textAlign: 'center',
    marginBottom: spacing.xl,
  },
  modalCancelBtn: {
    alignSelf: 'center',
    paddingVertical: spacing.md,
  },
  modalCancelBtnText: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 14,
    fontWeight: '600',
    color: colors.textSecondary,
  },
  listContent: {
    paddingBottom: spacing.xxxl,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.md,
  },
  avatarImage: {
    width: 44,
    height: 44,
    borderRadius: 22,
  },
  avatarText: {
    fontFamily: fonts.bodyBold,
    fontSize: 15,
    fontWeight: '700',
    color: colors.onAccent,
  },
  rowContent: {
    flex: 1,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  rowName: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 15,
    fontWeight: '600',
    color: colors.ink,
    flexShrink: 1,
  },
  adminBadge: {
    backgroundColor: colors.goldLight,
    borderRadius: radius.sm,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  adminBadgeText: {
    fontFamily: fonts.bodyBold,
    fontSize: 10,
    fontWeight: '700',
    color: colors.goldDeep,
    letterSpacing: 0.5,
  },
  rowSub: {
    fontFamily: fonts.body,
    fontSize: 12,
    color: colors.textMuted,
    marginTop: 2,
  },
  addBtn: {
    backgroundColor: colors.gold,
    borderRadius: radius.pill,
    paddingHorizontal: 18,
    paddingVertical: 8,
    minWidth: 64,
    alignItems: 'center',
    ...goldButton.glow,
  },
  addBtnText: {
    fontFamily: fonts.bodyBold,
    fontSize: 13,
    fontWeight: '700',
    color: colors.onAccent,
  },
  removeBtn: {
    backgroundColor: colors.surfaceWarm,
    borderRadius: radius.pill,
    paddingHorizontal: 18,
    paddingVertical: 8,
    minWidth: 64,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  removeBtnText: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 13,
    fontWeight: '600',
    color: colors.danger,
  },
  btnBusy: {
    opacity: 0.6,
  },
  selfBadge: {
    backgroundColor: colors.goldLight,
    borderRadius: radius.pill,
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  selfBadgeText: {
    fontFamily: fonts.bodyBold,
    fontSize: 12,
    fontWeight: '700',
    color: colors.goldDeep,
  },
  emptyBox: {
    paddingVertical: 48,
    alignItems: 'center',
  },
  emptyText: {
    fontFamily: fonts.body,
    fontSize: 14,
    color: colors.textSecondary,
  },
});
