import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Animated, Easing } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useIsFocused } from '@react-navigation/native';
import Svg, { Path } from 'react-native-svg';
import FeatureTourShell from './FeatureTourShell';
import { Eyebrow } from './tourPrimitives';
import { useReducedMotion } from './useReducedMotion';
import { pricing, oldWay, PRICE, derivePricing } from './featureTourContent';
import { updateSignupProgress } from '../../shared/store/signupProgress';
import { useAuthStore } from '../../shared/store/authStore';
import { colors, fonts, radius, goldButton, withAlpha } from '../../shared/theme';

// Two groups, not eight — the "what you'd pay elsewhere / what you pay here"
// hero enters from the left, the plan controls follow in from the right.
// There was no animation here before this pass (see the research report);
// this is new work, not a preserved effect.
const GROUP_STAGGER_MS = 380;
const GROUP_ENTER_MS = 640;
const SLIDE_PX = 32;

/**
 * Step 4 of 4 — the close, and the last screen of onboarding. Everything the
 * tour just showed, priced against what the same five apps cost separately.
 *
 * Unlike the previous three steps, this one does NOT auto-advance and has no
 * Skip — it's the screen with a real decision on it (plan, household size),
 * so it only ever proceeds when the user actually presses Continue.
 *
 * NOTE: this screen takes no payment. There is no billing, subscription or
 * in-app-purchase code in the app or the server, so its CTA does what the
 * previous three CTAs do — finishes the flow and drops the user on Home. The
 * plan toggle and household-size stepper are live (the maths is the design's,
 * in featureTourContent.derivePricing) so the screen is ready to wire to a
 * real store transaction later; charging for this would need Apple/Google
 * in-app purchase, not a card form.
 */
export default function FeaturePricingScreen({ navigation }) {
  const [plan, setPlan] = useState('year');
  const [size, setSize] = useState(PRICE.includedSeats);
  const p = derivePricing(plan, size);

  const isFocused = useIsFocused();
  const reduceMotion = useReducedMotion();

  const heroAnim = useRef({ opacity: new Animated.Value(0), translateX: new Animated.Value(-SLIDE_PX) }).current;
  const controlsAnim = useRef({ opacity: new Animated.Value(0), translateX: new Animated.Value(SLIDE_PX) }).current;
  const sequenceRef = useRef(null);

  useEffect(() => {
    if (!isFocused) return undefined;

    if (reduceMotion) {
      sequenceRef.current?.stop?.();
      heroAnim.opacity.setValue(1);
      heroAnim.translateX.setValue(0);
      controlsAnim.opacity.setValue(1);
      controlsAnim.translateX.setValue(0);
      return undefined;
    }

    heroAnim.opacity.setValue(0);
    heroAnim.translateX.setValue(-SLIDE_PX);
    controlsAnim.opacity.setValue(0);
    controlsAnim.translateX.setValue(SLIDE_PX);

    const enter = (anim) =>
      Animated.parallel([
        Animated.timing(anim.opacity, {
          toValue: 1,
          duration: GROUP_ENTER_MS,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(anim.translateX, {
          toValue: 0,
          duration: GROUP_ENTER_MS,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
      ]);

    sequenceRef.current = Animated.stagger(GROUP_STAGGER_MS, [enter(heroAnim), enter(controlsAnim)]);
    sequenceRef.current.start();

    return () => sequenceRef.current?.stop?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFocused, reduceMotion]);

  // The tour is the tail of onboarding, so finishing it — not InviteMembers —
  // is what ends setup for a household creator: same three calls, moved here
  // so the confetti and the in-app tour fire once, on the real last step.
  const finish = async () => {
    await updateSignupProgress({ step: 'done', setupComplete: true }).catch(() => {});
    useAuthStore.getState().triggerCelebration();
    useAuthStore.getState().triggerTour();
    useAuthStore.getState().completeSetup();
  };

  return (
    <FeatureTourShell
      step={3}
      navigation={navigation}
      contentPadding={22}
      ctaLabel={p.payLabel}
      ctaSubLabel={p.payFine}
      onContinue={finish}
    >
      <Animated.View style={{ opacity: heroAnim.opacity, transform: [{ translateX: heroAnim.translateX }] }}>
        <Eyebrow style={styles.topEyebrow}>{pricing.eyebrow}</Eyebrow>
        <Text style={styles.title}>
          {pricing.title[0]}
          {'\n'}
          {pricing.title[1]}
        </Text>

        {/* What the same jobs cost across five separate subscriptions. */}
        <View style={styles.oldCard}>
          <Text style={styles.microLabel}>{pricing.oldWayLabel}</Text>
          <View style={styles.oldList}>
            {oldWay.map((o) => (
              <View key={o.name} style={styles.oldRow}>
                <Text style={styles.oldName} numberOfLines={1}>
                  {o.name}
                </Text>
                <Text style={styles.oldCost}>{o.cost}</Text>
              </View>
            ))}
          </View>
          <View style={styles.oldTotalRow}>
            <Text style={styles.oldTotalName}>{pricing.oldWayTotalLabel}</Text>
            <Text style={styles.oldTotal}>{pricing.oldWayTotal}</Text>
          </View>
        </View>

        <View style={styles.dividerRow}>
          <View style={styles.rule} />
          <Text style={styles.dividerLabel}>{pricing.divider}</Text>
          <View style={styles.rule} />
        </View>

        <View style={styles.priceRow}>
          <Text style={styles.currency}>$</Text>
          <Text style={styles.priceWhole}>{p.bigWhole}</Text>
          <Text style={styles.priceCents}>{p.bigCents}</Text>
          <Text style={styles.pricePer}>{p.bigPerShort}</Text>
        </View>
        <Text style={styles.headSub}>{p.headSub}</Text>

        {/* The saving, with a bar comparing Rootaroo's yearly cost to ~$399. */}
        <LinearGradient
          colors={[withAlpha(colors.successBright, 0.16), withAlpha(colors.successBright, 0.04), 'transparent']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.savedCard}
        >
          <View style={styles.savedRow}>
            <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
              <Path d="M12 19V7" stroke={colors.successBright} strokeWidth={2.3} strokeLinecap="round" />
              <Path
                d="M6 13l6-6 6 6"
                stroke={colors.successBright}
                strokeWidth={2.3}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </Svg>
            <View style={styles.grow}>
              <View style={styles.savedHead}>
                <Text style={styles.savedAmount}>{p.savedAmount}</Text>
                <Text style={styles.savedUnit}>{pricing.savedUnit}</Text>
              </View>
              <Text style={styles.savedSub}>{p.savedSub}</Text>
            </View>
          </View>

          <View style={styles.barTrack}>
            <LinearGradient
              colors={[colors.goldGlowSoft, colors.goldWarmDark]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={[styles.barFill, { width: p.goldW }]}
            />
          </View>
          <View style={styles.barLabels}>
            <Text style={styles.barGold}>ROOTAROO {p.rootYearly}</Text>
            <Text style={styles.barRed}>{pricing.elsewhereLabel}</Text>
          </View>
        </LinearGradient>
      </Animated.View>

      <Animated.View style={{ opacity: controlsAnim.opacity, transform: [{ translateX: controlsAnim.translateX }] }}>
        {/* Plan toggle */}
        <View style={styles.tabs}>
          <Tab label={pricing.yearTab} on={p.year} onPress={() => setPlan('year')} />
          <Tab label={pricing.monthTab} on={!p.year} onPress={() => setPlan('month')} />
        </View>

        {/* Household size stepper */}
        <View style={styles.settingRow}>
          <View style={styles.grow}>
            <Text style={styles.settingTitle}>{pricing.sizeLabel}</Text>
            <Text style={[styles.settingSub, p.extras > 0 && styles.settingSubOn]}>{p.extraLine}</Text>
          </View>
          <View style={styles.stepper}>
            <StepperButton
              sign="minus"
              disabled={size <= PRICE.minSeats}
              onPress={() => setSize((s) => Math.max(PRICE.minSeats, s - 1))}
              label="Remove a member"
            />
            <Text style={styles.stepperValue}>{size}</Text>
            <StepperButton
              sign="plus"
              disabled={size >= PRICE.maxSeats}
              onPress={() => setSize((s) => Math.min(PRICE.maxSeats, s + 1))}
              label="Add a member"
            />
          </View>
        </View>

        <View style={styles.settingRow}>
          <View style={styles.grow}>
            <Text style={styles.settingTitle}>{pricing.featuresTitle}</Text>
            <Text style={styles.settingSub}>{pricing.featuresSub}</Text>
          </View>
          <Text style={styles.includedBadge}>{pricing.featuresBadge}</Text>
        </View>
      </Animated.View>
    </FeatureTourShell>
  );
}

function Tab({ label, on, onPress }) {
  return (
    <TouchableOpacity
      style={styles.tab}
      onPress={onPress}
      activeOpacity={0.85}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
    >
      {on ? (
        <LinearGradient
          colors={[colors.goldGlowSoft, colors.goldWarmDark]}
          start={{ x: 0.5, y: 0 }}
          end={{ x: 0.5, y: 1 }}
          style={styles.tabFill}
          pointerEvents="none"
        />
      ) : null}
      <Text style={[styles.tabText, on && styles.tabTextOn]}>{label}</Text>
    </TouchableOpacity>
  );
}

function StepperButton({ sign, disabled, onPress, label }) {
  return (
    <TouchableOpacity
      style={[styles.stepBtn, disabled && styles.stepBtnOff]}
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
    >
      <View style={styles.stepBar} />
      {sign === 'plus' ? <View style={[styles.stepBar, styles.stepBarVertical]} /> : null}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  grow: { flex: 1, minWidth: 0 },
  topEyebrow: { marginTop: 10 },

  title: {
    fontFamily: fonts.display,
    fontSize: 24,
    lineHeight: 28,
    fontWeight: '800',
    letterSpacing: -0.7,
    color: colors.ink,
    marginTop: 8,
  },

  /* Five-subscriptions card */
  oldCard: {
    borderRadius: radius.sheet,
    backgroundColor: colors.canvasGray,
    borderWidth: 1,
    borderColor: withAlpha(colors.white, 0.07),
    paddingHorizontal: 17,
    paddingTop: 16,
    paddingBottom: 15,
    marginTop: 22,
  },
  microLabel: {
    fontFamily: fonts.bodyBold,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.4,
    color: colors.textMuted,
  },
  oldList: { gap: 9, marginTop: 14 },
  oldRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  oldName: {
    flex: 1,
    minWidth: 0,
    fontFamily: fonts.bodySemiBold,
    fontSize: 12.5,
    fontWeight: '600',
    color: colors.textSecondary,
  },
  oldCost: {
    fontFamily: fonts.mono,
    fontSize: 12,
    fontWeight: '700',
    color: colors.danger,
    textDecorationLine: 'line-through',
  },
  oldTotalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 13,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: withAlpha(colors.white, 0.06),
  },
  oldTotalName: {
    flex: 1,
    fontFamily: fonts.bodyBold,
    fontSize: 12.5,
    fontWeight: '700',
    color: colors.inkDeep,
  },
  oldTotal: {
    fontFamily: fonts.mono,
    fontSize: 15,
    fontWeight: '800',
    color: colors.blushDeep,
  },

  /* "WITH ROOTAROO" rule */
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    marginTop: 16,
    paddingHorizontal: 4,
  },
  rule: { flex: 1, height: 1, backgroundColor: withAlpha(colors.white, 0.07) },
  dividerLabel: {
    fontFamily: fonts.bodyBold,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.4,
    color: colors.gold,
  },

  /* The number */
  priceRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 4, marginTop: 14 },
  currency: {
    fontFamily: fonts.mono,
    fontSize: 24,
    lineHeight: 24,
    fontWeight: '800',
    color: colors.goldGlowDim,
    marginTop: 10,
  },
  priceWhole: {
    fontFamily: fonts.mono,
    fontSize: 58,
    lineHeight: 60,
    fontWeight: '800',
    letterSpacing: -2.5,
    color: colors.ink,
  },
  priceCents: {
    fontFamily: fonts.mono,
    fontSize: 21,
    lineHeight: 21,
    fontWeight: '800',
    color: colors.goldGlowDim,
    marginTop: 12,
  },
  pricePer: {
    fontFamily: fonts.bodyBold,
    fontSize: 12.5,
    fontWeight: '700',
    color: colors.textMuted,
    marginTop: 19,
    marginLeft: 8,
  },
  headSub: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 13,
    fontWeight: '600',
    color: colors.textSecondary,
    marginTop: 10,
  },

  /* Saving */
  savedCard: {
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: withAlpha(colors.successBright, 0.3),
    paddingHorizontal: 17,
    paddingVertical: 16,
    marginTop: 18,
    overflow: 'hidden',
  },
  savedRow: { flexDirection: 'row', alignItems: 'center', gap: 13 },
  savedHead: { flexDirection: 'row', alignItems: 'baseline', gap: 7 },
  savedAmount: {
    fontFamily: fonts.mono,
    fontSize: 27,
    lineHeight: 29,
    fontWeight: '800',
    letterSpacing: -0.7,
    color: colors.successBright,
  },
  savedUnit: {
    fontFamily: fonts.bodyBold,
    fontSize: 12.5,
    fontWeight: '700',
    color: colors.success,
  },
  savedSub: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 12,
    fontWeight: '600',
    color: colors.successSoft,
    marginTop: 5,
  },
  barTrack: {
    height: 8,
    marginTop: 14,
    borderRadius: 99,
    backgroundColor: withAlpha(colors.danger, 0.18),
    overflow: 'hidden',
  },
  barFill: { height: '100%', borderRadius: 99 },
  barLabels: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 },
  barGold: {
    fontFamily: fonts.bodyBold,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1,
    color: colors.gold,
  },
  barRed: {
    fontFamily: fonts.bodyBold,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1,
    color: colors.danger,
  },

  /* Plan toggle */
  tabs: {
    flexDirection: 'row',
    gap: 6,
    marginTop: 20,
    backgroundColor: colors.canvasGray,
    borderWidth: 1,
    borderColor: withAlpha(colors.white, 0.07),
    borderRadius: 99,
    padding: 4,
  },
  tab: {
    flex: 1,
    borderRadius: 99,
    paddingVertical: 11,
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  tabFill: { ...StyleSheet.absoluteFillObject, borderRadius: 99 },
  tabText: {
    fontFamily: fonts.bodyBold,
    fontSize: 13,
    fontWeight: '800',
    color: colors.textSecondary,
  },
  tabTextOn: { color: goldButton.onGold },

  /* Rows below the toggle */
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    marginTop: 20,
    paddingTop: 19,
    borderTopWidth: 1,
    borderTopColor: withAlpha(colors.white, 0.06),
  },
  settingTitle: {
    fontFamily: fonts.bodyBold,
    fontSize: 14,
    fontWeight: '700',
    color: colors.inkSoft,
  },
  settingSub: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 12,
    fontWeight: '600',
    color: colors.textMuted,
    marginTop: 3,
  },
  settingSubOn: { color: colors.gold },
  includedBadge: {
    fontFamily: fonts.bodyBold,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1,
    color: colors.successBright,
  },

  stepper: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  stepBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: withAlpha(colors.white, 0.12),
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepBtnOff: { opacity: 0.35 },
  stepBar: {
    position: 'absolute',
    width: 11,
    height: 1.8,
    borderRadius: 2,
    backgroundColor: colors.inkDeep,
  },
  stepBarVertical: { width: 1.8, height: 11 },
  stepperValue: {
    width: 30,
    textAlign: 'center',
    fontFamily: fonts.mono,
    fontSize: 17,
    fontWeight: '800',
    color: colors.goldGlowPale,
  },
});
