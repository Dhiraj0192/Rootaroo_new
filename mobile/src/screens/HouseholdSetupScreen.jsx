import React, { useState, useCallback } from 'react';
import { View, Text, StyleSheet, TextInput, TouchableOpacity } from 'react-native';
import { showAlert } from '../shared/services/themedAlert';
import SignupWizardShell from '../shared/components/SignupWizardShell';
import QrScannerModal from '../components/QrScannerModal';
import { ensureCamera } from '../shared/permissions';
import { useAuthStore } from '../shared/store/authStore';
import { householdApi } from '../shared/api/household';
import { navigateAfterHouseholdSetup } from '../shared/navigation/postAuthNavigation';
import { updateSignupProgress } from '../shared/store/signupProgress';
import { colors, fonts, radius } from '../shared/theme';
const FAMILY_EMOJIS = ['🏡', '🌿', '☀️'];
// Matches the QR the household admin generates in Household Settings /
// Invite Members (rootaroo://join?code=XXXX) — see app.json's "scheme".
const JOIN_LINK_RE = /^rootaroo:\/\/join\?code=([A-Za-z0-9]+)$/i;
export default function HouseholdSetupScreen({ navigation }) {
  const setHousehold = useAuthStore((s) => s.setHousehold);
  const [option, setOption] = useState('create');
  const [nestName, setNestName] = useState('');
  const [familyEmoji, setFamilyEmoji] = useState('🏡');
  const [inviteCode, setInviteCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [focusedField, setFocusedField] = useState(null);
  const [showScanner, setShowScanner] = useState(false);
  // Camera is resolved BEFORE the scanner opens: the permission sheet is
  // itself a Modal, and stacking one on top of the scanner's Modal is
  // unreliable on Android. Gating here also means the scanner never opens
  // onto a dead black screen.
  const handleScanPress = useCallback(async () => {
    if (await ensureCamera()) setShowScanner(true);
  }, []);
  const handleScanned = (rawValue) => {
    setShowScanner(false);
    const match = JOIN_LINK_RE.exec((rawValue || '').trim());
    if (!match) {
      showAlert('Not a Rootaroo invite code', 'That QR code doesn\'t look like a household invite. Try again or enter the code manually.');
      return;
    }
    setInviteCode(match[1].toUpperCase());
  };
  const handleContinue = async () => {
    setLoading(true);
    try {
      if (option === 'create') {
        if (!nestName.trim()) {
          showAlert('Error', 'Please enter a name for your household.');
          setLoading(false);
          return;
        }
      } else if (!inviteCode.trim()) {
        showAlert('Error', 'Please enter your invite code.');
        setLoading(false);
        return;
      }
      const hh =
        option === 'create'
          ? await householdApi.create(nestName.trim())
          : await householdApi.join(inviteCode.trim());
      setHousehold(hh.id);
      // Whether this user CREATED the household or joined an existing one
      // decides, much later, whether they see the feature overview after
      // InviteMembers — both paths pass through that screen, so the flag is
      // the only thing that can tell them apart there.
      await updateSignupProgress({ createdHousehold: option === 'create' });
      if (option === 'create') {
        navigation.navigate('SignupStepAddress');
      } else {
        await navigateAfterHouseholdSetup(navigation);
      }
    } catch (e) {
      const msg = e?.response?.data?.error || e?.message || 'Failed to set up household.';
      showAlert('Error', msg);
    } finally {
      setLoading(false);
    }
  };
  return (
    <SignupWizardShell
      step={5}
      stepName="Household"
      title="Your family starts here"
      onBack={() => navigation.goBack()}
      onContinue={handleContinue}
      continueDisabled={(option === 'create' ? !nestName.trim() : !inviteCode.trim()) || loading}
      loading={loading}
    >
      {/* Create option card */}
      <TouchableOpacity
        style={[styles.optionCard, option === 'create' && styles.optionCardOn]}
        onPress={() => setOption('create')}
        activeOpacity={0.85}
      >
        <View style={styles.optionHeader}>
          <View style={[styles.radio, option === 'create' && styles.radioOn]}>
            {option === 'create' && <View style={styles.radioDot} />}
          </View>
          <Text style={[styles.optionTitle, option === 'create' && styles.optionTitleOn]}>
            Create Household
          </Text>
        </View>

        {option === 'create' && (
          <View style={styles.createBody}>
            <Text style={styles.label}>Household name</Text>
            <TextInput
              style={[
                styles.input,
                (focusedField === 'name' || option === 'create') && styles.inputActive,
                focusedField === 'name' && styles.inputFocused,
              ]}
              value={nestName}
              onChangeText={setNestName}
              placeholder="The Mendez House"
              placeholderTextColor={colors.placeholderWarm}
              autoCorrect={false}
              onFocus={() => setFocusedField('name')}
              onBlur={() => setFocusedField(null)}
            />

            {/* <Text style={[styles.label, styles.emojiLabel]}>Family emoji</Text> */}
            {/* <View style={styles.emojiMiniRow}>
              {FAMILY_EMOJIS.map((e) => (
                <TouchableOpacity
                  key={e}
                  style={[styles.emojiMini, familyEmoji === e && styles.emojiMiniOn]}
                  onPress={() => setFamilyEmoji(e)}
                  activeOpacity={0.7}
                >
                  <Text style={styles.emojiMiniText}>{e}</Text>
                </TouchableOpacity>
              ))}
            </View> */}
          </View>
        )}
      </TouchableOpacity>

      {/* Join option */}
      <TouchableOpacity
        style={[styles.simpleOption, option === 'join' && styles.simpleOptionOn]}
        onPress={() => setOption('join')}
        activeOpacity={0.85}
      >
        <View style={[styles.radio, option === 'join' && styles.radioOn]}>
          {option === 'join' && <View style={styles.radioDot} />}
        </View>
        <Text style={[styles.optionTitle, option === 'join' && styles.optionTitleOn]}>
          Join Existing Household
        </Text>
      </TouchableOpacity>

      {option === 'join' && (
        <View style={styles.joinBody}>
          <Text style={styles.label}>Invite code</Text>
          <TextInput
            style={[
              styles.input,
              (focusedField === 'code' || option === 'join') && styles.inputActive,
              focusedField === 'code' && styles.inputFocused,
            ]}
            value={inviteCode}
            onChangeText={setInviteCode}
            placeholder="MND-482"
            placeholderTextColor={colors.placeholderWarm}
            autoCapitalize="characters"
            autoCorrect={false}
            onFocus={() => setFocusedField('code')}
            onBlur={() => setFocusedField(null)}
          />
          <TouchableOpacity
            style={styles.scanBtn}
            onPress={handleScanPress}
            activeOpacity={0.8}
          >
            <Text style={styles.scanBtnText}>Scan QR code instead</Text>
          </TouchableOpacity>
        </View>
      )}

      <QrScannerModal
        visible={showScanner}
        onClose={() => setShowScanner(false)}
        onScanned={handleScanned}
      />
    </SignupWizardShell>
  );
}
const styles = StyleSheet.create({
  optionCard: {
    marginTop: 14,
    backgroundColor: colors.surface,
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: colors.fieldBorder,
    padding: 18,
    gap: 12,
  },
  optionCardOn: {
    borderColor: colors.goldWarm,
    borderWidth: 2,
  },
  optionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  radio: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: colors.fieldBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioOn: {
    borderColor: colors.goldWarm,
  },
  radioDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.goldWarm,
  },
  optionTitle: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 15,
    fontWeight: '600',
    color: colors.textSecondaryWarm,
  },
  optionTitleOn: {
    color: colors.textPrimary,
  },
  createBody: {
    gap: 8,
    marginTop: 4,
  },
  joinBody: {
    gap: 8,
  },
  label: {
    fontFamily: fonts.bodyBold,
    fontSize: 12.5,
    lineHeight: 12.5,
    fontWeight: '700',
    letterSpacing: 0.3,
    color: colors.labelWarm,
    marginBottom: 8,
  },
  emojiLabel: {
    marginTop: 6,
  },
  input: {
    height: 52,
    backgroundColor: colors.surface,
    borderRadius: radius.card,
    borderWidth: 1.5,
    borderColor: colors.fieldBorder,
    paddingHorizontal: 16,
    fontSize: 16,
    color: colors.textPrimary,
    marginBottom: 14,
  },
  inputActive: {
    borderColor: colors.goldWarm,
  },
  inputFocused: {
    borderWidth: 2,
  },
  emojiMiniRow: {
    flexDirection: 'row',
    gap: 10,
  },
  emojiMini: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: colors.surface,
    borderWidth: 1.5,
    borderColor: colors.fieldBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emojiMiniOn: {
    borderColor: colors.goldWarm,
    borderWidth: 2.5,
    backgroundColor: colors.goldTint,
  },
  emojiMiniText: {
    fontSize: 22,
  },
  scanBtn: {
    alignItems: 'center',
    paddingVertical: 10,
  },
  scanBtnText: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 13,
    fontWeight: '600',
    color: colors.goldWarm,
    textDecorationLine: 'underline',
  },
  simpleOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 14,
    paddingHorizontal: 4,
  },
  simpleOptionOn: {},
});
