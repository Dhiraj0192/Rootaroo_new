import React, { useState, useRef } from 'react';
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
} from 'react-native';
import { showAlert } from '../shared/services/themedAlert';
import { authApi } from '../shared/api/auth';
import { colors, fonts, goldButton, radius } from '../shared/theme';
import { GoldFill } from '../shared/components/GoldButton';
import { KEYBOARD_BEHAVIOR } from '../shared/components/KeyboardAware';
const OTP_LENGTH = 6;
export default function ForgotPasswordScreen({ navigation }) {
  const [step, setStep] = useState('email');
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState(Array(OTP_LENGTH).fill(''));
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [focusedField, setFocusedField] = useState(null);
  const [focusedOtp, setFocusedOtp] = useState(null);
  const otpInputs = useRef([]);

  // ── Handlers ────────────────────────────────────────────

  const handleSendCode = async () => {
    if (!email.trim()) {
      showAlert('Error', 'Please enter your email.');
      return;
    }
    setLoading(true);
    try {
      await authApi.forgotPassword(email.trim());
      setStep('code');
    } catch (e) {
      showAlert('Error', e?.response?.data?.error || e?.message || 'Failed to send code.');
    } finally {
      setLoading(false);
    }
  };
  const handleOtpChange = (text, index) => {
    const digit = text.replace(/\D/g, '').slice(-1);
    const next = [...otp];
    next[index] = digit;
    setOtp(next);
    if (digit && index < OTP_LENGTH - 1) {
      otpInputs.current[index + 1]?.focus();
    }
  };
  const handleOtpKeyPress = (key, index) => {
    if (key === 'Backspace') {
      if (otp[index]) {
        const next = [...otp];
        next[index] = '';
        setOtp(next);
      } else if (index > 0) {
        const next = [...otp];
        next[index - 1] = '';
        setOtp(next);
        otpInputs.current[index - 1]?.focus();
      }
    }
  };
  const handleVerifyCode = async () => {
    if (otp.join('').length !== OTP_LENGTH) {
      showAlert('Error', 'Please enter the full 6-digit code.');
      return;
    }
    setLoading(true);
    try {
      await authApi.checkResetCode(email.trim(), otp.join(''));
      setStep('reset');
    } catch (e) {
      showAlert('Error', e?.response?.data?.error || e?.message || 'Invalid or expired code.');
    } finally {
      setLoading(false);
    }
  };
  const handleReset = async () => {
    if (password.length < 8) {
      showAlert('Error', 'Password must be at least 8 characters.');
      return;
    }
    setLoading(true);
    try {
      await authApi.resetPassword({
        email: email.trim(),
        code: otp.join(''),
        password,
      });
      showAlert('Password updated', 'Sign in with your new password.', [
        {
          text: 'Sign in',
          onPress: () => navigation.navigate('SignIn'),
        },
      ]);
    } catch (e) {
      showAlert('Error', e?.response?.data?.error || e?.message || 'Failed to reset password.');
    } finally {
      setLoading(false);
    }
  };

  // ── Step meta ────────────────────────────────────────────

  const stepMeta = {
    email: {
      heading: 'Reset your password',
      subtitle: "We'll email you a code to get back in.",
    },
    code: {
      heading: 'Check your inbox',
      subtitle: `We sent a 6-digit code to ${email}.`,
    },
    reset: {
      heading: 'Set a new password',
      subtitle: "Make it something you haven't used before.",
    },
  };
  const meta = stepMeta[step];

  // ── Render ───────────────────────────────────────────────

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
          {/* Heading — mockup screen14: no back button / brand header */}
          <Text style={styles.heading}>{meta.heading}</Text>
          <Text style={styles.subtitle}>{meta.subtitle}</Text>

          {/* ── Step: email ─────────────────────────────── */}
          {step === 'email' && (
            <View style={styles.form}>
              <View style={styles.fieldGroup}>
                <Text style={styles.label}>Email</Text>
                <TextInput
                  style={[styles.input, focusedField === 'email' && styles.inputFocused]}
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
            </View>
          )}

          {/* ── Step: code ──────────────────────────────── */}
          {step === 'code' && (
            <View style={styles.form}>
              <View style={styles.otpRow}>
                {otp.map((digit, i) => (
                  <TextInput
                    key={i}
                    ref={(r) => {
                      otpInputs.current[i] = r;
                    }}
                    style={[
                      styles.otpBox,
                      focusedOtp === i && styles.otpBoxFocused,
                      digit ? styles.otpBoxFilled : null,
                    ]}
                    value={digit}
                    onChangeText={(t) => handleOtpChange(t, i)}
                    onKeyPress={({ nativeEvent }) => handleOtpKeyPress(nativeEvent.key, i)}
                    onFocus={() => setFocusedOtp(i)}
                    onBlur={() => setFocusedOtp(null)}
                    keyboardType="number-pad"
                    maxLength={1}
                    selectTextOnFocus
                    caretHidden
                    autoFocus={i === 0}
                  />
                ))}
              </View>
            </View>
          )}

          {/* ── Step: reset ─────────────────────────────── */}
          {step === 'reset' && (
            <View style={styles.form}>
              <View style={styles.fieldGroup}>
                <Text style={styles.label}>New password</Text>
                <View style={[styles.inputRow, focusedField === 'password' && styles.inputFocused]}>
                  <TextInput
                    style={styles.inputRowInner}
                    value={password}
                    onChangeText={setPassword}
                    placeholder="At least 8 characters"
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

              <TouchableOpacity
                style={styles.resendBtn}
                onPress={() => setStep('code')}
                hitSlop={{
                  top: 8,
                  bottom: 8,
                  left: 8,
                  right: 8,
                }}
              >
                <Text style={styles.resendText}>
                  Wrong code? <Text style={styles.resendLink}>Re-enter it</Text>
                </Text>
              </TouchableOpacity>
            </View>
          )}

          {/* CTA pinned to bottom */}
          <View style={styles.footer}>
            {step === 'email' && (
              <TouchableOpacity
                style={[styles.primaryBtn, loading && styles.primaryBtnDisabled]}
                onPress={handleSendCode}
                activeOpacity={0.85}
                disabled={loading}
              >
                <GoldFill radius={27} disabled={loading} />
                {loading ? (
                  <ActivityIndicator color={colors.onAccent} />
                ) : (
                  <Text style={styles.primaryText}>Send code</Text>
                )}
              </TouchableOpacity>
            )}

            {step === 'code' && (
              <>
                <TouchableOpacity
                  style={[
                    styles.primaryBtn,
                    (otp.join('').length < OTP_LENGTH || loading) && styles.primaryBtnDisabled,
                  ]}
                  onPress={handleVerifyCode}
                  activeOpacity={0.85}
                  disabled={otp.join('').length < OTP_LENGTH || loading}
                >
                  <GoldFill radius={27} disabled={otp.join('').length < OTP_LENGTH || loading} />
                  {loading ? (
                    <ActivityIndicator color={colors.onAccent} />
                  ) : (
                    <Text style={styles.primaryText}>Verify code</Text>
                  )}
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.resendBtn}
                  onPress={handleSendCode}
                  disabled={loading}
                >
                  <Text style={styles.resendText}>
                    Didn't receive it? <Text style={styles.resendLink}>Resend code</Text>
                  </Text>
                </TouchableOpacity>
              </>
            )}

            {step === 'reset' && (
              <TouchableOpacity
                style={[styles.primaryBtn, loading && styles.primaryBtnDisabled]}
                onPress={handleReset}
                activeOpacity={0.85}
                disabled={loading}
              >
                <GoldFill radius={27} disabled={loading} />
                {loading ? (
                  <ActivityIndicator color={colors.onAccent} />
                ) : (
                  <Text style={styles.primaryText}>Update password</Text>
                )}
              </TouchableOpacity>
            )}
          </View>

          {/* Back to sign in */}
          <TouchableOpacity
            style={styles.backToSignIn}
            onPress={() => navigation.navigate('SignIn')}
            hitSlop={{
              top: 8,
              bottom: 8,
              left: 8,
              right: 8,
            }}
          >
            <Text style={styles.backToSignInText}>Back to sign in</Text>
          </TouchableOpacity>
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
  // Heading — mockup screen14: title 25px w700, mt 4, mb 10
  heading: {
    fontFamily: fonts.displayBold,
    fontSize: 25,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: 8,
    letterSpacing: -0.4,
    marginTop: 4,
  },
  subtitle: {
    fontFamily: fonts.body,
    fontSize: 14.5,
    color: colors.textSecondaryWarm,
    lineHeight: 21,
    marginBottom: 28,
  },
  // Form
  form: {
    width: '100%',
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
  // Password row
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
  // OTP boxes
  otpRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 28,
  },
  otpBox: {
    flex: 1,
    height: 56,
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: colors.fieldBorder,
    textAlign: 'center',
    fontSize: 22,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  otpBoxFocused: {
    borderColor: colors.goldWarm,
    borderWidth: 2,
  },
  otpBoxFilled: {
    borderColor: colors.goldWarm,
    borderWidth: 2,
    backgroundColor: colors.goldTint,
  },
  // Resend
  resendBtn: {
    alignItems: 'center',
    paddingVertical: 8,
    marginTop: 4,
  },
  resendText: {
    fontFamily: fonts.body,
    fontSize: 13,
    color: colors.textSecondaryWarm,
  },
  resendLink: {
    fontFamily: fonts.bodySemiBold,
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
    marginBottom: 16,
    ...goldButton.glow,
  },
  primaryBtnDisabled: {
    opacity: 0.45,
  },
  primaryText: {
    fontFamily: fonts.bodyBold,
    fontSize: 16,
    fontWeight: '700',
    color: colors.onAccent,
    letterSpacing: 0.2,
  },
  // Back to sign in — mockup .link-center: centered 14px w600 gold-dark, mt 16
  backToSignIn: {
    alignItems: 'center',
    paddingVertical: 6,
    marginTop: 16,
  },
  backToSignInText: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 14,
    fontWeight: '600',
    color: colors.goldWarmDark,
  },
});
