import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ScrollView,
  KeyboardAvoidingView,
  StatusBar,
  ActivityIndicator,
} from 'react-native';
import { Image } from 'expo-image';
import { showAlert } from '../shared/services/themedAlert';
import * as ImagePicker from 'expo-image-picker';
import DateTimePicker from '@react-native-community/datetimepicker';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuthStore } from '../shared/store/authStore';
import { authApi } from '../shared/api/auth';
import { householdApi } from '../shared/api/household';
import { feedApi } from '../shared/api/feed';
import apiClient from '../shared/api/client';
import { colors, fonts, goldButton, radius, withAlpha } from '../shared/theme';
import { GoldFill } from '../shared/components/GoldButton';
import { cacheKeyFromUrl } from '../components/Avatar';
import PostCard from '../shared/components/PostCard';
import { KEYBOARD_BEHAVIOR } from '../shared/components/KeyboardAware';
import { useTabBarDockHeight } from '../shared/hooks/useTabBarDockHeight';
const AVATAR_SIZE = 88;
const AVATAR_RADIUS = AVATAR_SIZE / 2;
// How much of the avatar sits over the cover photo vs. hangs below it.
const AVATAR_COVER_OVERLAP = 90;
const AVATAR_HANG_BELOW = AVATAR_SIZE - AVATAR_COVER_OVERLAP;
function getServerBase() {
  const base = apiClient.defaults.baseURL || '';
  return base.replace(/\/api\/v1\/?$/, '');
}
function getInitials(name) {
  return name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}
function formatDateLabel(iso) {
  if (!iso) return 'Add your birthday';
  const d = new Date(iso + 'T12:00:00');
  if (Number.isNaN(d.getTime())) return 'Add your birthday';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}
export default function EditProfileScreen({ navigation }) {
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const householdId = useAuthStore((s) => s.householdId);
  const insets = useSafeAreaInsets();
  const dockHeight = useTabBarDockHeight();
  const [name, setName] = useState(user?.name ?? '');
  const [phone, setPhone] = useState(user?.phone ?? '');
  const [dateOfBirth, setDateOfBirth] = useState(user?.dateOfBirth ?? null);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [homeAddress, setHomeAddress] = useState(user?.homeAddress ?? '');
  const [avatarUrl, setAvatarUrl] = useState(user?.avatarUrl ?? null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [saving, setSaving] = useState(false);
  const [isHouseholdAdmin, setIsHouseholdAdmin] = useState(false);
  const [coverPhotoUrl, setCoverPhotoUrl] = useState(null);
  const [uploadingCover, setUploadingCover] = useState(false);
  const [myPosts, setMyPosts] = useState([]);
  const [postsLoading, setPostsLoading] = useState(true);
  const canSave = name.trim().length > 0 && !saving && !uploadingAvatar;
  useEffect(() => {
    if (!householdId) return;
    householdApi
      .getHousehold(householdId)
      .then((hh) => {
        setIsHouseholdAdmin(hh.role === 'admin');
        setCoverPhotoUrl(hh.coverPhotoUrl);
      })
      .catch(() => {});
  }, [householdId]);
  useEffect(() => {
    if (!user?.id) return;
    setPostsLoading(true);
    feedApi
      .list({ authorId: user.id, limit: 50 })
      .then((data) => setMyPosts(data.posts || []))
      .catch(() => setMyPosts([]))
      .finally(() => setPostsLoading(false));
  }, [user?.id]);
  const handleDeletePost = useCallback((postId) => {
    showAlert('Delete post', 'This cannot be undone.', [
      {
        text: 'Cancel',
        style: 'cancel',
      },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await feedApi.delete(postId);
            setMyPosts((prev) => prev.filter((p) => p.id !== postId));
          } catch {
            showAlert('Error', 'Could not delete post');
          }
        },
      },
    ]);
  }, []);
  const pickCoverPhoto = useCallback(async () => {
    if (!householdId) return;
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [4, 3],
      quality: 0.5,
    });
    if (result.canceled || !result.assets[0]) return;
    setUploadingCover(true);
    try {
      const hh = await householdApi.uploadCoverPhoto(householdId, result.assets[0].uri);
      setCoverPhotoUrl(hh.coverPhotoUrl);
    } catch (e) {
      showAlert('Upload failed', e?.response?.data?.error || 'Could not upload cover photo');
    } finally {
      setUploadingCover(false);
    }
  }, [householdId]);
  const removeCoverPhoto = useCallback(async () => {
    if (!householdId) return;
    setUploadingCover(true);
    try {
      const hh = await householdApi.removeCoverPhoto(householdId);
      setCoverPhotoUrl(hh.coverPhotoUrl);
    } catch (e) {
      showAlert('Error', e?.response?.data?.error || 'Could not remove cover photo');
    } finally {
      setUploadingCover(false);
    }
  }, [householdId]);
  const handleCoverMenu = useCallback(() => {
    const options = [
      {
        text: coverPhotoUrl ? 'Change photo' : 'Choose photo',
        onPress: pickCoverPhoto,
      },
    ];
    if (coverPhotoUrl) {
      options.push({
        text: 'Remove photo',
        style: 'destructive',
        onPress: removeCoverPhoto,
      });
    }
    options.push({
      text: 'Cancel',
      style: 'cancel',
    });
    showAlert('Cover photo', undefined, options);
  }, [coverPhotoUrl, pickCoverPhoto, removeCoverPhoto]);
  const pickAvatar = useCallback(async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.7,
    });
    if (result.canceled || !result.assets[0]) return;
    setUploadingAvatar(true);
    try {
      const data = await authApi.uploadAvatar(result.assets[0].uri);
      setAvatarUrl(data.avatarUrl);
      if (user)
        setUser({
          ...user,
          avatarUrl: data.avatarUrl,
        });
    } catch (e) {
      showAlert('Upload failed', e?.message || 'Could not upload photo');
    } finally {
      setUploadingAvatar(false);
    }
  }, [user, setUser]);
  const handleSave = useCallback(async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const updated = await authApi.updateProfile({
        displayName: name.trim(),
        avatarUrl: avatarUrl ?? undefined,
        phone: phone.trim() || null,
        dateOfBirth: dateOfBirth || null,
        homeAddress: homeAddress.trim() || null,
      });
      if (user) {
        setUser({
          ...user,
          name: updated.displayName,
          avatarEmoji: updated.avatarEmoji,
          avatarUrl: updated.avatarUrl,
          phone: updated.phone,
          dateOfBirth: updated.dateOfBirth,
          homeAddress: updated.homeAddress,
        });
      }
      navigation.goBack();
    } catch (e) {
      showAlert('Error', e?.response?.data?.error || e?.message || 'Failed to save profile');
    } finally {
      setSaving(false);
    }
  }, [name, phone, dateOfBirth, homeAddress, avatarUrl, user, setUser, navigation]);
  const avatarSrc = avatarUrl
    ? {
        uri: avatarUrl.startsWith('http') ? avatarUrl : `${getServerBase()}${avatarUrl}`,
      }
    : null;
  const initials = getInitials(name || user?.name || 'ME');
  const hasCoverSection = !!coverPhotoUrl || isHouseholdAdmin;
  const avatarInner = uploadingAvatar ? (
    <View style={styles.avatarCircle}>
      <ActivityIndicator color={colors.gold} />
    </View>
  ) : avatarSrc ? (
    <Image source={avatarSrc} style={styles.avatarImage} />
  ) : (
    <View style={styles.avatarCircle}>
      <Text style={styles.avatarInitials}>{initials}</Text>
    </View>
  );
  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={KEYBOARD_BEHAVIOR}
    >
      <StatusBar barStyle="light-content" backgroundColor={colors.canvas} />

      {/* ── Header (SCREEN 40): back + Edit profile + Save ── */}
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
        <Text style={styles.headerTitle}>Edit profile</Text>
        <TouchableOpacity
          onPress={handleSave}
          disabled={!canSave}
          hitSlop={{
            top: 8,
            bottom: 8,
            left: 8,
            right: 8,
          }}
        >
          {saving ? (
            <ActivityIndicator size="small" color={colors.gold} />
          ) : (
            <Text style={[styles.saveLink, !canSave && styles.saveLinkDisabled]}>Save</Text>
          )}
        </TouchableOpacity>
      </View>

      {/* ── Household cover photo banner (Facebook-style, admin-editable) ──
          Avatar is absolutely positioned here (outside the ScrollView below)
          so it overlaps the cover without being clipped by the scroll
          viewport's bounds. */}
      {hasCoverSection && (
        <View style={styles.coverContainer}>
          <View style={styles.coverBanner}>
            {coverPhotoUrl ? (
              <Image
                source={{ uri: coverPhotoUrl, cacheKey: cacheKeyFromUrl(coverPhotoUrl) }}
                style={styles.coverImage}
                cachePolicy="disk"
              />
            ) : (
              <View style={styles.coverPlaceholder}>
                <Text style={styles.coverPlaceholderText}>Add a cover photo</Text>
              </View>
            )}
            {uploadingCover && (
              <View style={styles.coverUploadingOverlay}>
                <ActivityIndicator color={colors.onAccent} />
              </View>
            )}
            {isHouseholdAdmin && (
              <TouchableOpacity
                style={styles.coverEditBadge}
                onPress={handleCoverMenu}
                activeOpacity={0.85}
                disabled={uploadingCover}
                hitSlop={{
                  top: 8,
                  bottom: 8,
                  left: 8,
                  right: 8,
                }}
              >
                <GoldFill radius={17} disabled={uploadingCover} />
                <Text style={styles.coverEditBadgeIcon}>✎</Text>
              </TouchableOpacity>
            )}
          </View>

          <TouchableOpacity
            style={styles.avatarWrapOverlap}
            onPress={pickAvatar}
            activeOpacity={0.85}
            disabled={uploadingAvatar}
          >
            {avatarInner}
            <View style={styles.cameraBadge}>
              <Text style={styles.cameraBadgeIcon}>📷</Text>
            </View>
          </TouchableOpacity>
        </View>
      )}

      <ScrollView
        contentContainerStyle={[
          styles.form,
          {
            paddingTop: hasCoverSection ? AVATAR_HANG_BELOW + 16 : 24,
            paddingBottom: dockHeight + 16,
          },
        ]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* ── Avatar (SCREEN 40) — centered, only when there's no cover banner ── */}
        {!hasCoverSection && (
          <View style={styles.avatarSection}>
            <TouchableOpacity
              style={styles.avatarWrap}
              onPress={pickAvatar}
              activeOpacity={0.85}
              disabled={uploadingAvatar}
            >
              {avatarInner}
              <View style={styles.cameraBadge}>
                <Text style={styles.cameraBadgeIcon}>📷</Text>
              </View>
            </TouchableOpacity>
          </View>
        )}

        {/* ── Name ── */}
        <Text style={styles.fieldLabel}>Name</Text>
        <TextInput
          style={styles.input}
          value={name}
          onChangeText={setName}
          placeholder="Sara Mendez"
          placeholderTextColor={colors.textMuted}
          maxLength={80}
          returnKeyType="next"
        />

        {/* ── Phone ── */}
        <Text style={styles.fieldLabel}>Phone</Text>
        <TextInput
          style={styles.input}
          value={phone}
          onChangeText={setPhone}
          placeholder="(555) 010-0192"
          placeholderTextColor={colors.textMuted}
          keyboardType="phone-pad"
          maxLength={20}
        />

        {/* ── Date of birth ── */}
        <Text style={styles.fieldLabel}>Date of birth</Text>
        <TouchableOpacity
          style={styles.input}
          onPress={() => setShowDatePicker(true)}
          activeOpacity={0.7}
        >
          <Text style={dateOfBirth ? styles.inputValue : styles.inputPlaceholder}>
            {formatDateLabel(dateOfBirth)}
          </Text>
        </TouchableOpacity>

        {/* ── Home address ── */}
        <Text style={styles.fieldLabel}>Home address</Text>
        <TextInput
          style={styles.input}
          value={homeAddress}
          onChangeText={setHomeAddress}
          placeholder="482 Maple Street, Austin, TX 78701"
          placeholderTextColor={colors.textMuted}
          maxLength={500}
        />

        {/* ── Email (read-only) ── */}
        <Text style={styles.fieldLabel}>Email</Text>
        <TextInput
          style={[styles.input, styles.inputReadOnly, styles.inputReadOnlyText]}
          value={user?.email || ''}
          editable={false}
        />

        {/* ── My posts (Facebook profile-style feed) ── */}
        <Text style={[styles.fieldLabel, styles.postsLabel]}>My posts</Text>
        {postsLoading ? (
          <ActivityIndicator color={colors.gold} style={styles.postsLoading} />
        ) : myPosts.length === 0 ? (
          <Text style={styles.postsEmptyText}>You haven't posted anything yet.</Text>
        ) : (
          <View style={styles.postsList}>
            {myPosts.map((post) => (
              <View key={post.id} style={styles.postCardWrap}>
                <PostCard
                  post={post}
                  onOpen={() => navigation.navigate('PostDetail', { postId: post.id })}
                  onLike={() => {}}
                  canDelete
                  onOptions={() => handleDeletePost(post.id)}
                />
              </View>
            ))}
          </View>
        )}

        {/* ── Delete account ── */}
        <TouchableOpacity
          style={styles.deleteRow}
          onPress={() => navigation.navigate('AccountDeletion')}
          activeOpacity={0.75}
        >
          <Text style={styles.deleteRowText}>Delete account</Text>
        </TouchableOpacity>
      </ScrollView>

      {showDatePicker && (
        <DateTimePicker
          value={dateOfBirth ? new Date(dateOfBirth + 'T12:00:00') : new Date(1989, 5, 11)}
          mode="date"
          maximumDate={new Date()}
          onChange={(_, newDate) => {
            setShowDatePicker(false);
            if (newDate) setDateOfBirth(newDate.toISOString().split('T')[0]);
          }}
        />
      )}
    </KeyboardAvoidingView>
  );
}
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.canvas,
  },
  // Header (SCREEN 40)
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: 66,
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
  saveLink: {
    fontSize: 14,
    fontWeight: '600',
    fontFamily: fonts.bodySemiBold,
    color: colors.goldDeep,
    minWidth: 32,
    textAlign: 'right',
  },
  saveLinkDisabled: {
    opacity: 0.4,
  },
  // Form
  form: {
    paddingHorizontal: 24,
    paddingTop: 24,
  },
  // Avatar (SCREEN 40)
  avatarSection: {
    alignItems: 'center',
    marginBottom: 0,
  },
  avatarWrap: {
    position: 'relative',
  },
  // Avatar overlapping the bottom-left of the cover banner (FB-style).
  // Absolutely positioned against coverContainer so it can hang below the
  // banner without being clipped by the ScrollView underneath.
  avatarWrapOverlap: {
    position: 'absolute',
    left: 24,
    bottom: -AVATAR_HANG_BELOW,
  },
  avatarCircle: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_RADIUS,
    backgroundColor: colors.borderCool,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 3,
    borderColor: colors.canvas,
  },
  avatarImage: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_RADIUS,
    borderWidth: 3,
    borderColor: colors.canvas,
  },
  avatarInitials: {
    fontSize: 24,
    fontWeight: '600',
    fontFamily: fonts.bodySemiBold,
    color: colors.inkMuted,
  },
  cameraBadge: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.gold,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: colors.canvas,
  },
  cameraBadgeIcon: {
    fontSize: 14,
  },
  // Fields (SCREEN 40 design inputs)
  fieldLabel: {
    fontSize: 11,
    fontWeight: '600',
    fontFamily: fonts.bodySemiBold,
    letterSpacing: 0.4,
    color: colors.textSecondary,
    marginBottom: 7,
    marginTop: 14,
  },
  input: {
    height: 52,
    borderRadius: radius.card,
    backgroundColor: colors.surface,
    borderWidth: 1.5,
    borderColor: colors.border,
    paddingHorizontal: 16,
    fontSize: 14,
    fontFamily: fonts.body,
    color: colors.ink,
    justifyContent: 'center',
  },
  inputReadOnly: {
    backgroundColor: colors.surfaceDark,
  },
  inputReadOnlyText: {
    color: colors.textMuted,
  },
  inputValue: {
    fontSize: 14,
    fontFamily: fonts.body,
    color: colors.ink,
  },
  inputPlaceholder: {
    fontSize: 14,
    fontFamily: fonts.body,
    color: colors.textMuted,
  },
  // My posts (Facebook profile-style feed)
  postsLabel: {
    marginTop: 26,
    marginBottom: 10,
  },
  postsLoading: {
    marginVertical: 20,
  },
  postsEmptyText: {
    fontSize: 13,
    fontFamily: fonts.body,
    color: colors.textMuted,
    marginBottom: 20,
  },
  postsList: {
    marginHorizontal: -24,
    marginBottom: 20,
    gap: 10,
  },
  postCardWrap: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  // Household cover photo banner (Facebook-style)
  coverContainer: {
    position: 'relative',
    marginTop:20
  },
  coverBanner: {
    height: 210,
    backgroundColor: colors.surfaceWarm,
    position: 'relative',
    overflow: 'hidden',
  },
  coverImage: {
    width: '100%',
    height: '100%',
  },
  coverPlaceholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  coverPlaceholderText: {
    fontSize: 13,
    fontFamily: fonts.body,
    color: colors.textMuted,
  },
  coverUploadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: withAlpha(colors.shadow, 0.35),
    alignItems: 'center',
    justifyContent: 'center',
  },
  coverEditBadge: {
    position: 'absolute',
    bottom: 12,
    right: 16,
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.gold,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: colors.canvas,
    ...goldButton.glow,
  },
  coverEditBadgeIcon: {
    fontSize: 14,
    color: goldButton.onGold,
  },
  // Delete account (SCREEN 40)
  deleteRow: {
    alignItems: 'center',
    paddingVertical: 12,
  },
  deleteRowText: {
    fontSize: 13,
    fontWeight: '500',
    fontFamily: fonts.bodyMedium,
    color: colors.danger,
  },
});
