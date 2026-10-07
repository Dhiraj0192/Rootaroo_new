import React, { useEffect, useCallback, useRef, useMemo, useState } from 'react';
import {
  AppState,
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  FlatList,
  Keyboard,
  Modal,
  TextInput,
  TouchableOpacity,
  Image,
  Dimensions,
  Platform,
} from 'react-native';
import { showAlert } from '../shared/services/themedAlert';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import * as Clipboard from 'expo-clipboard';
import { useChatStore } from '../shared/store/chatStore';
import { registerChatSocket, unregisterChatSocket, setViewingConversation } from '../shared/socket/chatSocket';
import { connectSocket } from '../shared/socket';
import { useAuthStore } from '../shared/store/authStore';
import { colors, fonts, goldButton, radius, withAlpha } from '../shared/theme';
import { GoldFill } from '../shared/components/GoldButton';
import Avatar from '../components/Avatar';
import MessageBubble from '../components/MessageBubble';
import ChatInputBar from '../components/ChatInputBar';
import TypingIndicator from '../components/TypingIndicator';
import { chatApi } from '../shared/api/chat';
import { householdApi } from '../shared/api/household';
import { SvgXml } from 'react-native-svg';
import { Ionicons } from '@expo/vector-icons';
import { chatTheme } from '../shared/theme/chat';

// Quick reactions shown in the long-press message actions dropdown (SCREEN 31)
const MESSAGE_EMOJIS = ['👍', '❤️', '😂', '😲', '😢'];
const formatDateDivider = (dateStr) => {
  const d = new Date(dateStr);
  const now = new Date();
  const dDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const nowDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.round((nowDay.getTime() - dDay.getTime()) / 86400000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) {
    return d.toLocaleDateString('en-US', {
      weekday: 'long',
    });
  }
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
  });
};
export default function ChatScreen({ route }) {
  const { conversationId, title } = route.params;
  const insets = useSafeAreaInsets();
  const flatListRef = useRef(null);
  const conversationIdRef = useRef(conversationId);
  const nav = useNavigation();
  const user = useAuthStore((s) => s.user);
  const [members, setMembers] = useState([]);
  const [currentConv, setCurrentConv] = useState(null);

  // WhatsApp-style selection state
  const [selectedMessage, setSelectedMessage] = useState(null);
  const [selectedAnchor, setSelectedAnchor] = useState(null);
  const [menuVisible, setMenuVisible] = useState(false);
  const navigation = useNavigation();

  // Manual keyboard-height tracking — KeyboardAvoidingView's built-in
  // 'height'/'padding' behaviors both get stuck mid-transition on Android
  // under edge-to-edge (the padding/height never resets to 0 after the
  // keyboard hides). Tracking real Keyboard events and driving padding
  // ourselves guarantees it snaps back to exactly 0 on dismiss.
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvent, (e) => {
      setKeyboardHeight(e.endCoordinates?.height || 0);
    });
    const hideSub = Keyboard.addListener(hideEvent, () => {
      setKeyboardHeight(0);
    });
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  useEffect(() => {
    const hhId = user?.householdId;
    if (!hhId) return;
    householdApi
      .getMembers(hhId)
      .then(setMembers)
      .catch(() => {});
  }, [user?.householdId]);
  useEffect(() => {
    if (!conversationId) return;
    chatApi
      .listConversations()
      .then((list) => {
        const found = list.find((c) => c.id === conversationId);
        if (found) setCurrentConv(found);
      })
      .catch(() => {});
  }, [conversationId]);
  const convType = currentConv?.type || route.params?.type;
  const partCount = currentConv?.participants?.length || route.params?.participantCount;
  const subtitleText = useMemo(() => {
    if (convType === 'dm') {
      return 'Direct Message';
    }
    if (convType === 'household') {
      const cnt = partCount || (members.length > 0 ? members.length : 1);
      return `${cnt} ${cnt === 1 ? 'member' : 'members'} · all in household`;
    }
    if (convType === 'group') {
      const cnt = partCount || (members.length > 0 ? members.length : 1);
      return `${cnt} ${cnt === 1 ? 'member' : 'members'}`;
    }
    if (members.length > 0) {
      return `${members.length} ${members.length === 1 ? 'member' : 'members'}`;
    }
    return 'Direct Message';
  }, [convType, partCount, members.length]);
  const messages = useChatStore((s) => s.messages);
  const loading = useChatStore((s) => s.loading);
  const refreshing = useChatStore((s) => s.refreshing);
  const hasMore = useChatStore((s) => s.hasMore);
  const error = useChatStore((s) => s.error);
  const typingUsers = useChatStore((s) => s.typingUsers);
  const replyTo = useChatStore((s) => s.replyTo);
  const fetchMessages = useChatStore((s) => s.fetchMessages);
  const fetchMoreMessages = useChatStore((s) => s.fetchMoreMessages);
  const refreshMessages = useChatStore((s) => s.refreshMessages);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const deleteMessage = useChatStore((s) => s.deleteMessage);
  const deleteConversation = useChatStore((s) => s.deleteConversation);
  const updateMessage = useChatStore((s) => s.updateMessage);
  const toggleReaction = useChatStore((s) => s.toggleReaction);
  const setReplyTo = useChatStore((s) => s.setReplyTo);
  const BACK_SVG =
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none">' +
    `<path d="M15 5l-7 7 7 7" stroke="${chatTheme.chipIcon}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path>` +
    '</svg>';
  const handleDeleteConversation = useCallback(() => {
    showAlert(
      'Delete Conversation',
      'Are you sure you want to delete this conversation? All messages will be permanently deleted.',
      [
        {
          text: 'Cancel',
          style: 'cancel',
        },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteConversation(conversationId);
              nav.goBack();
            } catch (err) {
              showAlert('Error', err?.message || 'Failed to delete conversation');
            }
          },
        },
      ],
    );
  }, [conversationId, deleteConversation, nav]);
  const handleOpenMenu = useCallback(() => {
    showAlert(
      'Options',
      undefined,
      [
        {
          text: 'Delete Conversation',
          style: 'destructive',
          onPress: handleDeleteConversation,
        },
        {
          text: 'Cancel',
          style: 'cancel',
        },
      ],
      {
        cancelable: true,
      },
    );
  }, [handleDeleteConversation]);
  const currentUserId = useAuthStore((s) => s.user?.id || '');
  const headerAvatarMembers = (currentConv?.participants || [])
    .filter((p) => p.id !== currentUserId)
    .slice(0, 2);
  const token = useAuthStore((s) => s.accessToken);
  const [editingMessage, setEditingMessage] = useState(null);
  const [previewMedia, setPreviewMedia] = useState(null);
  const [showScrollButton, setShowScrollButton] = useState(false);
  // Server skips pushes for the conversation on screen. Cleared while backgrounded.
  const isFocusedRef = useRef(false);
  useFocusEffect(
    useCallback(() => {
      isFocusedRef.current = true;
      setViewingConversation(conversationId);
      return () => {
        isFocusedRef.current = false;
        setViewingConversation(null);
      };
    }, [conversationId]),
  );
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'background') setViewingConversation(null);
      else if (s === 'active' && isFocusedRef.current) setViewingConversation(conversationIdRef.current);
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    conversationIdRef.current = conversationId;
    if (token) {
      connectSocket(token);
    }
    registerChatSocket();
    if (conversationId) {
      fetchMessages(conversationId);
      // Opening the conversation is the "read" signal — best-effort, never
      // block viewing messages on it.
      chatApi.markConversationRead(conversationId).catch(() => {});
    }
    return () => {
      unregisterChatSocket();
      useChatStore.setState({
        messages: [],
        cursor: null,
        hasMore: true,
      });
    };
  }, [token, conversationId]);
  useEffect(() => {
    if (messages.length > 0 && !loading) {
      const t = setTimeout(() => {
        flatListRef.current?.scrollToOffset({
          offset: 0,
          animated: false,
        });
      }, 100);
      return () => clearTimeout(t);
    }
  }, [loading]);

  // Follow to the newest message when it arrives and we're already near the bottom
  const isNearBottomRef = useRef(true);
  const prevCountRef = useRef(0);
  useEffect(() => {
    const prev = prevCountRef.current;
    prevCountRef.current = messages.length;
    if (messages.length > prev && isNearBottomRef.current && !loading) {
      const t = setTimeout(() => scrollToBottom(), 120);
      return () => clearTimeout(t);
    }
  }, [messages.length]);

  // Construct flat list items (oldest first — index 0 renders at the top).
  // Store keeps messages newest-first; we reverse so the chat reads top→bottom.
  const flatListItems = useMemo(() => {
    if (!messages || messages.length === 0) return [];
    const ordered = [...messages].reverse();
    const items = [];
    let prevDate = null;
    for (let i = 0; i < ordered.length; i++) {
      const msg = ordered[i];
      const currentDate = formatDateDivider(msg.createdAt);
      if (currentDate !== prevDate) {
        items.push({
          type: 'date',
          date: currentDate,
          id: `date-${msg.createdAt}-${i}`,
        });
        prevDate = currentDate;
      }
      items.push({
        type: 'message',
        message: msg,
      });
    }
    return items;
  }, [messages]);
  const handleSend = useCallback(
    async (content, mediaIds) => {
      const body = {};
      if (content) body.content = content;
      if (mediaIds) body.mediaIds = mediaIds;
      if (replyTo) body.replyToId = replyTo.messageId;
      await sendMessage(conversationId, body);
    },
    [replyTo, sendMessage, conversationId],
  );
  const handleSendVoice = useCallback(
    async (mediaUrl, durationSeconds) => {
      const body = { mediaUrl, type: 'voice', durationSeconds };
      if (replyTo) body.replyToId = replyTo.messageId;
      await sendMessage(conversationId, body);
    },
    [replyTo, sendMessage, conversationId],
  );
  const handleSendImage = useCallback(
    async (mediaUrl) => {
      const body = { mediaUrl, type: 'image' };
      if (replyTo) body.replyToId = replyTo.messageId;
      await sendMessage(conversationId, body);
    },
    [replyTo, sendMessage, conversationId],
  );
  const handleDelete = useCallback(
    async (messageId) => {
      try {
        await deleteMessage(messageId);
      } catch (e) {
        showAlert('Error', e.message);
      }
    },
    [deleteMessage],
  );
  const handleEdit = useCallback(
    (messageId) => {
      const msg = messages.find((m) => m.id === messageId);
      if (!msg) return;
      setEditingMessage({
        id: messageId,
        content: msg.content || '',
      });
    },
    [messages],
  );
  const handleSaveEdit = useCallback(async () => {
    if (!editingMessage) return;
    const { id, content } = editingMessage;
    if (!content.trim()) return;
    try {
      await updateMessage(id, content.trim());
      setEditingMessage(null);
    } catch (e) {
      showAlert('Error', e.message);
    }
  }, [editingMessage, updateMessage]);
  const handleMediaPress = useCallback((mediaUrl) => {
    setPreviewMedia(mediaUrl);
  }, []);
  const handleScroll = useCallback((event) => {
    const { contentOffset, layoutMeasurement, contentSize } = event.nativeEvent;
    const offsetY = contentOffset.y;
    setShowScrollButton(offsetY > 200);
    isNearBottomRef.current = layoutMeasurement.height + offsetY >= contentSize.height - 120;
  }, []);
  const scrollToBottom = useCallback(() => {
    if (flatListItems.length === 0) return;
    flatListRef.current?.scrollToIndex({
      index: flatListItems.length - 1,
      animated: true,
    });
    setShowScrollButton(false);
  }, [flatListItems.length]);
  const handleToggleReaction = useCallback(
    async (messageId, emoji) => {
      await toggleReaction(messageId, emoji);
    },
    [toggleReaction],
  );
  const handleReply = useCallback(
    (message) => {
      setReplyTo({
        messageId: message.id,
        content: message.content,
        senderName: message.sender.displayName,
      });
    },
    [setReplyTo],
  );
  const closeMessageActions = useCallback(() => {
    setSelectedMessage(null);
    setSelectedAnchor(null);
  }, []);
  const handlePressReply = useCallback(
    (messageId) => {
      const index = flatListItems.findIndex(
        (item) => item.type === 'message' && item.message.id === messageId,
      );
      if (index >= 0) {
        flatListRef.current?.scrollToIndex({
          index,
          animated: true,
        });
      }
    },
    [flatListItems],
  );
  const activeTypers = useMemo(
    () => (typingUsers || []).filter((t) => t.userId !== currentUserId),
    [typingUsers, currentUserId],
  );
  const renderItem = useCallback(
    ({ item }) => {
      if (item.type === 'date') {
        return (
          <View style={styles.dateDivider}>
            <View style={styles.dateLine} />
            <Text style={styles.dateText}>{item.date.toUpperCase()}</Text>
            <View style={styles.dateLine} />
          </View>
        );
      }
      const msg = item.message;
      return (
        <MessageBubble
          key={msg.id}
          message={msg}
          isOwn={msg.senderId === currentUserId}
          isSelected={selectedMessage?.id === msg.id}
          onToggleReaction={handleToggleReaction}
          onPressReply={handlePressReply}
          onSelectMessage={(selectedMsg, anchor) => {
            setSelectedMessage((prev) => (prev?.id === selectedMsg.id ? null : selectedMsg));
            setSelectedAnchor(anchor ?? null);
          }}
          onMediaPress={handleMediaPress}
          showAvatar={convType === 'group' || convType === 'household'}
        />
      );
    },
    [currentUserId, selectedMessage, handleToggleReaction, handlePressReply, handleMediaPress, convType],
  );
  const handleStartReached = useCallback(() => {
    // Older messages load at the top of the list (non-inverted)
    if (hasMore && !loading) {
      fetchMoreMessages(conversationId);
    }
  }, [hasMore, loading, fetchMoreMessages, conversationId]);
  const keyExtractor = useCallback((item) => {
    if (item.type === 'date') return item.id;
    return item.message.id;
  }, []);
  if (loading && messages.length === 0) {
    return (
      <View
        style={[
          styles.center,
          {
            paddingTop: insets.top,
          },
        ]}
      >
        <ActivityIndicator size="large" color={colors.gold} />
      </View>
    );
  }
  if (error && messages.length === 0) {
    return (
      <View
        style={[
          styles.center,
          {
            paddingTop: insets.top,
          },
        ]}
      >
        <Text style={styles.errorText}>{error}</Text>
      </View>
    );
  }
  const ListEmptyComponent = (
    <View style={styles.emptyContainer}>
      <Text style={styles.emptyTitle}>No messages yet</Text>
      <Text style={styles.emptySubtitle}>Send the first message to start the conversation</Text>
    </View>
  );
  const ListHeaderComponent = (
    <View
      style={{
        height: 8,
      }}
    >
      {hasMore && (
        <ActivityIndicator
          size="small"
          color={colors.gold}
          style={{
            marginVertical: 8,
          }}
        />
      )}
    </View>
  );
  const ListFooterComponent = (
    <>
      <TypingIndicator typers={activeTypers} />
      <View
        style={{
          height: 4,
        }}
      />
    </>
  );

  // Anchor the long-press dropdown to the selected message, flipping above it
  // when there isn't enough room below.
  const DROPDOWN_WIDTH = 210;
  const DROPDOWN_EST_HEIGHT = 230;
  let dropdownLeft = 16;
  let dropdownTop = 16;
  if (selectedMessage && selectedAnchor) {
    dropdownLeft = Math.max(8, Math.min(selectedAnchor.x, SCREEN_WIDTH - DROPDOWN_WIDTH - 16));
    const below = selectedAnchor.y + selectedAnchor.height + 8;
    dropdownTop =
      below + DROPDOWN_EST_HEIGHT > SCREEN_HEIGHT - 24
        ? Math.max(8, selectedAnchor.y - DROPDOWN_EST_HEIGHT - 8)
        : below;
  }
  return (
    <View style={styles.container}>
      {/* Header — always visible; long-press actions now live in the dropdown modal */}
      <View style={[styles.header, { paddingTop: insets.top }]}>
        <TouchableOpacity
          style={styles.headerBackBtn}
          activeOpacity={0.7}
          onPress={() => navigation.goBack()}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <SvgXml xml={BACK_SVG} width={20} height={20} />
        </TouchableOpacity>

        {(convType === 'group' || convType === 'household') && headerAvatarMembers.length > 0 && (
          <View style={styles.headerAvatarCluster}>
            {headerAvatarMembers.map((p, i) => (
              <View
                key={p.id}
                style={[
                  styles.headerAvatarSlot,
                  i === 0 ? styles.headerAvatarSlotBack : styles.headerAvatarSlotFront,
                ]}
              >
                <Avatar
                  url={p.avatarUrl}
                  emoji={p.avatarEmoji}
                  name={p.displayName}
                  id={p.id}
                  size={25}
                />
              </View>
            ))}
          </View>
        )}

        <TouchableOpacity
          style={styles.headerTitleContainer}
          activeOpacity={0.7}
          onPress={() => {
            if (convType === 'group' || convType === 'household') {
              nav.navigate('GroupMembers', {
                conversationId,
                title,
                type: convType,
              });
            }
          }}
          disabled={convType !== 'group' && convType !== 'household'}
        >
          <Text style={styles.headerTitle} numberOfLines={1}>
            {title || 'Mendez House'}
          </Text>
          <Text style={styles.headerSubtitle} numberOfLines={1}>
            {subtitleText}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.headerMenuBtn}
          onPress={() => setMenuVisible((prev) => !prev)}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Conversation options"
        >
          <Ionicons name="ellipsis-vertical" size={16} color={chatTheme.chipIcon} />
        </TouchableOpacity>
      </View>

      {/* Dropdown Menu Overlay */}
      {menuVisible && (
        <TouchableOpacity
          style={styles.dropdownOverlay}
          activeOpacity={1}
          onPress={() => setMenuVisible(false)}
        >
          <View
            style={[
              styles.dropdownMenu,
              {
                top: insets.top + 46,
              },
            ]}
          >
            <TouchableOpacity
              style={styles.dropdownItem}
              onPress={() => {
                setMenuVisible(false);
                handleDeleteConversation();
              }}
            >
              <Text style={styles.dropdownItemTextDestructive}>Delete Conversation</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      )}

      <View style={[styles.keyboardView, { paddingBottom: keyboardHeight }]}>
        {/* Messages list — oldest at top, newest at bottom */}
        <FlatList
          ref={flatListRef}
          data={flatListItems}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          ListHeaderComponent={ListHeaderComponent}
          ListFooterComponent={ListFooterComponent}
          ListEmptyComponent={ListEmptyComponent}
          onStartReached={handleStartReached}
          onStartReachedThreshold={0.3}
          refreshing={refreshing}
          onRefresh={() => refreshMessages(conversationId)}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          onScroll={handleScroll}
          scrollEventThrottle={16}
          keyboardShouldPersistTaps="handled"
        />

        {/* ---- Fix 4: Scroll-to-bottom FAB ---- */}
        {showScrollButton && (
          <TouchableOpacity
            style={styles.scrollToBottom}
            onPress={scrollToBottom}
            activeOpacity={0.7}
          >
            <Text style={styles.scrollToBottomText}>{'↓'}</Text>
          </TouchableOpacity>
        )}

        {/* ---- Fix 2: Edit Message Modal ---- */}
        <Modal
          visible={editingMessage !== null}
          transparent
          animationType="fade"
          onRequestClose={() => setEditingMessage(null)}
          statusBarTranslucent
          navigationBarTranslucent
        >
          <View style={styles.modalOverlay}>
            <View style={styles.editModal}>
              <Text style={styles.editModalTitle}>Edit Message</Text>
              <TextInput
                style={styles.editInput}
                value={editingMessage?.content ?? ''}
                onChangeText={(text) =>
                  setEditingMessage((prev) =>
                    prev
                      ? {
                          ...prev,
                          content: text,
                        }
                      : null,
                  )
                }
                multiline
                autoFocus
                placeholder="Edit your message..."
                placeholderTextColor={colors.textMuted}
              />
              <View style={styles.editModalButtons}>
                <TouchableOpacity
                  onPress={() => setEditingMessage(null)}
                  style={styles.editCancelBtn}
                >
                  <Text style={styles.editCancelText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={handleSaveEdit} style={styles.editSaveBtn}>
                  <GoldFill radius={radius.sm} />
                  <Text style={styles.editSaveText}>Save</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>

        {/* ---- Fix 3: Image Preview / Lightbox Modal ---- */}
        <Modal
          visible={previewMedia !== null}
          transparent
          animationType="fade"
          onRequestClose={() => setPreviewMedia(null)}
        >
          <View style={styles.previewOverlay}>
            <TouchableOpacity
              style={styles.previewClose}
              onPress={() => setPreviewMedia(null)}
              activeOpacity={0.7}
            >
              <Text style={styles.previewCloseText}>X</Text>
            </TouchableOpacity>
            {previewMedia && (
              <Image
                source={{
                  uri: previewMedia,
                }}
                style={styles.previewImage}
                resizeMode="contain"
              />
            )}
          </View>
        </Modal>

        {/* ---- SCREEN 31: Long-press message actions dropdown ---- */}
        <Modal
          visible={selectedMessage !== null && selectedAnchor !== null}
          transparent
          animationType="fade"
          onRequestClose={closeMessageActions}
        >
          <View style={styles.actionOverlay}>
            <TouchableOpacity
              style={styles.actionBackdrop}
              activeOpacity={1}
              onPress={closeMessageActions}
            />
            <View
              style={[
                styles.actionDropdown,
                {
                  left: dropdownLeft,
                  top: dropdownTop,
                },
              ]}
            >
              {/* Quick reactions */}
              <View style={styles.reactBar}>
                {MESSAGE_EMOJIS.map((emoji) => (
                  <TouchableOpacity
                    key={emoji}
                    style={styles.reactEmojiBtn}
                    onPress={() => {
                      const msg = selectedMessage;
                      if (msg) handleToggleReaction(msg.id, emoji);
                      closeMessageActions();
                    }}
                  >
                    <Text style={styles.reactEmojiText}>{emoji}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              {/* Action menu */}
              <View style={styles.menuBox}>
                <TouchableOpacity
                  style={styles.menuItem}
                  onPress={() => {
                    const msg = selectedMessage;
                    closeMessageActions();
                    if (msg) handleReply(msg);
                  }}
                >
                  <Text style={styles.menuItemText}>Reply</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.menuItem}
                  onPress={async () => {
                    const msg = selectedMessage;
                    closeMessageActions();
                    if (msg?.content) await Clipboard.setStringAsync(msg.content);
                  }}
                >
                  <Text style={styles.menuItemText}>Copy</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.menuItem}
                  onPress={() => {
                    const msg = selectedMessage;
                    closeMessageActions();
                    if (msg) handleEdit(msg.id);
                  }}
                >
                  <Text style={styles.menuItemText}>Edit</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.menuItem, styles.menuItemLast]}
                  onPress={() => {
                    const msg = selectedMessage;
                    closeMessageActions();
                    if (msg) handleDelete(msg.id);
                  }}
                >
                  <Text style={[styles.menuItemText, styles.menuItemDelete]}>Delete</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>

        {/* Input bar */}
        <ChatInputBar
          onSend={handleSend}
          onSendVoice={handleSendVoice}
          onSendImage={handleSendImage}
          replyTo={replyTo}
          onDismissReply={() => setReplyTo(null)}
          chatTitle={title}
          participantCount={partCount}
        />
      </View>
    </View>
  );
}
const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: chatTheme.bg,
  },
  keyboardView: {
    flex: 1,
  },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: chatTheme.bg,
  },
  // ---- SCREEN 31: Long-press message actions dropdown ----
  actionOverlay: {
    flex: 1,
  },
  actionBackdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  actionDropdown: {
    position: 'absolute',
  },
  reactBar: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderRadius: 24,
    paddingHorizontal: 14,
    paddingVertical: 8,
    gap: 14,
    marginBottom: 10,
    shadowColor: colors.shadow,
    shadowOffset: {
      width: 0,
      height: 2,
    },
    shadowOpacity: 0.15,
    shadowRadius: 6,
    elevation: 5,
  },
  reactEmojiBtn: {
    padding: 4,
  },
  reactEmojiText: {
    fontSize: 22,
  },
  menuBox: {
    width: 210,
    backgroundColor: colors.surface,
    borderRadius: radius.cardLg,
    overflow: 'hidden',
    shadowColor: colors.shadow,
    shadowOffset: {
      width: 0,
      height: 6,
    },
    shadowOpacity: 0.2,
    shadowRadius: 12,
    elevation: 10,
  },
  menuItem: {
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  menuItemLast: {
    borderBottomWidth: 0,
  },
  menuItemText: {
    fontSize: 16,
    fontFamily: fonts.bodyMedium,
    color: colors.ink,
  },
  menuItemDelete: {
    color: colors.danger,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingBottom: 14,
    backgroundColor: chatTheme.bg,
    borderBottomWidth: 1,
    borderBottomColor: chatTheme.chipBorder,
  },
  headerBackBtn: {
    width: 36,
    height: 36,
    flexShrink: 0,
    borderRadius: radius.md,
    backgroundColor: chatTheme.chip,
    borderWidth: 1,
    borderColor: chatTheme.chipBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerAvatarCluster: {
    width: 38,
    height: 38,
    flexShrink: 0,
  },
  headerAvatarSlot: {
    position: 'absolute',
    borderRadius: 15,
    borderWidth: 2,
    borderColor: chatTheme.bg,
  },
  headerAvatarSlotBack: {
    top: 0,
    right: 0,
  },
  headerAvatarSlotFront: {
    bottom: 0,
    left: 0,
  },
  headerMenuBtn: {
    width: 36,
    height: 36,
    flexShrink: 0,
    borderRadius: radius.md,
    backgroundColor: chatTheme.chip,
    borderWidth: 1,
    borderColor: chatTheme.chipBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dropdownOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 999,
  },
  dropdownMenu: {
    position: 'absolute',
    right: 16,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    paddingVertical: 6,
    paddingHorizontal: 4,
    shadowColor: colors.shadow,
    shadowOffset: {
      width: 0,
      height: 4,
    },
    shadowOpacity: 0.15,
    shadowRadius: 10,
    elevation: 8,
    borderWidth: 1,
    borderColor: colors.border,
    minWidth: 170,
  },
  dropdownItem: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: radius.sm,
  },
  dropdownItemTextDestructive: {
    fontSize: 14,
    fontFamily: fonts.bodySemiBold,
    color: colors.danger,
  },
  headerTitleContainer: {
    flex: 1,
    minWidth: 0,
    alignItems: 'flex-start',
  },
  headerTitle: {
    fontSize: 16,
    fontFamily: fonts.displayBold,
    color: chatTheme.headerTitle,
    letterSpacing: -0.1,
  },
  headerSubtitle: {
    fontSize: 11.5,
    fontFamily: fonts.bodySemiBold,
    color: chatTheme.headerSub,
    marginTop: 2,
  },
  memberStrip: {
    maxHeight: 80,
    paddingVertical: 10,
    backgroundColor: colors.canvas,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  listContent: {
    paddingBottom: 8,
  },
  dateDivider: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginVertical: 12,
    paddingHorizontal: 4,
  },
  dateLine: {
    flex: 1,
    height: 1,
    backgroundColor: chatTheme.dividerLine,
  },
  dateText: {
    fontSize: 10.5,
    fontFamily: fonts.bodyBold,
    letterSpacing: 1.4,
    color: chatTheme.dividerLabel,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 60,
  },
  emptyTitle: {
    fontSize: 16,
    fontFamily: fonts.bodySemiBold,
    color: colors.textSecondary,
  },
  emptySubtitle: {
    fontSize: 13,
    fontFamily: fonts.body,
    color: colors.textMuted,
    marginTop: 4,
    textAlign: 'center',
    paddingHorizontal: 40,
  },
  errorText: {
    color: colors.danger,
    fontSize: 14,
    fontFamily: fonts.body,
  },
  // ---- Fix 4: Scroll-to-bottom FAB styles ----
  scrollToBottom: {
    position: 'absolute',
    bottom: 100,
    right: 20,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.gold,
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 4,
    shadowColor: colors.shadow,
    shadowOffset: {
      width: 0,
      height: 2,
    },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    zIndex: 100,
  },
  scrollToBottomText: {
    fontSize: 20,
    color: colors.onAccent,
    fontWeight: '700',
  },
  // ---- Fix 2: Edit Modal styles ----
  modalOverlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: withAlpha(colors.shadow, 0.5),
  },
  editModal: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: 20,
    width: '85%',
    maxHeight: '70%',
  },
  editModalTitle: {
    fontSize: 18,
    fontFamily: fonts.displayBold,
    color: colors.ink,
    marginBottom: 12,
  },
  editInput: {
    borderWidth: 1,
    borderColor: colors.borderCool,
    borderRadius: radius.sm,
    padding: 12,
    fontSize: 15,
    fontFamily: fonts.body,
    color: colors.ink,
    minHeight: 80,
    maxHeight: 200,
    textAlignVertical: 'top',
  },
  editModalButtons: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: 16,
    gap: 12,
  },
  editCancelBtn: {
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  editCancelText: {
    fontSize: 15,
    fontFamily: fonts.body,
    color: colors.textSecondary,
  },
  editSaveBtn: {
    backgroundColor: colors.gold,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: radius.sm,
    ...goldButton.glow,
  },
  editSaveText: {
    fontSize: 15,
    color: goldButton.onGold,
    fontFamily: fonts.bodySemiBold,
  },
  // ---- Fix 3: Image Preview/Lightbox styles ----
  previewOverlay: {
    flex: 1,
    backgroundColor: withAlpha(colors.shadow, 0.9),
    justifyContent: 'center',
    alignItems: 'center',
  },
  previewClose: {
    position: 'absolute',
    top: 50,
    right: 20,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: withAlpha(colors.white, 0.2),
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 10,
  },
  previewCloseText: {
    fontSize: 18,
    color: colors.onAccent,
    fontWeight: '700',
  },
  previewImage: {
    width: SCREEN_WIDTH,
    height: SCREEN_HEIGHT,
  },
});
