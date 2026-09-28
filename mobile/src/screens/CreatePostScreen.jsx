import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  Image,
  Animated,
  Easing,
  BackHandler,
  Dimensions,
  Pressable,
  ActivityIndicator,
  Modal,
  FlatList,
  ScrollView,
  KeyboardAvoidingView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SvgXml } from 'react-native-svg';
import { Ionicons } from '@expo/vector-icons';
import { Video, ResizeMode } from 'expo-av';
import { feedApi } from '../shared/api/feed';
import { householdApi } from '../shared/api/household';
import apiClient from '../shared/api/client';
import * as ImagePicker from 'expo-image-picker';
import { ensureCamera } from '../shared/permissions';
import { useFeedStore } from '../shared/store/feedStore';
import { useAuthStore } from '../shared/store/authStore';
import { colors, fonts, goldButton, radius, withAlpha } from '../shared/theme';
import { GoldFill } from '../shared/components/GoldButton';
import { KEYBOARD_BEHAVIOR } from '../shared/components/KeyboardAware';
const MAX_CHARS = 10000;
const MAX_MEDIA = 10;
const ATTACH_SVG =
  '<svg width="22" height="22" viewBox="0 0 24 24" fill="none">' +
  `<rect x="3" y="5" width="18" height="14" rx="2" stroke="${colors.textSecondary}" stroke-width="1.5"></rect>` +
  `<circle cx="8.5" cy="10" r="1.5" stroke="${colors.textSecondary}" stroke-width="1.5"></circle>` +
  `<path d="M21 16l-5-5-9 9" stroke="${colors.textSecondary}" stroke-width="1.5"></path>` +
  '</svg>';
const CLOSE_SVG =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none">' +
  `<path d="M6 6l12 12M18 6L6 18" stroke="${colors.ink}" stroke-width="2.2" stroke-linecap="round"></path>` +
  '</svg>';
const MOODS = [
  {
    label: 'Grateful',
    emoji: '🙏',
    icon: 'heart-outline',
  },
  {
    label: 'Excited',
    emoji: '🎉',
    icon: 'sparkles-outline',
  },
  {
    label: 'Happy',
    emoji: '😊',
    icon: 'happy-outline',
  },
  {
    label: 'Tired',
    emoji: '😴',
    icon: 'moon-outline',
  },
  {
    label: 'Loved',
    emoji: '🥰',
    icon: 'heart-circle-outline',
  },
  {
    label: 'Proud',
    emoji: '💪',
    icon: 'trophy-outline',
  },
  {
    label: 'Blessed',
    emoji: '✨',
    icon: 'star-outline',
  },
  {
    label: 'Motivated',
    emoji: '🔥',
    icon: 'flame-outline',
  },
];
const ACTIVITIES = [
  {
    label: 'Cooking',
    emoji: '🍳',
    icon: 'restaurant-outline',
  },
  {
    label: 'Eating',
    emoji: '🍽️',
    icon: 'fast-food-outline',
  },
  {
    label: 'Watching',
    emoji: '📺',
    icon: 'tv-outline',
  },
  {
    label: 'Reading',
    emoji: '📖',
    icon: 'book-outline',
  },
  {
    label: 'Playing',
    emoji: '🎮',
    icon: 'game-controller-outline',
  },
  {
    label: 'Listening',
    emoji: '🎵',
    icon: 'musical-notes-outline',
  },
  {
    label: 'Working',
    emoji: '💼',
    icon: 'briefcase-outline',
  },
  {
    label: 'Studying',
    emoji: '📚',
    icon: 'school-outline',
  },
  {
    label: 'Exercising',
    emoji: '🏋️',
    icon: 'barbell-outline',
  },
  {
    label: 'Cleaning',
    emoji: '🧹',
    icon: 'sparkles-outline',
  },
  {
    label: 'Gardening',
    emoji: '🌱',
    icon: 'leaf-outline',
  },
  {
    label: 'Sleeping',
    emoji: '😴',
    icon: 'moon-outline',
  },
  {
    label: 'Relaxing',
    emoji: '🧘',
    icon: 'cafe-outline',
  },
  {
    label: 'Shopping',
    emoji: '🛒',
    icon: 'cart-outline',
  },
  {
    label: 'Traveling',
    emoji: '🚗',
    icon: 'car-outline',
  },
];
const getServerBase = () => {
  const base = apiClient.defaults.baseURL || '';
  return base.replace(/\/api\/v1\/?$/, '');
};
export default function CreatePostScreen({ navigation, route }) {
  const insets = useSafeAreaInsets();
  const { height: HEIGHT } = Dimensions.get('window');
  const user = useAuthStore((s) => s.user);
  const prependPost = useFeedStore((s) => s.prependPost);
  const [content, setContent] = useState(route.params?.initialText ?? '');
  const [media, setMedia] = useState([]);
  const [mood, setMood] = useState(null);
  const [showMoods, setShowMoods] = useState(false);
  const [posting, setPosting] = useState(false);
  const [activity, setActivity] = useState(null);
  const [showActivity, setShowActivity] = useState(false);
  const [taggedMemberIds, setTaggedMemberIds] = useState([]);
  const [showTagPicker, setShowTagPicker] = useState(false);
  const [householdMembers, setHouseholdMembers] = useState([]);
  const [slideAnim] = useState(new Animated.Value(HEIGHT)); // start off screen (below the bottom)

  // Load household members for tagging
  useEffect(() => {
    householdApi
      .listMyHouseholds()
      .then((hhList) => {
        if (hhList.length > 0) {
          householdApi
            .getMembers(hhList[0].id)
            .then(setHouseholdMembers)
            .catch(() => {});
        }
      })
      .catch(() => {});
  }, []);

  // Track keyboard to keep sheet above it (window resize handles Android; iOS uses KeyboardAvoidingView)

  const uploading = media.some((m) => m.uploading);
  const readyMedia = media.filter((m) => m.uploaded && !m.error);
  const canPost =
    (content.trim().length > 0 || readyMedia.length > 0) &&
    !posting &&
    !uploading &&
    media.every((m) => !m.uploading);
  const remaining = MAX_CHARS - content.length;
  const displayName = user?.name || 'You';
  const initials = displayName
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
  const avatarSrc = user?.avatarUrl
    ? {
        uri: user.avatarUrl.startsWith('http')
          ? user.avatarUrl
          : `${getServerBase()}${user.avatarUrl}`,
      }
    : null;
  const uploadAssets = useCallback(
    async (assets) => {
      const room = MAX_MEDIA - media.length;
      const batch = assets.slice(0, Math.max(0, room));
      if (!batch.length) {
        alert('Limit reached: You can attach up to ' + MAX_MEDIA + ' photos or videos.');
        return;
      }
      const drafts = batch.map((asset, i) => ({
        id: `${Date.now()}-${i}-${Math.random().toString(36).slice(2, 7)}`,
        localUri: asset.uri,
        kind: asset.type === 'video' ? 'video' : 'photo',
        uploading: true,
      }));
      setMedia((prev) => [...prev, ...drafts]);
      try {
        const formData = new FormData();
        for (const asset of batch) {
          const uri = asset.uri;
          const fileName = asset.fileName || uri.split('/').pop() || `media-${Date.now()}.jpg`;
          const mimeType = asset.mimeType || (asset.type === 'video' ? 'video/mp4' : 'image/jpeg');
          formData.append('files', {
            uri,
            name: fileName,
            type: mimeType,
          });
        }
        const uploaded = await feedApi.uploadMedia(formData);
        const byId = new Map(drafts.map((d, i) => [d.id, uploaded[i]]));
        setMedia((prev) =>
          prev.map((m) => {
            if (!byId.has(m.id)) return m;
            const result = byId.get(m.id);
            return result
              ? {
                  ...m,
                  uploading: false,
                  uploaded: result,
                }
              : {
                  ...m,
                  uploading: false,
                  error: 'Upload failed',
                };
          }),
        );
      } catch (e) {
        setMedia((prev) =>
          prev.map((m) =>
            drafts.some((d) => d.id === m.id)
              ? {
                  ...m,
                  uploading: false,
                  error: e?.message || 'Upload failed',
                }
              : m,
          ),
        );
        alert('Upload failed: ' + (e?.message || 'Could not upload media'));
      }
    },
    [media.length],
  );
  const pickFromLibrary = useCallback(async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images', 'videos'],
      allowsMultipleSelection: true,
      quality: 0.85,
      selectionLimit: MAX_MEDIA,
      videoMaxDuration: 120,
    });
    if (result.canceled || !result.assets.length) return;
    await uploadAssets(result.assets);
  }, [uploadAssets]);
  const takePhoto = useCallback(async () => {
    if (!(await ensureCamera())) return;
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ['images'],
      quality: 0.85,
      allowsEditing: false,
    });
    if (result.canceled || !result.assets.length) return;
    await uploadAssets(result.assets);
  }, [uploadAssets]);
  const removeMedia = useCallback((id) => {
    setMedia((prev) => prev.filter((m) => m.id !== id));
  }, []);
  const handlePost = useCallback(async () => {
    if (!canPost) return;
    setPosting(true);
    try {
      const text = content.trim();
      const fullContent = mood ? (text ? `${text}\n\nFeeling: ${mood}` : `Feeling: ${mood}`) : text;
      const body = {
        content: fullContent,
        activity: activity || undefined,
        taggedUserIds: taggedMemberIds.length > 0 ? taggedMemberIds : undefined,
      };
      if (readyMedia.length > 0) {
        body.media = readyMedia.map((m) => ({
          // `fileName`/`thumbnailFileName` are S3 keys — must be sent, not
          // `url`/`thumbnailUrl` (signed preview URLs that expire and would
          // go stale if persisted).
          mediaUrl: m.uploaded.fileName,
          mediaType: m.kind,
          thumbnailUrl: m.uploaded.thumbnailFileName || undefined,
          fileSizeBytes: m.uploaded.size,
        }));
        body.mediaType = readyMedia[0].kind;
      }
      const newPost = await feedApi.create(body);
      prependPost(newPost);
      onClose();
    } catch (e) {
      alert('Error: ' + (e?.message || 'Failed to create post'));
    } finally {
      setPosting(false);
    }
  }, [canPost, content, mood, activity, taggedMemberIds, readyMedia, navigation, prependPost]);
  const openModal = useCallback(() => {
    Animated.timing(slideAnim, {
      toValue: 120,
      // sheet top at 120px from screen top, exactly like the mock
      duration: 400,
      easing: Easing.bezier(0.25, 0.8, 0.25, 1),
      useNativeDriver: false,
    }).start();
  }, [slideAnim]);
  const onClose = useCallback(() => {
    Animated.timing(slideAnim, {
      toValue: HEIGHT,
      duration: 300,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start(() => {
      navigation.goBack();
    });
  }, [slideAnim, navigation, HEIGHT]);
  useEffect(() => {
    openModal();
    const backHandler = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => backHandler.remove();
  }, [openModal, onClose]);
  const mediaUri = (item) => {
    const url = item.uploaded?.url;
    if (url && (url.startsWith('http://') || url.startsWith('https://'))) return url;
    return item.localUri;
  };
  const scaleAnim = useRef(new Animated.Value(1)).current;
  const onPressIn = () => {
    Animated.spring(scaleAnim, {
      toValue: 0.96,
      useNativeDriver: true,
    }).start();
  };
  const onPressOut = () => {
    Animated.spring(scaleAnim, {
      toValue: 1,
      friction: 3,
      tension: 40,
      useNativeDriver: true,
    }).start();
  };
  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={KEYBOARD_BEHAVIOR}
      keyboardVerticalOffset={0}
    >
      <Animated.View
        style={[
          styles.sheet,
          {
            top: slideAnim,
            paddingHorizontal: 24,
            paddingTop: 14,
          },
        ]}
      >
        {/* Handle bar */}
        <View style={styles.handleBar} />

        {/* Header - centered title, absolute close */}
        <View style={styles.header}>
          <Text style={[styles.title, styles.titleCentered]}>New post</Text>
          <TouchableOpacity
            style={styles.closeButton}
            onPress={onClose}
            hitSlop={{
              top: 8,
              bottom: 8,
              left: 8,
              right: 8,
            }}
            activeOpacity={0.7}
          >
            <View style={styles.closeCircle}>
              <SvgXml xml={CLOSE_SVG} width={16} height={16} />
            </View>
          </TouchableOpacity>
        </View>

        {/* User info */}
        <View style={styles.userInfo}>
          <View style={styles.avatar}>
            {avatarSrc ? (
              <Image source={avatarSrc} style={styles.avatarImage} />
            ) : (
              <View style={[styles.avatar, styles.avatarCircle]}>
                <Text style={styles.avatarInitials}>{initials}</Text>
              </View>
            )}
          </View>
          <Text style={styles.userInfoName}>{displayName}</Text>

          {mood ? (
            <TouchableOpacity
              style={styles.moodPill}
              onPress={() => setShowMoods(true)}
              activeOpacity={0.8}
            >
              <Text style={styles.moodPillText} numberOfLines={1}>
                {mood}
              </Text>
              <Pressable onPress={() => setMood(null)} hitSlop={8} style={styles.moodClear}>
                <Text style={styles.moodClearText}>×</Text>
              </Pressable>
            </TouchableOpacity>
          ) : null}
        </View>

        {/* Input */}
        <ScrollView
          style={styles.inputScroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <TextInput
            style={styles.input}
            placeholder="What's going on?"
            placeholderTextColor={colors.textMuted}
            value={content}
            onChangeText={setContent}
            multiline
            maxLength={MAX_CHARS}
          />

          {activity ? (
            <View style={styles.activityPill}>
              <Text style={styles.activityPillText} numberOfLines={1}>
                {activity}
              </Text>
            </View>
          ) : null}

          {/* Media preview */}
          {media.length > 0 && (
            <View style={styles.mediaStrip}>
              {media.map((item) => (
                <View key={item.id} style={styles.mediaItem}>
                  {item.kind === 'video' ? (
                    <Video
                      source={{
                        uri: mediaUri(item),
                      }}
                      style={styles.mediaThumb}
                      resizeMode={ResizeMode.COVER}
                      shouldPlay={false}
                      isMuted
                      useNativeControls={false}
                    />
                  ) : (
                    <Image
                      source={{
                        uri: mediaUri(item),
                      }}
                      style={styles.mediaThumb}
                      resizeMode="cover"
                    />
                  )}
                  {item.kind === 'video' && (
                    <View style={styles.playBadge} pointerEvents="none">
                      <View style={styles.playCircle}>
                        <Text style={styles.playBadgeText}>▶</Text>
                      </View>
                    </View>
                  )}
                  {item.uploading && (
                    <View style={styles.mediaOverlay}>
                      <ActivityIndicator size="small" color={colors.onAccent} />
                      <Text style={styles.uploadLabel}>Uploading</Text>
                    </View>
                  )}
                  {item.error && !item.uploading && (
                    <View style={styles.mediaOverlay}>
                      <Text style={styles.errorLabel}>Failed</Text>
                      <TouchableOpacity onPress={() => removeMedia(item.id)}>
                        <Text style={styles.retryLabel}>Remove</Text>
                      </TouchableOpacity>
                    </View>
                  )}
                  <TouchableOpacity
                    style={styles.mediaRemove}
                    onPress={() => removeMedia(item.id)}
                    hitSlop={6}
                  >
                    <Text style={styles.mediaRemoveText}>×</Text>
                  </TouchableOpacity>
                </View>
              ))}

              {media.length < MAX_MEDIA && (
                <TouchableOpacity
                  style={[styles.addMore, styles.mediaItem]}
                  onPress={pickFromLibrary}
                  activeOpacity={0.75}
                >
                  <Text style={styles.addMorePlus}>+</Text>
                  <Text style={styles.addMoreLabel}>Add</Text>
                </TouchableOpacity>
              )}
            </View>
          )}
        </ScrollView>

        {/* Composer toolbar */}
        <View style={styles.toolbar}>
          <View style={styles.tools}>
            <TouchableOpacity
              style={styles.tool}
              onPress={pickFromLibrary}
              disabled={uploading || posting}
              activeOpacity={0.7}
            >
              <SvgXml xml={ATTACH_SVG} width={20} height={20} />
              <Text style={styles.toolText}>Gallery</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.tool}
              onPress={takePhoto}
              disabled={uploading || posting}
              activeOpacity={0.7}
            >
              <Ionicons name="camera-outline" size={18} color={withAlpha(colors.legacyNavy, 0.55)} />
              <Text style={styles.toolText}>Camera</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.tool, showMoods && styles.toolActive]}
              onPress={() => setShowMoods((v) => !v)}
              activeOpacity={0.7}
            >
              <Ionicons
                name="happy-outline"
                size={18}
                color={showMoods ? colors.legacyGoldDark : withAlpha(colors.legacyNavy, 0.55)}
              />
              <Text style={[styles.toolText, showMoods && styles.toolTextActive]}>Feeling</Text>
              {mood ? <View style={styles.toolBadge} /> : null}
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.tool, showActivity && styles.toolActive]}
              onPress={() => setShowActivity((v) => !v)}
              activeOpacity={0.7}
            >
              <Ionicons
                name="flash-outline"
                size={18}
                color={showActivity ? colors.legacyGoldDark : withAlpha(colors.legacyNavy, 0.55)}
              />
              <Text style={[styles.toolText, showActivity && styles.toolTextActive]}>Activity</Text>
              {activity ? <View style={styles.toolBadge} /> : null}
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.tool, showTagPicker && styles.toolActive]}
              onPress={() => setShowTagPicker((v) => !v)}
              activeOpacity={0.7}
            >
              <Text style={styles.glyph}>@</Text>
              <Text style={[styles.toolText, showTagPicker && styles.toolTextActive]}>Tag</Text>
              {taggedMemberIds.length > 0 ? (
                <View style={styles.toolBadgeCount}>
                  <Text style={styles.toolBadgeCountText}>{taggedMemberIds.length}</Text>
                </View>
              ) : null}
            </TouchableOpacity>
          </View>

          {/* Post button */}
          <Pressable
            onPress={canPost ? handlePost : undefined}
            onPressIn={onPressIn}
            onPressOut={onPressOut}
            style={({ pressed }) => [
              styles.postButton,
              !canPost && styles.postButtonDisabled,
              pressed && styles.postButtonPressed,
            ]}
          >
            <GoldFill radius={9999} />
            <Animated.View
              style={{
                transform: [
                  {
                    scale: scaleAnim,
                  },
                ],
              }}
            >
              {posting ? (
                <ActivityIndicator size="small" color={colors.shadow} />
              ) : (
                <Text style={styles.postButtonText}>Post</Text>
              )}
            </Animated.View>
          </Pressable>
        </View>

        {remaining < 800 && (
          <Text style={[styles.chars, remaining < 120 && styles.charsWarn]}>{remaining}</Text>
        )}

        <View
          style={{
            height: 44 + insets.bottom,
          }}
        />

        {/* Mood sheet — absolute overlay above toolbar, never pushes layout */}
        {showMoods && (
          <View
            style={[
              styles.pickerSheet,
              {
                bottom: 120 + insets.bottom,
              },
            ]}
          >
            <View style={styles.pickerSheetHead}>
              <Text style={styles.pickerSheetTitle}>How are you feeling?</Text>
              <Pressable onPress={() => setShowMoods(false)} hitSlop={10}>
                <Text style={styles.pickerSheetClose}>Done</Text>
              </Pressable>
            </View>
            <View style={styles.pickerGrid}>
              {MOODS.map((m) => {
                const value = `${m.label} ${m.emoji}`;
                const selected = mood === value;
                return (
                  <TouchableOpacity
                    key={value}
                    style={[styles.pickerCell, selected && styles.pickerCellOn]}
                    onPress={() => {
                      setMood(selected ? null : value);
                      setShowMoods(false);
                    }}
                    activeOpacity={0.7}
                  >
                    <View style={[styles.pickerIconChip, selected && styles.pickerIconChipOn]}>
                      <Ionicons
                        name={m.icon}
                        size={18}
                        color={selected ? colors.legacyGoldDark : withAlpha(colors.legacyNavy, 0.6)}
                      />
                    </View>
                    <Text style={[styles.pickerLabel, selected && styles.pickerLabelOn]}>
                      {m.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        )}

        {/* Activity sheet — absolute overlay above toolbar */}
        {showActivity && (
          <View
            style={[
              styles.pickerSheet,
              {
                bottom: 120 + insets.bottom,
              },
            ]}
          >
            <View style={styles.pickerSheetHead}>
              <Text style={styles.pickerSheetTitle}>What are you doing?</Text>
              <Pressable onPress={() => setShowActivity(false)} hitSlop={10}>
                <Text style={styles.pickerSheetClose}>Done</Text>
              </Pressable>
            </View>
            <ScrollView showsVerticalScrollIndicator={false} style={styles.pickerScroll}>
              <View style={styles.pickerGrid}>
                {ACTIVITIES.map((a) => {
                  const value = `${a.label} ${a.emoji}`;
                  const selected = activity === value;
                  return (
                    <TouchableOpacity
                      key={value}
                      style={[styles.pickerCell, selected && styles.pickerCellOn]}
                      onPress={() => {
                        setActivity(selected ? null : value);
                        setShowActivity(false);
                      }}
                      activeOpacity={0.7}
                    >
                      <View style={[styles.pickerIconChip, selected && styles.pickerIconChipOn]}>
                        <Ionicons
                          name={a.icon}
                          size={18}
                          color={selected ? colors.legacyGoldDark : withAlpha(colors.legacyNavy, 0.6)}
                        />
                      </View>
                      <Text style={[styles.pickerLabel, selected && styles.pickerLabelOn]}>
                        {a.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </ScrollView>
          </View>
        )}
      </Animated.View>

      {/* Tag members modal */}
      <Modal
        visible={showTagPicker}
        transparent
        animationType="slide"
        onRequestClose={() => setShowTagPicker(false)}
      >
        <View style={styles.tagModalOverlay}>
          <Pressable style={styles.tagModalBackdrop} onPress={() => setShowTagPicker(false)} />
          <View
            style={[
              styles.tagModalContent,
              {
                paddingBottom: 20 + insets.bottom,
              },
            ]}
          >
            <View style={styles.tagModalHead}>
              <Text style={styles.tagModalTitle}>Tag members</Text>
              <Pressable onPress={() => setShowTagPicker(false)} hitSlop={10}>
                <Text style={styles.tagModalClose}>Done</Text>
              </Pressable>
            </View>
            <FlatList
              data={householdMembers}
              keyExtractor={(item) => item.userId}
              renderItem={({ item }) => {
                const checked = taggedMemberIds.includes(item.userId);
                return (
                  <TouchableOpacity
                    style={styles.tagRow}
                    onPress={() => {
                      setTaggedMemberIds((prev) =>
                        checked ? prev.filter((id) => id !== item.userId) : [...prev, item.userId],
                      );
                    }}
                  >
                    <Text style={styles.tagRowName}>{item.displayName}</Text>
                    <View style={[styles.tagCheckbox, checked && styles.tagCheckboxOn]}>
                      {checked && <Text style={styles.tagCheckMark}>✓</Text>}
                    </View>
                  </TouchableOpacity>
                );
              }}
              ListEmptyComponent={<Text style={styles.tagEmpty}>No household members</Text>}
            />
          </View>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: withAlpha(colors.shadow, 0.6), // backdrop
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    // stretch from animated top all the way down, like the mock
    backgroundColor: colors.canvasElevated,
    borderTopLeftRadius: 32,
    borderTopRightRadius: 32,
    borderWidth: 1,
    borderColor: colors.border,
    borderBottomWidth: 0,
    shadowColor: colors.shadow,
    shadowOffset: {
      width: 0,
      height: -8,
    },
    shadowOpacity: 0.3,
    shadowRadius: 40,
    elevation: 10,
  },
  handleBar: {
    width: 40,
    height: 4,
    backgroundColor: colors.surfaceDark,
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: 22,
  },
  header: {
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 22,
    height: 24,
  },
  title: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.ink,
    fontFamily: fonts.bodySemiBold,
  },
  titleCentered: {
    textAlign: 'center',
  },
  closeButton: {
    position: 'absolute',
    right: 0,
    top: -6,
    padding: 4,
  },
  closeCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.canvasWarm,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: withAlpha(colors.ink, 0.1),
  },
  userInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 16,
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    overflow: 'hidden',
  },
  avatarImage: {
    width: '100%',
    height: '100%',
  },
  avatarCircle: {
    backgroundColor: colors.borderCool,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitials: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.inkMuted,
    fontFamily: fonts.bodySemiBold,
  },
  userInfoName: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.ink,
    fontFamily: fonts.bodySemiBold,
  },
  moodPill: {
    flexDirection: 'row',
    alignItems: 'center',
    maxWidth: 150,
    backgroundColor: withAlpha(colors.legacyGold, 0.14),
    borderRadius: radius.card,
    paddingLeft: 10,
    paddingRight: 4,
    paddingVertical: 5,
    gap: 2,
  },
  moodPillText: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 12,
    fontWeight: '600',
    color: colors.legacyGoldDark,
    flexShrink: 1,
  },
  moodClear: {
    width: 22,
    height: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  moodClearText: {
    fontSize: 16,
    color: colors.legacyGoldDark,
    fontWeight: '600',
    lineHeight: 18,
  },
  inputScroll: {
    flex: 1,
    // fill the sheet between user row and toolbar, like the mock
    marginBottom: 4,
  },
  input: {
    fontSize: 15,
    lineHeight: 22.5,
    color: colors.ink,
    fontFamily: fonts.body,
    paddingVertical: 0,
    minHeight: 120,
  },
  activityPill: {
    alignSelf: 'flex-start',
    backgroundColor: withAlpha(colors.legacyGold, 0.14),
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginBottom: 8,
  },
  activityPillText: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 11,
    fontWeight: '600',
    color: colors.legacyGoldDark,
  },
  mediaStrip: {
    flexDirection: 'row',
    gap: 8,
    flexWrap: 'wrap',
    marginTop: 4,
  },
  mediaItem: {
    width: 92,
    height: 92,
    borderRadius: 12,
    position: 'relative',
    overflow: 'hidden',
    backgroundColor: colors.canvas,
  },
  mediaThumb: {
    width: '100%',
    height: '100%',
    borderRadius: 12,
  },
  playBadge: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playCircle: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: withAlpha(colors.black, 0.45),
    alignItems: 'center',
    justifyContent: 'center',
  },
  playBadgeText: {
    color: colors.onAccent,
    fontSize: 12,
    marginLeft: 2,
  },
  mediaOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: withAlpha(colors.overlayInk, 0.55),
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  uploadLabel: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 10,
    fontWeight: '600',
    color: colors.onAccent,
  },
  errorLabel: {
    fontFamily: fonts.bodyBold,
    fontSize: 12,
    fontWeight: '700',
    color: colors.onAccent,
  },
  retryLabel: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 10,
    fontWeight: '600',
    color: colors.legacyGold,
    marginTop: 2,
  },
  mediaRemove: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: withAlpha(colors.shadow, 0.6),
    alignItems: 'center',
    justifyContent: 'center',
  },
  mediaRemoveText: {
    color: colors.onAccent,
    fontSize: 14,
    fontWeight: '600',
    lineHeight: 16,
    marginTop: -1,
  },
  addMore: {
    borderWidth: 1.5,
    borderColor: withAlpha(colors.legacyNavy, 0.12),
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  addMorePlus: {
    fontSize: 24,
    color: withAlpha(colors.legacyNavy, 0.35),
    fontWeight: '300',
  },
  addMoreLabel: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 11,
    fontWeight: '600',
    color: withAlpha(colors.legacyNavy, 0.4),
  },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    gap: 8,
  },
  tools: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    flex: 1,
  },
  tool: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 12,
    gap: 5,
  },
  toolActive: {
    backgroundColor: withAlpha(colors.legacyGold, 0.12),
  },
  glyph: {
    fontSize: 15,
    lineHeight: 18,
  },
  toolText: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 12,
    fontWeight: '600',
    color: withAlpha(colors.legacyNavy, 0.5),
  },
  toolTextActive: {
    color: colors.legacyGoldDark,
  },
  toolBadge: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: colors.legacyGold,
    marginLeft: 1,
  },
  toolBadgeCount: {
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: colors.legacyGold,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 1,
    paddingHorizontal: 3,
  },
  toolBadgeCountText: {
    fontFamily: fonts.bodyBold,
    fontSize: 9,
    fontWeight: '700',
    color: colors.legacyNavySoft,
  },
  postButton: {
    backgroundColor: colors.gold,
    paddingVertical: 12,
    paddingHorizontal: 28,
    borderRadius: 9999,
    alignItems: 'center',
    minWidth: 88,
    ...goldButton.glow,
  },
  postButtonDisabled: {
    opacity: 0.45,
  },
  postButtonPressed: {},
  postButtonText: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.shadow,
    fontFamily: fonts.bodyBold,
  },
  chars: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 11,
    fontWeight: '600',
    color: withAlpha(colors.legacyNavy, 0.3),
    textAlign: 'right',
    marginTop: 6,
  },
  charsWarn: {
    color: colors.dangerDeep2,
  },
  pickerSheet: {
    position: 'absolute',
    left: 24,
    right: 24,
    backgroundColor: colors.canvasBright,
    borderRadius: radius.cardLg,
    padding: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: withAlpha(colors.legacyNavy, 0.08),
    shadowColor: colors.shadow,
    shadowOffset: {
      width: 0,
      height: -4,
    },
    shadowOpacity: 0.08,
    shadowRadius: 20,
    elevation: 6,
  },
  pickerScroll: {
    maxHeight: 210,
  },
  pickerSheetHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 14,
  },
  pickerSheetTitle: {
    fontFamily: fonts.bodyBold,
    fontSize: 14,
    fontWeight: '700',
    color: colors.legacyNavy,
  },
  pickerSheetClose: {
    fontFamily: fonts.bodyBold,
    fontSize: 14,
    fontWeight: '700',
    color: colors.legacyGold,
  },
  pickerGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  pickerCell: {
    width: '23%',
    flexGrow: 1,
    minWidth: 72,
    alignItems: 'center',
    paddingVertical: 12,
    borderRadius: radius.card,
    backgroundColor: colors.canvas,
  },
  pickerCellOn: {
    backgroundColor: withAlpha(colors.legacyGold, 0.18),
  },
  pickerIconChip: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: withAlpha(colors.legacyNavy, 0.06),
    marginBottom: 4,
  },
  pickerIconChipOn: {
    backgroundColor: withAlpha(colors.legacyGold, 0.18),
  },
  pickerLabel: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 11,
    fontWeight: '600',
    color: withAlpha(colors.legacyNavy, 0.5),
  },
  pickerLabelOn: {
    color: colors.legacyGoldDark,
  },
  tagModalOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: withAlpha(colors.black, 0.35),
  },
  tagModalBackdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  tagModalContent: {
    backgroundColor: colors.canvasElevated,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    borderColor: colors.border,
    borderBottomWidth: 0,
    maxHeight: '70%',
  },
  tagModalHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: withAlpha(colors.legacyNavy, 0.1),
  },
  tagModalTitle: {
    fontFamily: fonts.bodyBold,
    fontSize: 16,
    fontWeight: '700',
    color: colors.legacyNavy,
  },
  tagModalClose: {
    fontFamily: fonts.bodyBold,
    fontSize: 15,
    fontWeight: '700',
    color: colors.legacyGold,
  },
  tagRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: withAlpha(colors.legacyNavy, 0.06),
  },
  tagRowName: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 15,
    fontWeight: '600',
    color: colors.legacyNavy,
  },
  tagCheckbox: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: withAlpha(colors.legacyNavy, 0.2),
    alignItems: 'center',
    justifyContent: 'center',
  },
  tagCheckboxOn: {
    backgroundColor: colors.legacyGold,
    borderColor: colors.legacyGold,
  },
  tagCheckMark: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.legacyNavySoft,
  },
  tagEmpty: {
    fontFamily: fonts.bodyMedium,
    textAlign: 'center',
    paddingVertical: 30,
    fontSize: 14,
    fontWeight: '500',
    color: withAlpha(colors.legacyNavy, 0.35),
  },
});
