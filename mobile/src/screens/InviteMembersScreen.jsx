import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Share,
  ActivityIndicator,
} from 'react-native';
import { showAlert } from '../shared/services/themedAlert';
import QRCodeSvg from 'react-native-qrcode-svg';
import * as Clipboard from 'expo-clipboard';
import SignupWizardShell from '../shared/components/SignupWizardShell';
import { useAuthStore } from '../shared/store/authStore';
import { householdApi } from '../shared/api/household';
import { loadSignupProgress, updateSignupProgress } from '../shared/store/signupProgress';
import { colors, fonts } from '../shared/theme';
import Avatar from '../components/Avatar';

export default function InviteMembersScreen({ navigation }) {
  const completeSetup = useAuthStore((s) => s.completeSetup);
  const householdId = useAuthStore((s) => s.householdId);
  const user = useAuthStore((s) => s.user);
  const [inviteCode, setInviteCode] = useState('');
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!householdId) {
      setLoading(false);
      return;
    }
    Promise.all([
      householdApi.getHousehold(householdId).then((hh) => setInviteCode(hh.inviteCode)),
      householdApi.getMembers(householdId).then(setMembers),
    ])
      .catch(() => showAlert('Error', 'Failed to load invite details.'))
      .finally(() => setLoading(false));
  }, [householdId]);
  const displayCode = loading ? '···-···' : inviteCode || 'MND-482';
  const joinLink = inviteCode ? `rootaroo://join?code=${inviteCode}` : null;
  const handleCopy = async () => {
    await Clipboard.setStringAsync(displayCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  const handleShare = async () => {
    try {
      await Share.share({
        message: `Join my household on Rootaroo! Use invite code: ${displayCode}`,
      });
    } catch {
      /* dismissed */
    }
  };
  const currentUser = members.find((m) => m.userId === user?.id);
  const otherMembers = members.filter((m) => m.userId !== user?.id);
  const currentUserName = currentUser?.displayName || user?.name || user?.email || 'You';
  const finish = async () => {
    // Whoever CREATED this household gets the feature overview before landing
    // on Home — it is the tail of onboarding, so FeaturePricingScreen (its
    // last step) is what completes setup for them. People who joined with an
    // invite code finish right here, exactly as they always have.
    const progress = await loadSignupProgress();
    if (progress?.createdHousehold) {
      navigation.navigate('FeatureIntro');
      return;
    }
    await updateSignupProgress({
      step: 'done',
      setupComplete: true,
    });
    useAuthStore.getState().triggerCelebration();
    useAuthStore.getState().triggerTour();
    completeSetup();
  };
  return (
    <SignupWizardShell
      step={8}
      stepName="Invite"
      title="Bring everyone together"
      onBack={() => navigation.goBack()}
      onContinue={finish}
      continueDisabled={loading}
      loading={false}
    >
      {/* Invite code card */}
      <View style={styles.inviteCard}>
        <Text style={styles.inviteLabel}>Invite code</Text>
        <Text style={styles.inviteCode}>{displayCode}</Text>

        <View style={styles.qrWrap}>
          {loading || !joinLink ? (
            <ActivityIndicator color={colors.goldWarm} />
          ) : (
            <QRCodeSvg value={joinLink} size={96} color={colors.textPrimary} backgroundColor={colors.surface} />
          )}
        </View>

        <View style={styles.inviteActions}>
          <TouchableOpacity style={styles.pillBtn} onPress={handleShare} activeOpacity={0.8}>
            <Text style={styles.pillBtnText}>Messages</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.pillBtn} onPress={handleShare} activeOpacity={0.8}>
            <Text style={styles.pillBtnText}>Email</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.pillBtn} onPress={handleCopy} activeOpacity={0.8}>
            <Text style={styles.pillBtnText}>{copied ? 'Copied!' : 'Copy'}</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Joining now */}
      <Text style={styles.joiningLabel}>Joining now</Text>

      {otherMembers.map((m) => (
        <View key={m.userId} style={styles.joinRow}>
          <Text style={styles.joinCheck}>✓</Text>
          <Avatar
            url={m.avatarUrl}
            emoji={m.avatarEmoji}
            name={m.displayName}
            id={m.userId}
            size={36}
          />
          <Text style={styles.joinName}>{m.displayName} joined</Text>
        </View>
      ))}

      {/* You + waiting for more */}
      <View style={styles.joinRow}>
        <Text style={styles.joinCheck}>✓</Text>
        <Avatar
          url={currentUser?.avatarUrl}
          emoji={currentUser?.avatarEmoji}
          name={currentUserName}
          id={user?.id}
          size={36}
        />
        <Text style={styles.joinName}>
          {currentUserName}
          <Text style={styles.joinYou}> (you)</Text>
        </Text>
      </View>

      <View style={styles.joinRow}>
        <Text style={styles.joinPending}>…</Text>
        <View style={[styles.memberAvatar, styles.memberAvatarPending]}>
          <Text style={styles.memberAvatarText}>?</Text>
        </View>
        <Text style={styles.joinName}>Waiting for family</Text>
      </View>

      {/* Skip for now */}
      <TouchableOpacity
        style={styles.skipBtn}
        onPress={finish}
        hitSlop={{
          top: 8,
          bottom: 8,
          left: 8,
          right: 8,
        }}
      >
        <Text style={styles.skipText}>Skip for now</Text>
      </TouchableOpacity>
    </SignupWizardShell>
  );
}
const styles = StyleSheet.create({
  inviteCard: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: colors.fieldBorder,
    paddingTop: 30,
    paddingBottom: 20,
    paddingHorizontal: 16,
    alignItems: 'center',
    marginBottom: 12,
    marginTop: 12,
  },
  inviteLabel: {
    fontFamily: fonts.bodyBold,
    fontSize: 11,
    lineHeight: 11,
    fontWeight: '700',
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    color: colors.labelWarm,
    marginBottom: 10,
  },
  inviteCode: {
    fontFamily: fonts.mono,
    fontSize: 28,
    fontWeight: '700',
    color: colors.textPrimary,
    letterSpacing: 4,
    marginBottom: 16,
  },
  qrWrap: {
    width: 110,
    height: 110,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  inviteActions: {
    flexDirection: 'row',
    gap: 8,
  },
  pillBtn: {
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: 20,
    borderWidth: 1.5,
    borderColor: colors.fieldBorder,
    backgroundColor: colors.surface,
  },
  pillBtnText: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 13,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  joiningLabel: {
    fontFamily: fonts.bodyBold,
    fontSize: 12.5,
    lineHeight: 12.5,
    fontWeight: '700',
    letterSpacing: 0.3,
    color: colors.labelWarm,
    marginBottom: 12,
  },
  joinRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 3,
  },
  joinCheck: {
    width: 18,
    textAlign: 'center',
    fontSize: 14,
    fontWeight: '700',
    color: colors.success,
  },
  joinPending: {
    width: 18,
    textAlign: 'center',
    fontSize: 14,
    fontWeight: '700',
    color: colors.textMuted,
  },
  memberAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  memberAvatarPending: {
    backgroundColor: colors.surfaceDark,
  },
  memberAvatarText: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.onAccent,
  },
  joinName: {
    fontFamily: fonts.bodyMedium,
    fontSize: 14,
    fontWeight: '500',
    color: colors.textPrimary,
  },
  joinYou: {
    fontWeight: '400',
    color: colors.textSecondaryWarm,
  },
  skipBtn: {
    alignItems: 'center',
    paddingVertical: 6,
    marginTop: 6,
  },
  skipText: {
    fontFamily: fonts.bodyMedium,
    fontSize: 14,
    fontWeight: '500',
    color: colors.textSecondaryWarm,
  },
});
