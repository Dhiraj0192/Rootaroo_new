import React, { useState } from 'react';
import { View, Text, StyleSheet, StatusBar, TouchableOpacity, Image, Platform } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';
import { colors, fonts, radius } from '../shared/theme';
import {
  startPhoneSignupProgress,
  resolvePostAuthNavigation,
} from '../shared/navigation/postAuthNavigation';
import { loadSignupProgress } from '../shared/store/signupProgress';
import { useGoogleSignIn } from '../shared/hooks/useGoogleSignIn';
import { useAppleSignIn } from '../shared/hooks/useAppleSignIn';
import SpinningIcon from '../components/SpinningIcon';
import { Ionicons } from '@expo/vector-icons';
import * as WebBrowser from 'expo-web-browser';
import { TERMS_URL, PRIVACY_URL } from '../shared/billing/legalLinks';
/* Small inline icons (stroke = ink, like the mockup) */
function PhoneIcon() {
  return (
    <Svg width="16" height="16" viewBox="0 0 24 24" fill="none">
      <Rect x="7" y="2" width="10" height="20" rx="2" stroke={colors.ink} strokeWidth="1.6" />
      <Path d="M11 19h2" stroke={colors.ink} strokeWidth="1.6" strokeLinecap="round" />
    </Svg>
  );
}
function MailIcon() {
  return (
    <Svg width="16" height="16" viewBox="0 0 24 24" fill="none">
      <Rect x="3" y="5" width="18" height="14" rx="2" stroke={colors.ink} strokeWidth="1.6" />
      <Path d="M3 7l9 6 9-6" stroke={colors.ink} strokeWidth="1.6" strokeLinejoin="round" />
    </Svg>
  );
}
function AppleIcon() {
  return (
    <Svg width="16" height="16" viewBox="0 0 24 24" fill={colors.onAccent}>
      <Path d="M16.5 1.5c0 1-.4 2-1 2.7-.7.8-1.8 1.4-2.8 1.3-.1-1 .4-2 1-2.7.7-.8 1.9-1.4 2.8-1.3zM20.6 17c-.6 1.3-1.3 2.6-2.3 3.8-.9 1.1-1.9 2.2-3.3 2.2-1.3 0-1.8-.8-3.3-.8s-2 .8-3.3.8c-1.3 0-2.4-1.2-3.3-2.3-1.8-2.2-3.2-6.2-1.3-9 .9-1.4 2.5-2.3 4.2-2.3 1.3 0 2.5.9 3.3.9.8 0 2.2-1.1 3.8-.9.6 0 2.5.3 3.7 2-3.2 1.8-2.7 6 .8 6.6z" />
    </Svg>
  );
}
function GoogleChip() {
  return (
    <Image
      source={require('../../assets/images/google-g.png')}
      style={{
        width: 18,
        height: 18,
        borderRadius: 4,
      }}
    />
  );
}
export default function ChooseMethodScreen({ navigation }) {
  const { signIn: googleSignIn, isLoading: googleLoading } = useGoogleSignIn(async (resp) => {
    const progress = await loadSignupProgress();
    await resolvePostAuthNavigation(resp, 'google', navigation, progress);
  });
  const { signIn: appleSignIn, isLoading: appleLoading } = useAppleSignIn(async (resp) => {
    const progress = await loadSignupProgress();
    await resolvePostAuthNavigation(resp, 'apple', navigation, progress);
  });
  const [agreed, setAgreed] = useState(false);
  const [showAgreeError, setShowAgreeError] = useState(false);
  // Every way of creating an account needs the Terms accepted first.
  const requireAgreement = (fn) => () => {
    if (!agreed) {
      setShowAgreeError(true);
      return;
    }
    fn();
  };
  const toggleAgreed = () => {
    setAgreed((v) => !v);
    setShowAgreeError(false);
  };
  const handlePhone = async () => {
    try {
      await startPhoneSignupProgress();
      navigation.navigate('SignupStepName');
    } catch (e) {
      // Surface minimal error; flow continues to the step screen anyway.
      navigation.navigate('SignupStepName');
    }
  };
  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor={colors.canvas} />

      {/* Header: back chevron only (matches ref image) */}
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
          <Svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <Path
              d="M15 5l-7 7 7 7"
              stroke={colors.ink}
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </Svg>
        </TouchableOpacity>
      </View>

      {/* Title */}
      <View style={styles.body}>
        <Text style={styles.title}>Create your account</Text>
        <Text style={styles.subtitle}>Choose how you'd like to get started.</Text>

        {/* Method buttons */}
        <View style={styles.methods}>
          <TouchableOpacity
            style={[styles.methodBtn, styles.methodBtnLight]}
            activeOpacity={0.8}
            onPress={requireAgreement(() => googleSignIn())}
            disabled={googleLoading}
          >
            {googleLoading ? (
              <SpinningIcon source={require('../../assets/images/google-g.png')} size={18} />
            ) : (
              <>
                <GoogleChip />
                <Text style={styles.methodTextLight}>Continue with Google</Text>
              </>
            )}
          </TouchableOpacity>

          {Platform.OS === 'ios' && (
            <TouchableOpacity
              style={[styles.methodBtn, styles.methodBtnDark]}
              activeOpacity={0.85}
              onPress={requireAgreement(() => appleSignIn())}
              disabled={appleLoading}
            >
              <AppleIcon />
              <Text style={styles.methodTextDark}>Continue with Apple</Text>
            </TouchableOpacity>
          )}

          <TouchableOpacity
            style={[styles.methodBtn, styles.methodBtnLight]}
            activeOpacity={0.8}
            onPress={requireAgreement(handlePhone)}
          >
            <PhoneIcon />
            <Text style={styles.methodTextLight}>Continue with Phone</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.methodBtn, styles.methodBtnLight]}
            activeOpacity={0.8}
            onPress={requireAgreement(() => navigation.navigate('SignUp'))}
          >
            <MailIcon />
            <Text style={styles.methodTextLight}>Continue with Email</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.agreeRow}>
          <TouchableOpacity
            onPress={toggleAgreed}
            style={styles.checkbox}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: agreed }}
            accessibilityLabel="I agree to the Terms of Service and Privacy Policy"
          >
            <Ionicons
              name={agreed ? 'checkbox' : 'square-outline'}
              size={24}
              color={agreed ? colors.gold : showAgreeError ? colors.danger : colors.textSecondary}
            />
          </TouchableOpacity>
          <Text style={styles.agreeText}>
            <Text onPress={toggleAgreed}>I agree to the </Text>
            <Text style={styles.agreeLink} onPress={() => WebBrowser.openBrowserAsync(TERMS_URL)} accessibilityRole="link">
              Terms of Service
            </Text>
            <Text onPress={toggleAgreed}> and </Text>
            <Text style={styles.agreeLink} onPress={() => WebBrowser.openBrowserAsync(PRIVACY_URL)} accessibilityRole="link">
              Privacy Policy
            </Text>
          </Text>
        </View>
        {showAgreeError ? (
          <Text style={styles.agreeError} accessibilityLiveRegion="polite">
            Please agree to the Terms and Privacy Policy to continue.
          </Text>
        ) : null}
      </View>
    </View>
  );
}
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.canvas,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 28,
    paddingTop: 16,
    marginBottom: 0,
  },
  backBtn: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: {
    flex: 1,
    paddingHorizontal: 28,
    paddingTop: 20,
  },
  title: {
    fontFamily: fonts.displayBold,
    fontSize: 24,
    lineHeight: 31.2,
    fontWeight: '700',
    color: colors.ink,
    marginBottom: 8,
  },
  subtitle: {
    fontFamily: fonts.body,
    fontSize: 14,
    lineHeight: 21,
    color: colors.textSecondary,
    marginBottom: 28,
  },
  active: {
    transform: [
      {
        scale: 0.97,
      },
    ],
  },
  methods: {
    gap: 14,
  },
  agreeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginTop: 24,
  },
  checkbox: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  agreeText: {
    flex: 1,
    fontFamily: fonts.body,
    fontSize: 13.5,
    lineHeight: 20,
    color: colors.textSecondary,
  },
  agreeLink: {
    color: colors.gold,
    fontFamily: fonts.bodySemiBold,
  },
  agreeError: {
    marginTop: 10,
    fontFamily: fonts.body,
    fontSize: 13,
    color: colors.danger,
  },
  methodBtn: {
    height: 54,
    borderRadius: radius.pill,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  methodBtnLight: {
    backgroundColor: colors.surface,
    borderWidth: 1.5,
    borderColor: colors.border,
  },
  methodBtnDark: {
    backgroundColor: colors.surfaceRaised,
  },
  methodTextLight: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 15,
    lineHeight: 15,
    color: colors.ink,
  },
  methodTextDark: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 15,
    lineHeight: 15,
    color: colors.onAccent,
  },
});
