import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SectionList,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  StatusBar,
  KeyboardAvoidingView,
  ScrollView,
} from 'react-native';
import { showAlert } from '../shared/services/themedAlert';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { groceryApi } from '../shared/api/grocery';
import { householdApi } from '../shared/api/household';
import { useAuthStore } from '../shared/store/authStore';
import { colors, fonts, goldButton, radius } from '../shared/theme';
import { GoldFill } from '../shared/components/GoldButton';
import ConfirmSheet from '../components/ConfirmSheet';
import EmptyState from '../components/EmptyState';
import { KEYBOARD_BEHAVIOR, keyboardScrollProps } from '../shared/components/KeyboardAware';
import { useTabBarDockHeight } from '../shared/hooks/useTabBarDockHeight';
import { Field, AssigneePickerSheet, BottomSheet, sheet } from '../shared/components/listSheet';

// ─── Sections ─────────────────────────────────────────────────────────────

const GROCERY_SECTIONS = [
  {
    key: 'pending',
    title: 'To Buy',
    statusColor: colors.goldDeep,
  },
  {
    key: 'bought',
    title: 'Bought',
    statusColor: colors.success,
  },
  {
    key: 'archived',
    title: 'Archived',
    statusColor: colors.textMuted,
  },
];
// ─── Component ─────────────────────────────────────────────────────────────

export default function GroceryListScreen({ navigation }) {
  const [grouped, setGrouped] = useState(null);
  const [groceryLoading, setGroceryLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const insets = useSafeAreaInsets();
  const dockHeight = useTabBarDockHeight();
  const user = useAuthStore((s) => s.user);
  const householdId = useAuthStore((s) => s.householdId);

  // ─── Add / Edit sheet state ──────────────────────────────────────────
  const [showItemSheet, setShowItemSheet] = useState(false);
  const [editItem, setEditItem] = useState(null);
  const [itemName, setItemName] = useState('');
  const [itemQty, setItemQty] = useState('');
  const [itemNote, setItemNote] = useState('');
  const [itemAssignee, setItemAssignee] = useState(null);
  const [members, setMembers] = useState([]);
  const [saving, setSaving] = useState(false);
  const [showAssigneeSheet, setShowAssigneeSheet] = useState(false);

  // Destructive confirm sheet
  const [confirmDeleteItem, setConfirmDeleteItem] = useState(null);
  const loadMembers = useCallback(async () => {
    if (householdId) {
      try {
        setMembers(await householdApi.getMembers(householdId));
      } catch {}
    }
  }, [householdId]);
  const openAddSheet = useCallback(async () => {
    setEditItem(null);
    setItemName('');
    setItemQty('');
    setItemNote('');
    setItemAssignee(null);
    await loadMembers();
    setShowItemSheet(true);
  }, [loadMembers]);
  const openEditSheet = useCallback(
    async (item) => {
      setEditItem(item);
      setItemName(item.name);
      setItemQty(item.quantity || '');
      setItemNote(item.note || '');
      setItemAssignee(item.assignedTo?.id ?? null);
      await loadMembers();
      setShowItemSheet(true);
    },
    [loadMembers],
  );
  const loading = groceryLoading;

  // ─── Data loading ─────────────────────────────────────────────────────

  const loadGroceries = useCallback(async () => {
    try {
      const data = await groceryApi.list();
      setGrouped(data);
    } catch {
      showAlert('Error', 'Could not load groceries');
    } finally {
      setGroceryLoading(false);
      setRefreshing(false);
    }
  }, []);
  // ─── Save item (add / edit) ──────────────────────────────────────────

  const handleSaveItem = useCallback(async () => {
    const trimmed = itemName.trim();
    if (!trimmed) {
      showAlert('Required', 'Item name is required');
      return;
    }
    setSaving(true);
    try {
      const payload = {};
      if (trimmed) payload.name = trimmed;
      if (itemQty.trim()) payload.quantity = itemQty.trim();
      if (itemNote.trim()) payload.note = itemNote.trim();
      if (itemAssignee) payload.assignedTo = itemAssignee;
      if (editItem) {
        await groceryApi.update(editItem.id, payload);
      } else {
        await groceryApi.create(payload);
      }
      setShowItemSheet(false);
      await loadGroceries();
    } catch (e) {
      const res = e?.response?.data;
      const msg = res?.error || res?.message || e?.message || 'Unknown error';
      showAlert('Error', `Could not ${editItem ? 'update' : 'create'} item\n${msg}`);
    } finally {
      setSaving(false);
    }
  }, [
    itemName,
    itemQty,
    itemNote,
    itemAssignee,
    editItem,
    loadGroceries,
  ]);
  useEffect(() => {
    loadGroceries();
  }, []);

  // Track tab switches vs back-navigation — reset stack only on tab switches
  useEffect(() => {
    let tabSwitched = false;
    const unsubs = [
      navigation.addListener('blur', () => {
        tabSwitched = true;
      }),
      navigation.addListener('beforeRemove', () => {
        tabSwitched = false;
      }),
      navigation.addListener('focus', () => {
        if (tabSwitched) {
          tabSwitched = false;
          const state = navigation.getState();
          if (state && state.index > 0) {
            navigation.navigate('MoreIndex');
          }
        }
      }),
    ];
    return () => unsubs.forEach((u) => u());
  }, [navigation]);
  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    loadGroceries();
  }, [loadGroceries]);

  // ─── Grocery actions ──────────────────────────────────────────────────

  const handleGroceryToggle = useCallback(
    async (id) => {
      try {
        await groceryApi.toggle(id);
        await loadGroceries();
      } catch {
        showAlert('Error', 'Could not update item');
      }
    },
    [loadGroceries],
  );
  const handleGroceryLongPress = useCallback(
    (item) => {
      const isAssignee = item.assignedTo?.id === user?.id;
      const canArchiveItem =
        (user?.role === 'admin' || item.boughtBy?.id === user?.id || isAssignee) && item.isBought;
      const canDeleteItem = user?.role === 'admin';
      const opts = [
        {
          text: 'Cancel',
          style: 'cancel',
        },
      ];
      if (canArchiveItem) {
        opts.push({
          text: 'Archive',
          onPress: async () => {
            try {
              await groceryApi.archive(item.id);
              await loadGroceries();
            } catch {
              showAlert('Error', 'Could not archive');
            }
          },
        });
      }
      if (canDeleteItem) {
        opts.push({
          text: 'Delete',
          style: 'destructive',
          onPress: () => setConfirmDeleteItem(item),
        });
      }
      if (opts.length > 1) {
        showAlert(item.name, 'What would you like to do?', opts);
      }
    },
    [loadGroceries, user],
  );
  const confirmDeleteNow = async () => {
    if (!confirmDeleteItem) return;
    setShowItemSheet(false);
    try {
      await groceryApi.delete(confirmDeleteItem.id);
      await loadGroceries();
    } catch {
      showAlert('Error', 'Could not delete');
    } finally {
      setConfirmDeleteItem(null);
    }
  };

  // ─── Build sections ───────────────────────────────────────────────────

  const grocerySections = grouped
    ? GROCERY_SECTIONS.filter((meta) => grouped[meta.key]?.length > 0).map((meta) => ({
        ...meta,
        data: grouped[meta.key],
      }))
    : [];
  const totalCount = grocerySections.reduce((sum, s) => sum + s.data.length, 0);

  // ─── Render helpers ───────────────────────────────────────────────────

  const renderSectionHeader = ({ section }) => (
    <View style={styles.sectionHeader}>
      <View
        style={[
          styles.sectionDot,
          {
            backgroundColor: section.statusColor,
          },
        ]}
      />
      <Text
        style={[
          styles.sectionTitle,
          {
            color: section.statusColor,
          },
        ]}
      >
        {section.title.toUpperCase()}
      </Text>
      <Text
        style={[
          styles.sectionCount,
          {
            color: section.statusColor,
          },
        ]}
      >
        {section.data.length}
      </Text>
    </View>
  );
  const renderGroceryItem = ({ item }) => {
    const isBought = item.isBought;
    const isAssignee = item.assignedTo?.id === user?.id;
    const canTogglePending = !isBought && (user?.role === 'admin' || isAssignee);
    const canToggleBought = isBought && (user?.role === 'admin' || item.boughtBy?.id === user?.id);
    const canToggle = canTogglePending || canToggleBought;
    const assigneeName = (item.assignedTo ?? item.boughtBy)?.displayName?.split(' ')[0] || '';
    const meta = [item.quantity, assigneeName].filter(Boolean).join(' · ');
    return (
      <TouchableOpacity
        style={styles.itemRow}
        onPress={() => openEditSheet(item)}
        onLongPress={() => handleGroceryLongPress(item)}
        activeOpacity={0.7}
        delayLongPress={400}
      >
        <TouchableOpacity
          style={[
            styles.checkbox,
            isBought && styles.checkboxDone,
            !canToggle && styles.checkboxDisabled,
          ]}
          onPress={() => canToggle && handleGroceryToggle(item.id)}
          hitSlop={{
            top: 8,
            bottom: 8,
            left: 8,
            right: 8,
          }}
          disabled={!canToggle}
        >
          {isBought && <Text style={styles.checkmark}>✓</Text>}
        </TouchableOpacity>

        <View style={styles.itemContent}>
          <Text style={[styles.itemName, isBought && styles.itemNameDone]} numberOfLines={1}>
            {item.name}
          </Text>
          {meta ? (
            <Text style={styles.itemMeta} numberOfLines={1}>
              {meta}
            </Text>
          ) : null}
        </View>
      </TouchableOpacity>
    );
  };
  // ─── Loading ──────────────────────────────────────────────────────────

  if (loading) {
    return (
      <View
        style={[
          styles.container,
          {
            paddingTop: insets.top,
          },
        ]}
      >
        <ActivityIndicator
          size="large"
          color={colors.gold}
          style={{
            flex: 1,
          }}
        />
      </View>
    );
  }
  const sheetTitle = editItem ? 'Edit item' : 'Add item';

  // ─── Main render ──────────────────────────────────────────────────────

  return (
    <KeyboardAvoidingView
      style={[
        styles.container,
        {
          paddingTop: insets.top,
        },
      ]}
      behavior={KEYBOARD_BEHAVIOR}
    >
      <StatusBar barStyle="light-content" backgroundColor={colors.canvas} />

      {/* ── Header: back chevron + centered title (SCREEN 19/21) ── */}
      <View style={styles.header}>
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
        <Text style={styles.headerTitle}>Grocery List</Text>
        <View style={styles.headerSpacer} />
      </View>

      {/* ── Add item pill (SCREEN 19/21) → opens the Add sheet ── */}
      {user?.role !== 'child' ? (
        <View style={styles.addBar}>
          <TouchableOpacity style={styles.addInput} onPress={openAddSheet} activeOpacity={0.7}>
            <Text style={styles.addInputPlaceholder}>Add an item…</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {/* ── List (kept grouped sections, flat rows) ── */}
      <SectionList
        sections={grocerySections}
        keyExtractor={(item) => item.id}
        renderItem={renderGroceryItem}
        renderSectionHeader={renderSectionHeader}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={colors.gold}
            colors={[colors.gold]}
          />
        }
        ListEmptyComponent={
          <EmptyState
            icon={<Text style={styles.emptyEmoji}>🛒</Text>}
            title="List is empty"
            subtitle="Add something above to get started"
            dark
          />
        }
        contentContainerStyle={
          totalCount === 0
            ? styles.emptyContainer
            : [styles.listContent, { paddingBottom: dockHeight + 16 }]
        }
        stickySectionHeadersEnabled={false}
        showsVerticalScrollIndicator={false}
      />

      {/* ── Add / Edit sheet (SCREEN 20) ── */}
      <BottomSheet visible={showItemSheet} onClose={() => setShowItemSheet(false)}>
        <View style={sheet.handle} />
        <Text style={sheet.title}>{sheetTitle}</Text>

        {/* Fields + actions scroll as one block so every input stays
            reachable once the keyboard shrinks the sheet. The handle and
            title above stay pinned. */}
        <ScrollView
          style={sheet.scroll}
          showsVerticalScrollIndicator={false}
          {...keyboardScrollProps}
        >
        <View style={styles.form}>
          {/* Item */}
          <Field label="Item">
            <TextInput
              style={[styles.input, styles.inputFocused]}
              placeholder="Whole milk"
              placeholderTextColor={colors.textMuted}
              value={itemName}
              onChangeText={setItemName}
              maxLength={200}
            />
          </Field>

          <Field label="Quantity">
            <TextInput
              style={styles.input}
              placeholder="2, 500g, 1L"
              placeholderTextColor={colors.textMuted}
              value={itemQty}
              onChangeText={setItemQty}
              maxLength={40}
            />
          </Field>
          <Field label="Note">
            <TextInput
              style={styles.input}
              placeholder="2% if they have it"
              placeholderTextColor={colors.textMuted}
              value={itemNote}
              onChangeText={setItemNote}
              maxLength={200}
            />
          </Field>

          {/* Assignee */}
          <Field label="Assignee">
            <TouchableOpacity
              style={styles.input}
              onPress={() => setShowAssigneeSheet(true)}
              activeOpacity={0.7}
            >
              <Text style={itemAssignee ? styles.inputValue : styles.inputPlaceholder}>
                {itemAssignee
                  ? members.find((m) => m.userId === itemAssignee)?.displayName || ''
                  : 'Select'}
              </Text>
            </TouchableOpacity>
          </Field>
        </View>

        {/* Save + remove */}
        <TouchableOpacity
          style={[styles.saveBtn, saving && styles.saveBtnDisabled]}
          onPress={handleSaveItem}
          disabled={saving}
          activeOpacity={0.85}
        >
          <GoldFill radius={radius.pill} disabled={saving} />
          {saving ? (
            <ActivityIndicator size="small" color={colors.onAccent} />
          ) : (
            <Text style={styles.saveBtnText}>Save changes</Text>
          )}
        </TouchableOpacity>
        {editItem && (
          <TouchableOpacity
            style={styles.removeLink}
            onPress={() => {
              setConfirmDeleteItem(editItem);
            }}
            activeOpacity={0.6}
          >
            <Text style={styles.removeLinkText}>Remove item</Text>
          </TouchableOpacity>
        )}
        </ScrollView>
      </BottomSheet>

      {/* ── Assignee picker sheet ── */}
      <AssigneePickerSheet
        visible={showAssigneeSheet}
        members={members}
        selectedId={itemAssignee}
        onSelect={setItemAssignee}
        onClose={() => setShowAssigneeSheet(false)}
      />

      {/* Delete item confirmation sheet */}
      <ConfirmSheet
        visible={!!confirmDeleteItem}
        title={confirmDeleteItem ? `Remove ${confirmDeleteItem.name}?` : ''}
        subtitle="This item will be permanently removed from the grocery list."
        confirmLabel="Remove"
        onConfirm={confirmDeleteNow}
        onCancel={() => setConfirmDeleteItem(null)}
      />
    </KeyboardAvoidingView>
  );
}

// ─── Styles ────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.canvas,
  },
  // Header (SCREEN 19/21)
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
    color: colors.ink,
    lineHeight: 20,
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: '700',
    fontFamily: fonts.displayBold,
    color: colors.ink,
  },
  headerSpacer: {
    width: 32,
  },
  // Add pill (SCREEN 19/21)
  addBar: {
    paddingHorizontal: 24,
    paddingBottom: 16,
  },
  addInput: {
    height: 48,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1.5,
    borderColor: colors.border,
    paddingHorizontal: 18,
    justifyContent: 'center',
  },
  addInputPlaceholder: {
    fontSize: 14,
    fontFamily: fonts.body,
    color: colors.textMuted,
  },
  // Section headers (kept grouping)
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 24,
    paddingTop: 24,
    paddingBottom: 6,
  },
  sectionDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: '700',
    fontFamily: fonts.bodyBold,
    letterSpacing: 1.4,
  },
  sectionCount: {
    fontSize: 11,
    fontWeight: '700',
    fontFamily: fonts.bodyBold,
    opacity: 0.7,
  },
  // Item rows (SCREEN 19/21 flat rows)
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 14,
    paddingHorizontal: 24,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 7,
    borderWidth: 2,
    borderColor: colors.ink,
    backgroundColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  checkboxDone: {
    backgroundColor: colors.gold,
    borderColor: colors.gold,
  },
  checkboxDisabled: {
    opacity: 0.3,
  },
  checkmark: {
    fontSize: 11,
    fontWeight: '900',
    color: colors.onAccent,
    lineHeight: 13,
  },
  itemContent: {
    flex: 1,
  },
  itemName: {
    fontSize: 15,
    fontFamily: fonts.body,
    color: colors.ink,
    lineHeight: 20,
  },
  itemNameDone: {
    textDecorationLine: 'line-through',
    color: colors.textMuted,
  },
  itemMeta: {
    fontSize: 12,
    fontFamily: fonts.body,
    color: colors.textMuted,
    marginTop: 2,
  },
  // Empty
  listContent: {
    paddingBottom: 60,
  },
  emptyContainer: {
    flexGrow: 1,
    justifyContent: 'center',
  },
  emptyEmoji: {
    fontSize: 28,
  },
  // Edit sheet fields (SCREEN 20)
  form: {
    gap: 4,
    paddingBottom: 8,
  },
  input: {
    height: 52,
    borderRadius: radius.card,
    backgroundColor: colors.canvas,
    borderWidth: 1.5,
    borderColor: colors.border,
    paddingHorizontal: 16,
    fontSize: 14,
    fontFamily: fonts.body,
    color: colors.ink,
    justifyContent: 'center',
  },
  inputFocused: {
    borderWidth: 2,
    borderColor: colors.gold,
  },
  inputValue: {
    fontSize: 14,
    fontFamily: fonts.bodyMedium,
    color: colors.ink,
  },
  inputPlaceholder: {
    fontSize: 14,
    fontFamily: fonts.body,
    color: colors.textMuted,
  },
  saveBtn: {
    height: 54,
    borderRadius: radius.pill,
    backgroundColor: colors.gold,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
    ...goldButton.glow,
  },
  saveBtnDisabled: {
    opacity: 0.5,
  },
  saveBtnText: {
    fontSize: 15,
    fontWeight: '600',
    fontFamily: fonts.displayBold,
    color: colors.onAccent,
  },
  removeLink: {
    alignItems: 'center',
    paddingVertical: 12,
    marginTop: 4,
  },
  removeLinkText: {
    fontSize: 13,
    fontWeight: '500',
    fontFamily: fonts.bodyMedium,
    color: colors.danger,
  },
});
