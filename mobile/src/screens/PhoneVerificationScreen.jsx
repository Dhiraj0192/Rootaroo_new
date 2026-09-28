import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  StatusBar,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { showAlert } from '../shared/services/themedAlert';
import Svg, { Path } from 'react-native-svg';
import { authApi } from '../shared/api/auth';
import { useAuthStore } from '../shared/store/authStore';
import { loadSignupProgress } from '../shared/store/signupProgress';
import { resolvePostAuthNavigation } from '../shared/navigation/postAuthNavigation';
import { colors, fonts, goldButton, radius } from '../shared/theme';
import { GoldFill } from '../shared/components/GoldButton';
import { KeyboardAwareScrollView } from '../shared/components/KeyboardAware';
const OTP_LENGTH = 6;
const RESEND_COOLDOWN = 30; // seconds

export default function PhoneVerificationScreen({ navigation, route }) {
  const phone = route.params?.phone ?? 'your number';
  const devCode = route.params?.code;
  const [otp, setOtp] = useState(() => {
    if (devCode) {
      const digits = devCode.split('').slice(0, OTP_LENGTH);
      while (digits.length < OTP_LENGTH) digits.push('');
      return digits;
    }
    return Array(OTP_LENGTH).fill('');
  });
  const [verifying, setVerifying] = useState(false);
  const [resending, setResending] = useState(false);
  const [countdown, setCountdown] = useState(RESEND_COOLDOWN);
  const [focusedIndex, setFocusedIndex] = useState(null);
  const [invalid, setInvalid] = useState(false);
  const inputs = useRef([]);

  // Countdown timer
  useEffect(() => {
    if (countdown <= 0) return;
    const id = setInterval(() => setCountdown((c) => c - 1), 1000);
    return () => clearInterval(id);
  }, [countdown]);
  const verifyOtp = async (code) => {
    if (code.length !== OTP_LENGTH) return;
    setVerifying(true);
    try {
      const resp = await authApi.verifyPhoneOtp({
        phone,
        code,
      });
      // Wizard-completion case (household already exists by now) routes
      // straight home with a celebration; a genuinely new number reaching
      // this screen via Sign In's phone entry (no household yet) instead
      // routes into the signup wizard to finish onboarding.
      const progress = await loadSignupProgress();
      const result = await resolvePostAuthNavigation(resp, 'phone', navigation, progress);
      if (result === 'home') {
        useAuthStore.getState().triggerCelebration();
        useAuthStore.getState().triggerTour();
      }
    } catch (e) {
      setInvalid(true); // mockup screen10c: red boxes + inline error
      showAlert('Error', e?.response?.data?.error || e?.message || 'Invalid code');
    } finally {
      setVerifying(false);
    }
  };
  const handleChange = useCallback(
    (text, index) => {
      const digit = text.replace(/\D/g, '').slice(-1);
      const next = [...otp];
      next[index] = digit;
      setOtp(next);
      setInvalid(false);
      if (digit && index < OTP_LENGTH - 1) {
        inputs.current[index + 1]?.focus();
      }
      if (digit && index === OTP_LENGTH - 1) {
        const full = [...next].join('');
        if (full.length === OTP_LENGTH) verifyOtp(full);
      }
    },
    [otp],
  );
  const handleKeyPress = useCallback(
    (key, index) => {
      if (key === 'Backspace') {
        if (otp[index]) {
          const next = [...otp];
          next[index] = '';
          setOtp(next);
          setInvalid(false);
        } else if (index > 0) {
          const next = [...otp];
          next[index - 1] = '';
          setOtp(next);
          setInvalid(false);
          inputs.current[index - 1]?.focus();
        }
      }
    },
    [otp],
  );
  const handleVerifyPress = () => {
    verifyOtp(otp.join(''));
  };
  const handleResend = async () => {
    if (countdown > 0) return;
    setResending(true);
    try {
      const sent = await authApi.sendPhoneOtp(phone);
      setOtp(Array(OTP_LENGTH).fill(''));
      setInvalid(false);
      setCountdown(RESEND_COOLDOWN);
      inputs.current[0]?.focus();
      showAlert(
        'Code sent',
        sent.code ? `Dev code: ${sent.code}` : `A new OTP has been sent to ${phone}.`,
      );
    } catch (e) {
      showAlert('Error', e?.response?.data?.error || 'Failed to resend');
    } finally {
      setResending(false);
    }
  };
  const otpFilled = otp.every((d) => d !== '');
  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor={colors.bgApp} />
      <KeyboardAwareScrollView contentContainerStyle={styles.inner}>
          {/* Top bar: back chevron + 7-segment progress */}
          <View style={styles.topbar}>
            <TouchableOpacity
              style={styles.backBtn}
              onPress={() => {
                if (navigation.canGoBack?.()) {
                  navigation.goBack();
                } else {
                  navigation.replace('PhoneSignUp');
                }
              }}
              hitSlop={{
                top: 10,
                bottom: 10,
                left: 10,
                right: 10,
              }}
            >
              <Svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                <Path
                  d="M15 5l-7 7 7 7"
                  stroke={colors.textPrimary}
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </Svg>
            </TouchableOpacity>
            {/* Phone flow = 2 steps: number → verify */}
            <View style={styles.progress}>
              {Array.from({
                length: 2,
              }).map((_, i) => (
                <View key={i} style={[styles.seg, i < 2 && styles.segOn]} />
              ))}
            </View>
          </View>

          {/* Verifying state — mockup screen10b */}
          {verifying ? (
            <View style={styles.verifyCenter}>
              <View style={styles.spinner} />
              <Text style={styles.verifyText}>Verifying your code…</Text>
            </View>
          ) : (
            <>
              {/* Heading */}
              <Text style={styles.heading}>Check your messages</Text>
              <Text style={styles.subtitle}>
                We sent a 6-digit code to{'\n'}
                <Text style={styles.phoneHighlight}>{phone}</Text>
              </Text>

              {/* OTP boxes */}
              <View style={styles.otpRow}>
                {otp.map((digit, i) => (
                  <TextInput
                    key={i}
                    ref={(r) => {
                      inputs.current[i] = r;
                    }}
                    style={[
                      styles.otpBox,
                      focusedIndex === i && styles.otpBoxFocused,
                      digit ? styles.otpBoxFilled : null,
                      invalid && styles.otpBoxError,
                    ]}
                    value={digit}
                    onChangeText={(t) => handleChange(t, i)}
                    onKeyPress={({ nativeEvent }) => handleKeyPress(nativeEvent.key, i)}
                    onFocus={() => setFocusedIndex(i)}
                    onBlur={() => setFocusedIndex(null)}
                    keyboardType="number-pad"
                    maxLength={1}
                    selectTextOnFocus
                    caretHidden
                    autoFocus={i === 0}
                  />
                ))}
              </View>

              {/* Inline error — mockup screen10c */}
              {invalid && (
                <Text style={styles.errorText}>That code didn't work. Please try again.</Text>
              )}

              {/* Resend */}
              <View style={styles.resendRow}>
                {resending ? (
                  <ActivityIndicator size="small" color={colors.goldWarm} />
                ) : countdown > 0 ? (
                  <Text style={styles.resendCooldown}>
                    Resend code in <Text style={styles.resendCooldownNum}>{countdown}s</Text>
                  </Text>
                ) : (
                  <TouchableOpacity
                    onPress={handleResend}
                    hitSlop={{
                      top: 8,
                      bottom: 8,
                    }}
                  >
                    <Text style={styles.resendLink}>Resend code</Text>
                  </TouchableOpacity>
                )}
              </View>

              {/* CTA pinned to bottom */}
              <View style={styles.footer}>
                <TouchableOpacity
                  style={[
                    styles.primaryBtn,
                    (!otpFilled || verifying) && styles.primaryBtnDisabled,
                  ]}
                  onPress={handleVerifyPress}
                  activeOpacity={0.85}
                  disabled={!otpFilled || verifying}
                >
                  <GoldFill radius={27} disabled={!otpFilled || verifying} />
                  <Text style={styles.primaryText}>Verify number</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.changeBtn}
                  onPress={() => {
                    if (navigation.canGoBack?.()) {
                      navigation.goBack();
                    } else {
                      navigation.replace('SignupStepAddress');
                    }
                  }}
                  hitSlop={{
                    top: 8,
                    bottom: 8,
                    left: 8,
                    right: 8,
                  }}
                >
                  <Text style={styles.changeText}>Change number</Text>
                </TouchableOpacity>
              </View>
            </>
          )}
      </KeyboardAwareScrollView>
    </View>
  );
}
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgApp,
  },
  inner: {
    flexGrow: 1,
    paddingTop: Platform.OS === 'ios' ? 52 : 36,
    paddingHorizontal: 24,
    paddingBottom: 36,
  },
  topbar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 22,
  },
  backBtn: {
    width: 32,
    height: 32,
    minWidth: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  progress: {
    flex: 1,
    flexDirection: 'row',
    gap: 6,
  },
  seg: {
    flex: 1,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.surfaceDark,
  },
  segOn: {
    backgroundColor: colors.surfaceRaised,
  },
  // Verifying state
  verifyCenter: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 22,
  },
  spinner: {
    width: 48,
    height: 48,
    borderRadius: 25,
    borderWidth: 4,
    borderColor: colors.sandMuted,
    borderTopColor: colors.goldWarm,
  },
  verifyText: {
    fontFamily: fonts.bodyMedium,
    fontSize: 15,
    fontWeight: '500',
    color: colors.textSecondaryWarm,
  },
  // Heading
  heading: {
    fontFamily: fonts.displayBold,
    fontSize: 25,
    lineHeight: 32,
    fontWeight: '700',
    letterSpacing: -0.4,
    color: colors.textPrimary,
    textAlign: 'center',
    marginTop: 4,
    marginBottom: 10,
  },
  subtitle: {
    fontFamily: fonts.body,
    fontSize: 14.5,
    lineHeight: 21,
    color: colors.textSecondaryWarm,
    textAlign: 'center',
    marginBottom: 26,
    maxWidth: 310,
    alignSelf: 'center',
  },
  phoneHighlight: {
    fontWeight: '600',
    color: colors.textPrimary,
  },
  // OTP boxes — mockup: 52x58, r14, 1.5px border, filled = gold border
  otpRow: {
    flexDirection: 'row',
    gap: 10,
    marginVertical: 8,
    marginBottom: 18,
    justifyContent: 'center',
  },
  otpBox: {
    width: 52,
    height: 58,
    backgroundColor: colors.surface,
    borderRadius: radius.card,
    borderWidth: 1.5,
    borderColor: colors.fieldBorder,
    textAlign: 'center',
    fontSize: 20,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  otpBoxFocused: {
    borderColor: colors.goldWarm,
    borderWidth: 2,
  },
  otpBoxFilled: {
    borderColor: colors.goldWarm,
  },
  otpBoxError: {
    borderColor: colors.errorWarm,
    borderWidth: 2,
  },
  errorText: {
    fontFamily: fonts.body,
    fontSize: 13.5,
    fontWeight: '600',
    color: colors.errorWarm,
    textAlign: 'center',
    marginTop: -6,
    marginBottom: 16,
  },
  // Resend
  resendRow: {
    alignItems: 'center',
    minHeight: 22,
  },
  resendCooldown: {
    fontFamily: fonts.body,
    fontSize: 13.5,
    color: colors.textSecondaryWarm,
  },
  resendCooldownNum: {
    fontFamily: fonts.bodySemiBold,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  resendLink: {
    fontFamily: fonts.bodyBold,
    fontSize: 13.5,
    fontWeight: '700',
    color: colors.textPrimary,
    textDecorationLine: 'underline',
  },
  // CTA
  footer: {
    marginTop: 'auto',
    paddingTop: 24,
  },
  primaryBtn: {
    height: 54,
    borderRadius: 27,
    backgroundColor: colors.gold,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
    ...goldButton.glow,
  },
  primaryBtnDisabled: {
    backgroundColor: colors.btnDisabledBg,
  },
  primaryText: {
    fontFamily: fonts.bodyBold,
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 0.2,
    color: goldButton.onGold,
  },
  // Change number
  changeBtn: {
    alignItems: 'center',
  },
  changeText: {
    fontFamily: fonts.bodyMedium,
    fontSize: 13,
    color: colors.textSecondaryWarm,
    fontWeight: '500',
  },
});
