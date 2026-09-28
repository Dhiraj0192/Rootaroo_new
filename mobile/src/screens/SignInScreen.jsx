import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  StatusBar,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  ActivityIndicator,
  Image,
} from 'react-native';
import { showAlert } from '../shared/services/themedAlert';
import Svg, { Path } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuthStore } from '../shared/store/authStore';
import { authApi, storePendingAuthResponse } from '../shared/api/auth';
import { loadMyHousehold } from '../shared/api/household';
import { useGoogleSignIn } from '../shared/hooks/useGoogleSignIn';
import { useAppleSignIn } from '../shared/hooks/useAppleSignIn';
import { resolvePostAuthNavigation } from '../shared/navigation/postAuthNavigation';
import { loadSignupProgress } from '../shared/store/signupProgress';
import { colors, fonts, goldButton, radius, withAlpha } from '../shared/theme';
import { GoldFill } from '../shared/components/GoldButton';
import SpinningIcon from '../components/SpinningIcon';
import { KEYBOARD_BEHAVIOR } from '../shared/components/KeyboardAware';
function SvgApple() {
  return (
    <Svg width="19" height="19" viewBox="0 0 24 24" fill={colors.onAccent}>
      <Path d="M17.05 12.54c-.03-2.56 2.09-3.79 2.18-3.85-1.19-1.74-3.04-1.98-3.7-2.01-1.58-.16-3.08.93-3.88.93-.8 0-2.03-.91-3.34-.88-1.72.02-3.3 1-4.19 2.54-1.79 3.1-.46 7.69 1.28 10.2.85 1.23 1.87 2.61 3.2 2.56 1.28-.05 1.77-.83 3.32-.83s1.99.83 3.35.8c1.38-.02 2.26-1.25 3.1-2.49.98-1.43 1.38-2.81 1.4-2.88-.03-.01-2.67-1.03-2.72-4.09zM14.37 4.9c.7-.85 1.18-2.03 1.05-3.21-1.02.04-2.25.68-2.98 1.53-.65.76-1.23 1.97-1.07 3.14 1.13.09 2.29-.58 3-1.46z" />
    </Svg>
  );
}
export default function SignInScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [focusedField, setFocusedField] = useState(null);
  const { signIn: googleSignIn, isLoading: googleLoading } = useGoogleSignIn(async (resp) => {
    const progress = await loadSignupProgress();
    await resolvePostAuthNavigation(resp, 'google', navigation, progress);
  });
  const { signIn: appleSignIn, isLoading: appleLoading } = useAppleSignIn(async (resp) => {
    const progress = await loadSignupProgress();
    await resolvePostAuthNavigation(resp, 'apple', navigation, progress);
  });
  const handleSignIn = async () => {
    if (!email.trim()) {
      showAlert('Error', 'Please enter your email.');
      return;
    }
    if (!password) {
      showAlert('Error', 'Please enter your password.');
      return;
    }
    setLoading(true);
    try {
      const resp = await authApi.login({
        email: email.trim(),
        password,
      });
      storePendingAuthResponse(resp);
      await loadMyHousehold();
      const hasHousehold = !!useAuthStore.getState().householdId;
      if (hasHousehold) {
        // Returning user → straight into the app, no welcome screen
        useAuthStore.getState().completeSetup();
      } else {
        // Returning user missing household — skip profile wizard
        navigation.replace('HouseholdSetup');
      }
    } catch (e) {
      const msg = e?.response?.data?.error || e?.message || 'Login failed.';
      showAlert('Sign In Error', msg);
    } finally {
      setLoading(false);
    }
  };
  const inputStyle = (field) => [styles.input, focusedField === field && styles.inputFocused];
  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor={colors.bgApp} />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={KEYBOARD_BEHAVIOR}
      >
        <ScrollView
          contentContainerStyle={[
            styles.scroll,
            {
              paddingBottom: Math.max(insets.bottom, 16) + 24,
            },
          ]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <Text style={styles.heading}>Welcome back</Text>

          {/* Continue with Google — full pill (kept: live feature) */}
          <TouchableOpacity
            style={styles.socialBtn}
            activeOpacity={0.75}
            onPress={googleSignIn}
            disabled={googleLoading}
          >
            {googleLoading ? (
              <SpinningIcon source={require('../../assets/images/google-g.png')} size={19} />
            ) : (
              <>
                <Image
                  source={require('../../assets/images/google-g.png')}
                  style={styles.gLogo}
                  resizeMode="contain"
                />
                <Text style={styles.socialBtnText}>Continue with Google</Text>
              </>
            )}
          </TouchableOpacity>

          {/* Continue with Apple — full pill, iOS only */}
          {Platform.OS === 'ios' && (
            <TouchableOpacity
              style={[styles.socialBtn, styles.socialBtnApple]}
              activeOpacity={0.75}
              onPress={appleSignIn}
              disabled={appleLoading}
            >
              {appleLoading ? (
                <ActivityIndicator color={colors.onAccent} size="small" />
              ) : (
                <>
                  <SvgApple />
                  <Text style={[styles.socialBtnText, styles.socialBtnTextApple]}>
                    Continue with Apple
                  </Text>
                </>
              )}
            </TouchableOpacity>
          )}

          {/* Continue with phone number — full pill */}
          <TouchableOpacity
            style={[styles.socialBtn, styles.socialBtnPhone]}
            activeOpacity={0.75}
            onPress={() => navigation.navigate('PhoneSignUp')}
          >
            <Text style={styles.socialBtnIcon}>📱</Text>
            <Text style={styles.socialBtnText}>Continue with phone number</Text>
          </TouchableOpacity>

          {/* Divider */}
          <View style={styles.divider}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerText}>or sign in with email</Text>
            <View style={styles.dividerLine} />
          </View>

          {/* Form */}
          <View style={styles.form}>
            {/* Email */}
            <View style={styles.fieldGroup}>
              <Text style={styles.label}>Email</Text>
              <TextInput
                style={inputStyle('email')}
                value={email}
                onChangeText={setEmail}
                placeholder="sarah@example.com"
                placeholderTextColor={colors.placeholderWarm}
                autoCapitalize="none"
                keyboardType="email-address"
                autoCorrect={false}
                onFocus={() => setFocusedField('email')}
                onBlur={() => setFocusedField(null)}
              />
            </View>

            {/* Password */}
            <View style={styles.fieldGroup}>
              <Text style={styles.label}>Password</Text>
              <View style={[styles.inputRow, focusedField === 'password' && styles.inputFocused]}>
                <TextInput
                  style={styles.inputRowInner}
                  value={password}
                  onChangeText={setPassword}
                  placeholder="Your password"
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
            </View>
          </View>

          {/* Forgot password — right-aligned link */}
          <TouchableOpacity
            style={styles.forgotRow}
            onPress={() => navigation.navigate('ForgotPassword')}
            hitSlop={{
              top: 8,
              bottom: 8,
              left: 8,
              right: 8,
            }}
          >
            <Text style={styles.forgotText}>Forgot password?</Text>
          </TouchableOpacity>

          {/* CTA + link pinned to bottom */}
          <View style={styles.footer}>
            <TouchableOpacity
              style={[styles.primaryBtn, loading && styles.primaryBtnDisabled]}
              onPress={handleSignIn}
              activeOpacity={0.85}
              disabled={loading}
            >
              <GoldFill radius={27} disabled={loading} />
              {loading ? (
                <ActivityIndicator color={colors.onAccent} />
              ) : (
                <Text style={styles.primaryText}>Sign in</Text>
              )}
            </TouchableOpacity>

            <View style={styles.bottomLink}>
              <Text style={styles.linkMuted}>New here? </Text>
              <TouchableOpacity
                onPress={() => navigation.navigate('ChooseMethod')}
                hitSlop={{
                  top: 8,
                  bottom: 8,
                  left: 4,
                  right: 4,
                }}
              >
                <Text style={styles.linkBold}>Create account</Text>
              </TouchableOpacity>
            </View>
          </View>
        </ScrollView>
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
    paddingTop: Platform.OS === 'ios' ? 52 : 36,
    paddingHorizontal: 22,
    paddingBottom: 36,
  },
  footer: {
    marginTop: 'auto',
    paddingTop: 24,
  },
  // Heading — mockup screen13: 25px w700, margin-top ~20px, no brand header
  heading: {
    fontFamily: fonts.displayBold,
    fontSize: 25,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: 24,
    letterSpacing: -0.4,
    marginTop: 20,
  },
  // Google button — full width pill
  socialBtn: {
    width: '100%',
    height: 52,
    backgroundColor: colors.surface,
    borderWidth: 1.5,
    borderColor: colors.fieldBorder,
    borderRadius: 26,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    marginBottom: 16,
  },
  gLogo: {
    width: 19,
    height: 19,
  },
  socialBtnText: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 14,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  // Apple button — dark pill (Apple brand style)
  socialBtnApple: {
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.textPrimary,
  },
  socialBtnTextApple: {
    color: colors.onAccent,
  },
  socialBtnPhone: {
    marginBottom: 6,
  },
  socialBtnIcon: {
    fontSize: 17,
  },
  // Divider
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    marginBottom: 16,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: withAlpha(colors.textPrimary, 0.12),
  },
  dividerText: {
    fontFamily: fonts.body,
    fontSize: 11,
    color: colors.textSecondaryWarm,
  },
  // Form
  form: {
    gap: 12,
  },
  fieldGroup: {
    gap: 8,
  },
  label: {
    fontFamily: fonts.bodyBold,
    fontSize: 12.5,
    fontWeight: '700',
    letterSpacing: 0.3,
    color: colors.labelWarm,
  },
  // Forgot password — right-aligned link
  forgotRow: {
    alignSelf: 'flex-end',
    marginTop: 2,
  },
  forgotText: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 13,
    fontWeight: '600',
    color: colors.avatarNavy,
  },
  // Standard input
  input: {
    height: 52,
    backgroundColor: colors.surface,
    borderRadius: radius.card,
    borderWidth: 1.5,
    borderColor: colors.fieldBorder,
    paddingHorizontal: 16,
    fontSize: 16,
    color: colors.textPrimary,
  },
  inputFocused: {
    borderColor: colors.goldWarm,
    borderWidth: 2,
  },
  // Password row with show/hide
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
  eyeBtn: {
    paddingLeft: 8,
  },
  eyeText: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 12.5,
    fontWeight: '600',
    color: colors.goldWarmDark,
  },
  // CTA — full pill
  primaryBtn: {
    height: 54,
    backgroundColor: colors.gold,
    borderRadius: 27,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
    ...goldButton.glow,
  },
  primaryBtnDisabled: {
    opacity: 0.7,
  },
  primaryText: {
    fontFamily: fonts.bodyBold,
    fontSize: 16,
    fontWeight: '700',
    color: colors.onAccent,
    letterSpacing: 0.2,
  },
  // Bottom link
  bottomLink: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  linkMuted: {
    fontFamily: fonts.body,
    fontSize: 13,
    color: colors.textSecondaryWarm,
  },
  linkBold: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 13,
    fontWeight: '600',
    color: colors.textPrimary,
  },
});
