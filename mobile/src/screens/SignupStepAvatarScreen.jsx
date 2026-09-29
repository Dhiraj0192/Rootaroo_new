import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Image,
  ActivityIndicator,
} from 'react-native';
import { showAlert } from '../shared/services/themedAlert';
import Svg, { Path, Circle as SvgCircle } from 'react-native-svg';
import * as ImagePicker from 'expo-image-picker';
import SignupWizardShell from '../shared/components/SignupWizardShell';
import { authApi, storePendingAuthResponse } from '../shared/api/auth';
import { useAuthStore } from '../shared/store/authStore';
import { loadSignupProgress, updateSignupProgress } from '../shared/store/signupProgress';
import { colors, fonts, radius } from '../shared/theme';
const AVATAR_PRESETS = [
  {
    id: 'ava_01',
    source: require('../../assets/images/avatars/avatar1-removebg-preview.png'),
  },
  {
    id: 'ava_02',
    source: require('../../assets/images/avatars/avatar2-removebg-preview.png'),
  },
  // ava_03–05: DiceBear "avataaars" style — Avataaars by Pablo Stanley,
  // free for personal and commercial use (https://avataaars.com).
  {
    id: 'ava_03',
    source: require('../../assets/images/avatars/avatar3.png'),
  },
  {
    id: 'ava_04',
    source: require('../../assets/images/avatars/avatar4.png'),
  },
  {
    id: 'ava_05',
    source: require('../../assets/images/avatars/avatar5.png'),
  },
];
function localUriFromSource(source) {
  const resolved = Image.resolveAssetSource(source);
  if (!resolved?.uri) throw new Error('Could not load avatar image');
  return resolved.uri;
}
function initialsOf(name) {
  if (!name) return 'SM';
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
}
export default function SignupStepAvatarScreen({ navigation }) {
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const [localUri, setLocalUri] = useState(null);
  const [avatarUrl, setAvatarUrl] = useState(null);
  const [presetId, setPresetId] = useState(null);
  const [familyEmoji, setFamilyEmoji] = useState('🏡');
  const [uploading, setUploading] = useState(false);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    loadSignupProgress().then((p) => {
      if (p?.draft.avatarUrl) setAvatarUrl(p.draft.avatarUrl);
      else if (user?.avatarUrl) setAvatarUrl(user.avatarUrl);
      if (p?.draft.avatarPresetId) setPresetId(p.draft.avatarPresetId);
      if (p?.draft.avatarEmoji) setFamilyEmoji(p.draft.avatarEmoji);
    });
  }, [user?.avatarUrl]);
  const pickPhoto = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.75,
    });
    if (result.canceled || !result.assets[0]) return;
    const uri = result.assets[0].uri;
    setLocalUri(uri);
    setPresetId(null);
    setUploading(true);
    try {
      const progress = await loadSignupProgress();
      if (progress?.authMethod === 'phone') {
        setAvatarUrl(uri);
      } else {
        const data = await authApi.uploadAvatar(uri);
        setAvatarUrl(data.avatarUrl);
        if (user)
          setUser({
            ...user,
            avatarUrl: data.avatarUrl,
          });
      }
    } catch (e) {
      showAlert('Upload failed', e?.message || 'Could not upload photo');
    } finally {
      setUploading(false);
    }
  };
  const selectedPreset = AVATAR_PRESETS.find((p) => p.id === presetId);
  const previewUri = localUri || (avatarUrl && avatarUrl.startsWith('http') ? avatarUrl : null);
  const handleContinue = async () => {
    if (!previewUri && !presetId) {
      showAlert('Almost there', 'Add a photo or choose an avatar.');
      return;
    }
    setLoading(true);
    try {
      const progress = await loadSignupProgress();
      const method = progress?.authMethod || 'email';
      const draft = progress?.draft || {};

      // Resolve uploadable local file for preset picks
      let uploadUri = localUri;
      if (!uploadUri && selectedPreset) {
        uploadUri = localUriFromSource(selectedPreset.source);
      }
      if (method === 'phone') {
        const phone = progress?.phone || `${draft.countryCode || '+1'}${draft.phone || ''}`;
        if (!phone || phone.length < 8) {
          showAlert('Error', 'Phone number missing. Go back to address step.');
          setLoading(false);
          return;
        }
        const resp = await authApi.registerPhone({
          phone,
          displayName: draft.displayName || 'Member',
          dateOfBirth: draft.dateOfBirth,
          homeAddress: draft.homeAddress,
          addToCalendar: draft.addToCalendar,
          notifyHousehold: draft.notifyHousehold,
          avatarUrl: avatarUrl?.startsWith('http') ? avatarUrl : null,
          avatarPresetId: presetId,
          avatarEmoji: familyEmoji,
        });
        storePendingAuthResponse(resp);
        let uploadedUrl = avatarUrl?.startsWith('http') ? avatarUrl : null;
        if (uploadUri && !uploadedUrl) {
          try {
            const data = await authApi.uploadAvatar(uploadUri);
            uploadedUrl = data.avatarUrl;
            await authApi.updateProfile({
              avatarUrl: uploadedUrl,
              avatarPresetId: presetId,
              avatarEmoji: familyEmoji,
            });
          } catch {
            // non-fatal — preset id still saved
          }
        }
        await updateSignupProgress({
          step: 'household',
          phone,
          draft: {
            avatarUrl: uploadedUrl || undefined,
            avatarPresetId: presetId || undefined,
            avatarEmoji: familyEmoji,
          },
        });
      } else {
        let uploadedUrl = avatarUrl?.startsWith('http') ? avatarUrl : null;
        if (uploadUri && !uploadedUrl && user) {
          try {
            const data = await authApi.uploadAvatar(uploadUri);
            uploadedUrl = data.avatarUrl;
          } catch {
            // keep going with preset id
          }
        }
        if (user) {
          await authApi.updateProfile({
            avatarPresetId: presetId,
            avatarEmoji: familyEmoji,
            ...(uploadedUrl
              ? {
                  avatarUrl: uploadedUrl,
                }
              : {}),
          });
          setUser({
            ...user,
            avatarPresetId: presetId,
            avatarEmoji: familyEmoji,
            avatarUrl: uploadedUrl || user.avatarUrl,
          });
        }
        await updateSignupProgress({
          step: 'household',
          draft: {
            avatarUrl: uploadedUrl || undefined,
            avatarPresetId: presetId || undefined,
            avatarEmoji: familyEmoji,
          },
        });
      }
      navigation.navigate('HouseholdSetup');
    } catch (e) {
      const status = e?.response?.status;
      const msg =
        status === 404
          ? 'Phone signup API is missing. Restart the server (cd server && ./restart-dev.sh) and try again.'
          : e?.response?.data?.error || e?.message || 'Could not save profile';
      showAlert('Error', msg);
    } finally {
      setLoading(false);
    }
  };
  return (
    <SignupWizardShell
      step={4}
      stepName="Family identity"
      title="Create your family's identity"
      onBack={() => navigation.goBack()}
      onContinue={handleContinue}
      continueDisabled={!previewUri && !presetId}
      loading={loading}
    >
      {/* Avatar circle + upload */}
      <View style={styles.avatarWrap}>
        <TouchableOpacity onPress={pickPhoto} activeOpacity={0.85} style={styles.avatarTouch}>
          <View style={styles.avatarCircle}>
            {uploading ? (
              <ActivityIndicator color={colors.goldWarm} />
            ) : previewUri ? (
              <Image
                source={{
                  uri: previewUri,
                }}
                style={styles.avatarImg}
              />
            ) : selectedPreset ? (
              <Image source={selectedPreset.source} style={styles.avatarImg} />
            ) : (
              <Text style={styles.avatarInitials}>{initialsOf(user?.name) || 'SM'}</Text>
            )}
            {/* Camera badge */}
            <View style={styles.camBadge}>
              <Svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke={colors.onAccent}
                strokeWidth="2"
              >
                <Path d="M4 8h3l2-2h6l2 2h3v11H4z" />
                <SvgCircle cx="12" cy="13" r="3.5" />
              </Svg>
            </View>
          </View>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={pickPhoto}
          hitSlop={{
            top: 8,
            bottom: 8,
            left: 8,
            right: 8,
          }}
        >
          <Text style={styles.uploadLink}>Upload photo</Text>
        </TouchableOpacity>
      </View>

      {/* Preset avatars */}
      <Text style={styles.sectionLabel}>Or choose an avatar</Text>
      <View style={styles.avatarRow}>
        {AVATAR_PRESETS.map((p) => (
          <TouchableOpacity
            key={p.id}
            style={[styles.avatarChoice, presetId === p.id && styles.avatarChoiceOn]}
            onPress={() => {
              setPresetId(p.id);
              setLocalUri(null);
              setAvatarUrl(null);
            }}
            activeOpacity={0.75}
          >
            <Image source={p.source} style={styles.avatarChoiceImg} />
          </TouchableOpacity>
        ))}
      </View>
    </SignupWizardShell>
  );
}
const styles = StyleSheet.create({
  avatarWrap: {
    alignItems: 'center',
    gap: 10,
    marginTop: 4,
    marginBottom: 6,
  },
  avatarTouch: {
    borderRadius: 52,
  },
  avatarCircle: {
    width: 104,
    height: 104,
    borderRadius: 52,
    backgroundColor: colors.surfaceDark,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  avatarImg: {
    width: 104,
    height: 104,
  },
  avatarInitials: {
    fontFamily: fonts.displayBold,
    fontSize: 30,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  camBadge: {
    position: 'absolute',
    right: 2,
    bottom: 2,
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 2,
    borderColor: colors.bgApp,
    alignItems: 'center',
    justifyContent: 'center',
  },
  uploadLink: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 14,
    fontWeight: '600',
    color: colors.goldWarm,
  },
  sectionLabel: {
    fontFamily: fonts.bodyBold,
    fontSize: 12.5,
    lineHeight: 12.5,
    fontWeight: '700',
    letterSpacing: 0.3,
    color: colors.labelWarm,
    marginBottom: 8,
  },
  avatarRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 6,
  },
  avatarChoice: {
    width: 52,
    height: 52,
    borderRadius: 26,
    overflow: 'hidden',
    borderWidth: 1.5,
    borderColor: colors.fieldBorder,
    backgroundColor: colors.surface,
  },
  avatarChoiceOn: {
    borderColor: colors.goldWarm,
    borderWidth: 2.5,
  },
  avatarChoiceImg: {
    width: '100%',
    height: '100%',
  },
});
