import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StatusBar,
} from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, fonts, goldButton } from '../../shared/theme';
import { KEYBOARD_BEHAVIOR } from './KeyboardAware';
import { GoldFill } from './GoldButton';

/**
 * Auth wizard shell — matches design/auth-designs/screen05..11 (rootaro signup).
 * Top bar: back chevron + 7-segment progress (filled = ink token, rest = track/border token).
 * Title 25px, subtitle 14.5px, gold active inputs, gold pill CTA.
 */
export default function SignupWizardShell({
  step,
  totalSteps = 8,
  stepName,
  title,
  subtitle,
  onBack,
  onContinue,
  continueLabel = 'Continue',
  continueDisabled,
  loading,
  children,
}) {
  const insets = useSafeAreaInsets();

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor={colors.bgApp} />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={KEYBOARD_BEHAVIOR}
      >
        <ScrollView
          contentContainerStyle={[
            styles.scroll,
            {
              paddingTop: insets.top + (Platform.OS === 'ios' ? 8 : 16),
              paddingBottom: Math.max(insets.bottom, 16) + 12,
            },
          ]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Top bar: back chevron + 7-segment progress */}
          <View style={styles.topbar}>
            {onBack ? (
              <TouchableOpacity
                onPress={onBack}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                style={styles.backBtn}
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
            ) : (
              <View style={styles.backBtn} />
            )}
            <View style={styles.progress}>
              {Array.from({ length: totalSteps }).map((_, i) => (
                <View key={i} style={[styles.seg, i < step && styles.segOn]} />
              ))}
            </View>
          </View>

          <View style={{paddingHorizontal: 10}}><Text style={styles.heading}>{title}</Text>
          {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}

          <View style={styles.body}>{children}</View>

          </View>
          <View style={styles.footer}>
            <TouchableOpacity
              style={[styles.cta, (continueDisabled || loading) && styles.ctaOff]}
              onPress={onContinue}
              disabled={continueDisabled || loading}
              activeOpacity={0.85}
            >
              <GoldFill radius={27} disabled={continueDisabled || loading} />
              {loading ? (
                <ActivityIndicator color={colors.onAccent} />
              ) : (
                <Text style={[styles.ctaText, (continueDisabled || loading) && styles.ctaTextOff]}>
                  {continueLabel}
                </Text>
              )}
            </TouchableOpacity>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bgApp },

  flex: { flex: 1 },

  scroll: {
    flexGrow: 1,
    paddingHorizontal: 24,
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

  heading: {
    fontFamily: fonts.displayBold,
    fontSize: 25,
    lineHeight: 32,
    fontWeight: '700',
    letterSpacing: -0.4,
    color: colors.textPrimary,
    marginBottom: 8,
    textAlign : 'center',
  },

  subtitle: {
    fontFamily: fonts.body,
    textAlign : 'center',
    fontSize: 14.5,
    lineHeight: 21,
    color: colors.textSecondaryWarm,
    marginBottom: 26,
    maxWidth: 410,
  },

  body: {
    gap: 18,
  },

  footer: {
    marginTop: 'auto',
    paddingTop: 24,
  },

  cta: {

    width: '100%',
    height: 54,
    borderRadius: 27,
    backgroundColor: colors.gold,
    alignItems: 'center',
    justifyContent: 'center',
    ...goldButton.glow,
  },

  ctaOff: {
    backgroundColor: colors.btnDisabledBg,
  },

  ctaText: {
    fontFamily: fonts.bodyBold,
    fontSize: 16,
    lineHeight: 16,
    fontWeight: '700',
    letterSpacing: 0.2,
    color: colors.onAccent,
  },

  ctaTextOff: {
    color: colors.btnDisabledText,
  },
});
