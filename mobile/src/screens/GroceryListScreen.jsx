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
  Modal,
  KeyboardAvoidingView,
  Platform,
  FlatList,
  ScrollView,
} from 'react-native';
import { showAlert } from '../shared/services/themedAlert';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { groceryApi } from '../shared/api/grocery';
import { todoApi } from '../shared/api/todo';
import { householdApi } from '../shared/api/household';
import { useAuthStore } from '../shared/store/authStore';
import DateTimePicker from '@react-native-community/datetimepicker';
import { format, addDays } from 'date-fns';
import { colors, fonts, goldButton, radius, withAlpha } from '../shared/theme';
import { GoldFill } from '../shared/components/GoldButton';
import ConfirmSheet from '../components/ConfirmSheet';
import EmptyState from '../components/EmptyState';
import Avatar from '../components/Avatar';
import { KEYBOARD_BEHAVIOR, keyboardScrollProps } from '../shared/components/KeyboardAware';
import { useTabBarDockHeight } from '../shared/hooks/useTabBarDockHeight';

// ─── Section type shared for both tabs ────────────────────────────────────

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
const TODO_SECTIONS = [
  {
    key: 'pending',
    title: 'To Do',
    statusColor: colors.goldDeep,
  },
  {
    key: 'completed',
    title: 'Completed',
    statusColor: colors.success,
  },
];

// ─── Component ─────────────────────────────────────────────────────────────

export default function GroceryListScreen({ navigation }) {
  const [grouped, setGrouped] = useState(null);
  const [groceryLoading, setGroceryLoading] = useState(true);
  const [todos, setTodos] = useState(null);
  const [todoLoading, setTodoLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState('GROCERY');
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
  const [itemDueDate, setItemDueDate] = useState('');
  const [itemAssignee, setItemAssignee] = useState(null);
  const [members, setMembers] = useState([]);
  const [saving, setSaving] = useState(false);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showAssigneeSheet, setShowAssigneeSheet] = useState(false);

  // Destructive confirm sheets
  const [confirmDeleteItem, setConfirmDeleteItem] = useState(null);
  const [confirmDeleteAction, setConfirmDeleteAction] = useState(null);
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
    setItemDueDate('');
    setItemAssignee(null);
    await loadMembers();
    setShowItemSheet(true);
  }, [loadMembers]);
  const openEditSheet = useCallback(
    async (item) => {
      setEditItem(item);
      if ('isCompleted' in item) {
        // Todo
        setItemName(item.title);
        setItemQty('');
        setItemNote('');
        setItemDueDate(item.dueDate || '');
        setItemAssignee(item.assignedTo?.id ?? null);
      } else {
        setItemName(item.name);
        setItemQty(item.quantity || '');
        setItemNote(item.note || '');
        setItemDueDate('');
        setItemAssignee(item.assignedTo?.id ?? null);
      }
      await loadMembers();
      setShowItemSheet(true);
    },
    [loadMembers],
  );
  const loading = activeTab === 'GROCERY' ? groceryLoading : todoLoading;

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
  const loadTodos = useCallback(async () => {
    try {
      const data = await todoApi.list();
      setTodos(data);
    } catch {
      showAlert('Error', 'Could not load to-dos');
    } finally {
      setTodoLoading(false);
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
      const doingTodo = editItem ? 'isCompleted' in editItem : activeTab === 'TO-DO';
      if (doingTodo) {
        const payload = {};
        if (trimmed) payload.title = trimmed;
        if (itemDueDate.trim()) payload.dueDate = itemDueDate.trim();
        if (itemAssignee) payload.assignedTo = itemAssignee;
        if (editItem) {
          await todoApi.update(editItem.id, payload);
        } else {
          await todoApi.create({
            title: trimmed,
            dueDate: itemDueDate.trim() || undefined,
            assignedTo: itemAssignee || undefined,
          });
        }
      } else {
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
      }
      setShowItemSheet(false);
      if (doingTodo) await loadTodos();
      else await loadGroceries();
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
    itemDueDate,
    itemAssignee,
    editItem,
    activeTab,
    loadTodos,
    loadGroceries,
  ]);
  useEffect(() => {
    loadGroceries();
    loadTodos();
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
    if (activeTab === 'GROCERY') loadGroceries();
    else loadTodos();
  }, [activeTab, loadGroceries, loadTodos]);

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
          onPress: () => {
            setConfirmDeleteItem(item);
            setConfirmDeleteAction('grocery');
          },
        });
      }
      if (opts.length > 1) {
        showAlert(item.name, 'What would you like to do?', opts);
      }
    },
    [loadGroceries, user],
  );
  const handleTodoToggle = useCallback(
    async (id) => {
      try {
        await todoApi.toggle(id);
        await loadTodos();
      } catch {
        showAlert('Error', 'Could not update to-do');
      }
    },
    [loadTodos],
  );
  const handleTodoDelete = useCallback((item) => {
    setConfirmDeleteItem(item);
    setConfirmDeleteAction('todo');
  }, []);
  const confirmDeleteNow = async () => {
    if (!confirmDeleteItem || !confirmDeleteAction) return;
    setShowItemSheet(false);
    try {
      if (confirmDeleteAction === 'grocery') {
        await groceryApi.delete(confirmDeleteItem.id);
        await loadGroceries();
      } else {
        await todoApi.delete(confirmDeleteItem.id);
        await loadTodos();
      }
    } catch {
      showAlert('Error', 'Could not delete');
    } finally {
      setConfirmDeleteItem(null);
      setConfirmDeleteAction(null);
    }
  };

  // ─── Build sections ───────────────────────────────────────────────────

  const grocerySections = grouped
    ? GROCERY_SECTIONS.filter((meta) => grouped[meta.key]?.length > 0).map((meta) => ({
        ...meta,
        data: grouped[meta.key],
        type: 'grocery',
      }))
    : [];
  const todoSections = todos
    ? TODO_SECTIONS.filter((meta) => todos[meta.key]?.length > 0).map((meta) => ({
        ...meta,
        data: todos[meta.key],
        type: 'todo',
      }))
    : [];
  const activeSections = activeTab === 'GROCERY' ? grocerySections : todoSections;
  const totalCount = activeSections.reduce((sum, s) => sum + s.data.length, 0);

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
  const renderTodoItem = ({ item }) => {
    const isDone = item.isCompleted;
    const isAssignee = item.assignedTo?.id === user?.id;
    const canToggle = !item.assignedTo || isAssignee || user?.role === 'admin';
    const canDelete = isAssignee || user?.role === 'admin';
    const assigneeName = item.assignedTo?.displayName?.split(' ')[0] || '';
    return (
      <TouchableOpacity
        style={styles.itemRow}
        onPress={() => openEditSheet(item)}
        onLongPress={canDelete ? () => handleTodoDelete(item) : undefined}
        activeOpacity={0.7}
        delayLongPress={400}
      >
        <TouchableOpacity
          style={[
            styles.checkbox,
            isDone && styles.checkboxDone,
            !canToggle && styles.checkboxDisabled,
          ]}
          onPress={canToggle ? () => handleTodoToggle(item.id) : undefined}
          hitSlop={{
            top: 8,
            bottom: 8,
            left: 8,
            right: 8,
          }}
          activeOpacity={canToggle ? 0.6 : 1}
        >
          {isDone && <Text style={styles.checkmark}>✓</Text>}
        </TouchableOpacity>

        <View style={styles.itemContent}>
          <Text style={[styles.itemName, isDone && styles.itemNameDone]} numberOfLines={1}>
            {item.title}
          </Text>
          {assigneeName ? (
            <Text style={styles.itemMeta} numberOfLines={1}>
              {assigneeName}
            </Text>
          ) : null}
        </View>
      </TouchableOpacity>
    );
  };
  const renderItem = ({ item, section }) => {
    if (section.type === 'grocery')
      return renderGroceryItem({
        item: item,
      });
    return renderTodoItem({
      item: item,
    });
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
  const isTodoSheet = editItem ? 'isCompleted' in editItem : activeTab === 'TO-DO';
  const sheetTitle = editItem ? 'Edit item' : isTodoSheet ? 'Add to-do' : 'Add item';

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

      {/* ── Header: back chevron + centered "Lists" (SCREEN 19/21) ── */}
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
        <Text style={styles.headerTitle}>Lists</Text>
        <View style={styles.headerSpacer} />
      </View>

      {/* ── Text tabs (SCREEN 19/21) ── */}
      <View style={styles.tabRow}>
        {['GROCERY', 'TO-DO'].map((tab) => {
          const active = activeTab === tab;
          const label = tab === 'GROCERY' ? 'Grocery' : 'To-do';
          return (
            <TouchableOpacity key={tab} onPress={() => setActiveTab(tab)} activeOpacity={0.6}>
              <Text style={[styles.tabText, active && styles.tabTextActive]}>{label}</Text>
            </TouchableOpacity>
          );
        })}
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
        sections={activeSections}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
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
      <Modal
        visible={showItemSheet}
        transparent
        animationType="slide"
        /* RN Modals render in their own native window, which on Android does
           not receive keyboard insets unless these are set — without them the
           avoider below computes a zero offset and the sheet never lifts. */
        statusBarTranslucent
        navigationBarTranslucent
        onRequestClose={() => setShowItemSheet(false)}
      >
        {/* The avoider is the full-screen root (mirrors CreateTaskScreen):
            `height` shrinks this container so the flex-end sheet slides up.
            When it sat on sheet.box instead, the box shrank in place. */}
        <KeyboardAvoidingView style={sheet.overlay} behavior={KEYBOARD_BEHAVIOR}>
          <TouchableOpacity
            style={sheet.backdrop}
            activeOpacity={1}
            onPress={() => setShowItemSheet(false)}
          />
          <View style={sheet.box}>
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

              {/* Grocery extras */}
              {!isTodoSheet && (
                <>
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
                </>
              )}

              {/* Todo extras */}
              {isTodoSheet && (
                <Field label="Due date">
                  <View>
                    <View style={styles.dateRow}>
                      {(() => {
                        const todayStr = format(new Date(), 'yyyy-MM-dd');
                        const tomorrowStr = format(addDays(new Date(), 1), 'yyyy-MM-dd');
                        return (
                          <>
                            <TouchableOpacity
                              style={[
                                styles.dateChip,
                                itemDueDate === todayStr && styles.dateChipActive,
                              ]}
                              onPress={() =>
                                setItemDueDate(itemDueDate === todayStr ? '' : todayStr)
                              }
                              activeOpacity={0.7}
                            >
                              <Text
                                style={[
                                  styles.dateChipText,
                                  itemDueDate === todayStr && styles.dateChipTextActive,
                                ]}
                              >
                                Today
                              </Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                              style={[
                                styles.dateChip,
                                itemDueDate === tomorrowStr && styles.dateChipActive,
                              ]}
                              onPress={() =>
                                setItemDueDate(itemDueDate === tomorrowStr ? '' : tomorrowStr)
                              }
                              activeOpacity={0.7}
                            >
                              <Text
                                style={[
                                  styles.dateChipText,
                                  itemDueDate === tomorrowStr && styles.dateChipTextActive,
                                ]}
                              >
                                Tomorrow
                              </Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                              style={styles.datePickerBtn}
                              onPress={() => setShowDatePicker(true)}
                              activeOpacity={0.7}
                            >
                              <Text style={styles.datePickerBtnText}>📅 Pick a date</Text>
                            </TouchableOpacity>
                          </>
                        );
                      })()}
                    </View>
                    {itemDueDate && (
                      <Text style={styles.selectedDateText}>
                        Due {format(new Date(itemDueDate + 'T00:00:00'), 'MMM d, yyyy')}
                      </Text>
                    )}
                    {showDatePicker && (
                      <DateTimePicker
                        value={itemDueDate ? new Date(itemDueDate + 'T00:00:00') : new Date()}
                        mode="date"
                        display={Platform.OS === 'ios' ? 'spinner' : 'default'}
                        onChange={(_event, date) => {
                          setShowDatePicker(false);
                          if (date) setItemDueDate(format(date, 'yyyy-MM-dd'));
                        }}
                      />
                    )}
                  </View>
                </Field>
              )}

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
                  setConfirmDeleteAction('isCompleted' in editItem ? 'todo' : 'grocery');
                }}
                activeOpacity={0.6}
              >
                <Text style={styles.removeLinkText}>Remove item</Text>
              </TouchableOpacity>
            )}
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* ── Assignee picker sheet ── */}
      <Modal
        visible={showAssigneeSheet}
        transparent
        animationType="slide"
        onRequestClose={() => setShowAssigneeSheet(false)}
      >
        <View style={sheet.overlay}>
          <TouchableOpacity
            style={sheet.backdrop}
            activeOpacity={1}
            onPress={() => setShowAssigneeSheet(false)}
          />
          <View
            style={[
              sheet.box,
              {
                paddingBottom: insets.bottom + 12,
              },
            ]}
          >
            <View style={sheet.pickHeader}>
              <TouchableOpacity onPress={() => setShowAssigneeSheet(false)} hitSlop={8}>
                <Text style={sheet.closeText}>Close</Text>
              </TouchableOpacity>
              <Text style={sheet.pickTitle}>Assignee</Text>
              <View
                style={{
                  minWidth: 44,
                }}
              />
            </View>
            <FlatList
              data={members}
              keyExtractor={(item) => item.userId}
              renderItem={({ item }) => {
                const sel = itemAssignee === item.userId;
                return (
                  <TouchableOpacity
                    style={[sheet.memberRow, sel && sheet.memberRowActive]}
                    onPress={() => {
                      setItemAssignee(sel ? null : item.userId);
                      setShowAssigneeSheet(false);
                    }}
                    activeOpacity={0.7}
                  >
                    <Avatar
                      url={item.avatarUrl}
                      emoji={item.avatarEmoji}
                      name={item.displayName}
                      id={item.userId}
                      size={40}
                    />
                    <Text style={sheet.memberName}>{item.displayName}</Text>
                    {sel && <Text style={sheet.memberCheck}>✓</Text>}
                  </TouchableOpacity>
                );
              }}
            />
          </View>
        </View>
      </Modal>

      {/* Delete item confirmation sheet */}
      <ConfirmSheet
        visible={!!confirmDeleteItem}
        title={
          confirmDeleteItem
            ? confirmDeleteAction === 'grocery'
              ? `Remove ${confirmDeleteItem.name}?`
              : 'isCompleted' in confirmDeleteItem
                ? `Delete "${confirmDeleteItem.title}"?`
                : `Remove ${confirmDeleteItem.name}?`
            : ''
        }
        subtitle={
          confirmDeleteItem
            ? confirmDeleteAction === 'grocery'
              ? 'This item will be permanently removed from the grocery list.'
              : 'isCompleted' in confirmDeleteItem
                ? 'This to-do will be permanently deleted.'
                : 'This item will be permanently removed from the grocery list.'
            : ''
        }
        confirmLabel={confirmDeleteAction === 'grocery' ? 'Remove' : 'Delete'}
        onConfirm={confirmDeleteNow}
        onCancel={() => {
          setConfirmDeleteItem(null);
          setConfirmDeleteAction(null);
        }}
      />
    </KeyboardAvoidingView>
  );
}

// ─── Small pieces ──────────────────────────────────────────────────────────

function Field({ label, children }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
    </View>
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
  // Tabs (SCREEN 19/21)
  tabRow: {
    flexDirection: 'row',
    gap: 26,
    paddingHorizontal: 24,
    paddingTop: 4,
    paddingBottom: 16,
  },
  tabText: {
    fontSize: 14,
    fontWeight: '400',
    fontFamily: fonts.body,
    color: colors.textMuted,
  },
  tabTextActive: {
    fontWeight: '600',
    fontFamily: fonts.bodySemiBold,
    color: colors.ink,
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
  field: {
    marginBottom: 14,
  },
  fieldLabel: {
    fontSize: 11,
    fontWeight: '600',
    fontFamily: fonts.bodySemiBold,
    letterSpacing: 0.4,
    color: colors.textSecondary,
    marginBottom: 7,
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
  dateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  dateChip: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  dateChipActive: {
    borderColor: colors.gold,
    backgroundColor: colors.goldLight,
  },
  dateChipText: {
    fontSize: 13,
    fontWeight: '600',
    fontFamily: fonts.bodySemiBold,
    color: colors.textSecondary,
  },
  dateChipTextActive: {
    color: colors.goldDeep,
  },
  datePickerBtn: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderStyle: 'dashed',
  },
  datePickerBtnText: {
    fontSize: 13,
    fontWeight: '600',
    fontFamily: fonts.bodySemiBold,
    color: colors.textSecondary,
  },
  selectedDateText: {
    marginTop: 8,
    fontSize: 13,
    fontWeight: '600',
    fontFamily: fonts.bodySemiBold,
    color: colors.goldDeep,
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

// ── Sheet shell styles ─────────────────────────────────────────────────────

const sheet = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: withAlpha(colors.shadow, 0.55),
  },
  box: {
    backgroundColor: colors.canvasElevated,
    borderTopLeftRadius: 32,
    borderTopRightRadius: 32,
    borderWidth: 1,
    borderColor: colors.border,
    borderBottomWidth: 0,
    paddingTop: 14,
    paddingHorizontal: 24,
    paddingBottom: 40,
    /* Definite height (not maxHeight) is what makes the scroller work — it
       gives sheet.scroll's `flex: 1` a bounded box to fill, so content taller
       than the sheet actually overflows and scrolls. With `maxHeight` the box
       just sized to its content and there was never anything to scroll.
       Mirrors CreateTaskScreen's styles.sheet. */
    height: '85%',
  },
  scroll: {
    flex: 1,
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
    alignSelf: 'center',
    marginBottom: 22,
  },
  title: {
    fontSize: 18,
    fontWeight: '600',
    fontFamily: fonts.displayBold,
    color: colors.ink,
    textAlign: 'center',
    marginBottom: 22,
  },
  pickHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
  },
  closeText: {
    fontSize: 15,
    fontWeight: '500',
    fontFamily: fonts.bodyMedium,
    color: colors.goldDeep,
    minWidth: 44,
  },
  pickTitle: {
    fontSize: 16,
    fontWeight: '600',
    fontFamily: fonts.displayBold,
    color: colors.ink,
  },
  memberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
  },
  memberRowActive: {
    opacity: 0.7,
  },
  memberName: {
    flex: 1,
    fontSize: 15,
    fontWeight: '600',
    fontFamily: fonts.bodySemiBold,
    color: colors.ink,
  },
  memberCheck: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.goldDeep,
  },
});
