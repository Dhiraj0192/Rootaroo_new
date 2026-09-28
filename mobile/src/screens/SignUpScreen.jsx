import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  StatusBar,
  TextInput,
  TouchableOpacity,
  KeyboardAvoidingView,
  ScrollView,
  ActivityIndicator,
} from 'react-native';
import { showAlert } from '../shared/services/themedAlert';
import Svg, { Path } from 'react-native-svg';
import { authApi, storePendingAuthResponse } from '../shared/api/auth';
import { startEmailSignupProgress } from '../shared/navigation/postAuthNavigation';
import { colors, fonts, goldButton, radius } from '../shared/theme';
import { GoldFill } from '../shared/components/GoldButton';
import { KEYBOARD_BEHAVIOR } from '../shared/components/KeyboardAware';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* Back chevron — matches rootaro_signup_validation.html (20x20, stroke 2, ink) */
function BackChevron() {
  return (
    <Svg width="20" height="20" viewBox="0 0 24 24" fill="none">
      <Path
        d="M15 5l-7 7 7 7"
        stroke={colors.textPrimary}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/* Inline field error — warning circle + message (matches HTML .error-msg) */
function FieldError({ text }) {
  return (
    <View style={styles.errorRow}>
      <Svg width="14" height="14" viewBox="0 0 20 20" fill={colors.errorWarm}>
        <Path
          fillRule="evenodd"
          d="M10 18a8 8 0 100-16 8 8 0 000 16zM9 5a1 1 0 112 0v5a1 1 0 11-2 0V5zm1 10a1.25 1.25 0 100-2.5 1.25 1.25 0 000 2.5z"
          clipRule="evenodd"
        />
      </Svg>
      <Text style={styles.errorText}>{text}</Text>
    </View>
  );
}
export default function SignUpScreen({ navigation }) {
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [focusedField, setFocusedField] = useState(null);

  /* Live validation — inline errors, no popups (matches validation mockup) */
  const emailError =
    email.trim() !== '' && !EMAIL_RE.test(email.trim()) ? 'Enter a valid email address.' : null;
  const passwordError =
    password !== '' && password.length < 8 ? 'Password must be at least 8 characters.' : null;
  const canContinue = EMAIL_RE.test(email.trim()) && password.length >= 8 && !loading;
  const handleContinue = async () => {
    if (!canContinue) return;
    setLoading(true);
    try {
      const emailTrimmed = email.trim();
      const phoneTrimmed = phone.trim();
      const resp = await authApi.register({
        email: emailTrimmed,
        password,
        phone: phoneTrimmed || undefined,
        // Provisional — overwritten on Name step
        displayName: emailTrimmed.split('@')[0] || 'Member',
      });
      storePendingAuthResponse(resp);
      // Navigate first so progress store updates cannot interrupt the transition
      navigation.navigate('SignupStepName');
      await startEmailSignupProgress(emailTrimmed, phoneTrimmed);
    } catch (e) {
      const msg = e?.response?.data?.error || e?.message || 'Registration failed.';
      showAlert('Registration Error', msg);
    } finally {
      setLoading(false);
    }
  };
  const emailBorder = emailError
    ? styles.inputError
    : focusedField === 'email'
      ? styles.inputFocused
      : null;
  const phoneBorder = focusedField === 'phone' ? styles.inputFocused : null;
  const pwBorder = passwordError
    ? styles.inputError
    : focusedField === 'password'
      ? styles.inputFocused
      : null;
  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor={colors.bgApp} />

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={KEYBOARD_BEHAVIOR}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Header: back chevron only (matches ref) */}
          <View style={styles.header}>
            <TouchableOpacity
              onPress={() => navigation.goBack()}
              hitSlop={{
                top: 10,
                bottom: 10,
                left: 20,
                right: 20,
              }}
              style={styles.backBtn}
            >
              <BackChevron />
            </TouchableOpacity>
          </View>

          {/* Title + subtitle */}
          <Text style={styles.title}>Set up your login</Text>
          <Text style={styles.subtitle}>We'll use this to keep your Rootaroo account secure.</Text>

          {/* Fields */}
          <View style={styles.form}>
            <View style={styles.fieldGroup}>
              <Text style={styles.label}>Email</Text>
              <TextInput
                style={[styles.input, emailBorder]}
                value={email}
                onChangeText={setEmail}
                placeholder="sara@email.com"
                placeholderTextColor={colors.placeholderWarm}
                autoCapitalize="none"
                keyboardType="email-address"
                autoCorrect={false}
                onFocus={() => setFocusedField('email')}
                onBlur={() => setFocusedField(null)}
              />
              {emailError ? <FieldError text={emailError} /> : null}
            </View>

            <View style={styles.fieldGroup}>
              <Text style={styles.label}>Phone</Text>
              <TextInput
                style={[styles.input, phoneBorder]}
                value={phone}
                onChangeText={setPhone}
                placeholder="(555) 010-0192"
                placeholderTextColor={colors.placeholderWarm}
                keyboardType="phone-pad"
                onFocus={() => setFocusedField('phone')}
                onBlur={() => setFocusedField(null)}
              />
            </View>

            <View style={styles.fieldGroup}>
              <Text style={styles.label}>Password</Text>
              <View style={[styles.inputRow, pwBorder]}>
                <TextInput
                  style={styles.inputRowInner}
                  value={password}
                  onChangeText={setPassword}
                  placeholder="••••••••"
                  placeholderTextColor={colors.placeholderWarm}
                  secureTextEntry={!showPw}
                  onFocus={() => setFocusedField('password')}
                  onBlur={() => setFocusedField(null)}
                />
                <TouchableOpacity
                  style={styles.eyeBtn}
                  onPress={() => setShowPw(!showPw)}
                  hitSlop={{
                    top: 8,
                    bottom: 8,
                    left: 8,
                    right: 8,
                  }}
                >
                  <Text style={styles.eyeText}>{showPw ? 'Hide' : 'Show'}</Text>
                </TouchableOpacity>
              </View>
              {passwordError ? <FieldError text={passwordError} /> : null}
            </View>
          </View>
        </ScrollView>

        {/* Fixed CTA — disabled gray until valid, then ink pill (matches ref) */}
        <View style={styles.ctaArea}>
          <TouchableOpacity
            style={[styles.ctaButton, !canContinue && styles.ctaButtonDisabled]}
            onPress={handleContinue}
            activeOpacity={0.85}
            disabled={!canContinue}
          >
            <GoldFill radius={27} disabled={!canContinue} />
            {loading ? (
              <ActivityIndicator color={colors.onAccent} />
            ) : (
              <Text style={[styles.ctaText, !canContinue && styles.ctaTextDisabled]}>Continue</Text>
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgApp,
  },
  flex: {
    flex: 1,
  },
  scroll: {
    flexGrow: 1,
    paddingHorizontal: 24,
    paddingBottom: 24,
  },
  header: {
    paddingTop: 4,
    marginBottom: 18,
  },
  backBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontFamily: fonts.displayBold,
    fontSize: 27,
    lineHeight: 34,
    letterSpacing: -0.4,
    fontWeight: '700',
    color: colors.textPrimary,
    marginTop: 4,
    marginBottom: 10,
  },
  subtitle: {
    fontFamily: fonts.body,
    fontSize: 15,
    lineHeight: 22,
    color: colors.textSecondaryWarm,
    marginBottom: 28,
    maxWidth: 600,
  },
  form: {
    gap: 10,
  },
  fieldGroup: {
    gap: 8,
  },
  label: {
    fontFamily: fonts.bodyBold,
    fontSize: 13,
    lineHeight: 13,
    letterSpacing: 0.3,
    color: colors.labelWarm,
    marginBottom: 8,
  },
  input: {
    height: 52,
    backgroundColor: colors.surface,
    borderRadius: radius.card,
    paddingHorizontal: 16,
    fontSize: 16,
    color: colors.textPrimary,
    borderWidth: 1.5,
    borderColor: colors.fieldBorder,
  },
  inputRow: {
    height: 52,
    backgroundColor: colors.surface,
    borderRadius: radius.card,
    borderWidth: 1.5,
    borderColor: colors.fieldBorder,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  inputRowInner: {
    flex: 1,
    fontSize: 16,
    color: colors.textPrimary,
    height: '100%',
  },
  inputFocused: {
    borderColor: colors.goldWarm,
    borderWidth: 2,
  },
  inputError: {
    borderColor: colors.errorWarm,
    borderWidth: 2,
  },
  errorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 8,
  },
  errorText: {
    fontFamily: fonts.bodyMedium,
    fontSize: 13,
    lineHeight: 18,
    color: colors.errorWarm,
  },
  eyeBtn: {
    paddingLeft: 10,
  },
  eyeText: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 13,
    color: colors.textSecondaryWarm,
  },
  ctaArea: {
    paddingHorizontal: 24,
    paddingBottom: 32,
  },
  ctaButton: {
    width: '100%',
    height: 54,
    backgroundColor: colors.gold,
    borderRadius: 27,
    alignItems: 'center',
    justifyContent: 'center',
    ...goldButton.glow,
  },
  ctaButtonDisabled: {
    backgroundColor: colors.btnDisabledBg,
  },
  ctaText: {
    fontFamily: fonts.bodyBold,
    fontSize: 16,
    lineHeight: 16,
    letterSpacing: 0.2,
    color: colors.onAccent,
  },
  ctaTextDisabled: {
    color: colors.btnDisabledText,
  },
});
