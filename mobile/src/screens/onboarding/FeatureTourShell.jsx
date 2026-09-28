import React, { useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  StatusBar,
  Animated,
  Easing,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useIsFocused } from '@react-navigation/native';
import Svg, { Path } from 'react-native-svg';
import { colors, fonts, goldButton, withAlpha } from '../../shared/theme';
import { GoldFill } from '../../shared/components/GoldButton';
import { updateSignupProgress } from '../../shared/store/signupProgress';
import { useReducedMotion } from './useReducedMotion';
import { TOUR_ROUTES } from './featureTourContent';

// How long the rail sits at each step when the OS asks for reduced motion —
// short enough that nothing reads as a "long automatic sequence", but not so
// instant that the screen flashes past before it can be read.
const REDUCED_AUTO_ADVANCE_MS = 900;

/**
 * Chrome for the four feature-overview screens, the way SignupWizardShell is
 * chrome for the signup wizard — same structural contract (a progress rail,
 * a scrolling body, one gold pill CTA pinned at the bottom), tuned to the
 * design's tour layout:
 *
 *   • the rail has FOUR segments, not the wizard's eight, and each one is
 *     tappable — the design lets you jump between steps, which is what makes
 *     this read as an overview you can skim rather than a form you must fill.
 *   • `header` renders ABOVE the scroll area and stays put. The long steps
 *     (the day timeline, pricing) scroll their body under a fixed title, so
 *     you never lose track of which step you're on mid-scroll.
 *   • the CURRENT segment fills progressively while the step is on screen —
 *     driven by `autoAdvanceMs` — and calling `onContinue` automatically once
 *     it reaches 100%, exactly as if the CTA had been pressed. A step that
 *     needs its own pacing (the day timeline, built from its own beats) works
 *     out its own duration and passes it in; the shell never guesses.
 *   • Skip lives here once, not once per screen: it stops the fill, lets the
 *     screen (via `onSkip`) snap its own content to its final resting state,
 *     then calls `onContinue` — the same function the CTA and the completed
 *     loader call. There is exactly one way this step finishes, reached three
 *     different ways.
 *
 * Mounting a step also records it in signupProgress, so an in-session resume
 * (stepToRoute) reopens the step the user was on. Note this does NOT survive
 * a re-login: resolvePostAuthNavigation short-circuits on "user already has a
 * household = setup done" before it ever consults the saved step, so a
 * creator who kills the app mid-tour and signs back in lands on Home. That is
 * the pre-existing rule for returning users and it is the right one — the
 * tour is a welcome, not a gate.
 *
 * Native-stack keeps a screen mounted (just unfocused) when you navigate
 * forward past it, so a naive "clear the timer on unmount" never fires for
 * the screen you just left. The fill/advance timer is gated on `useIsFocused`
 * instead: it starts only while this step is the visible one and is torn
 * down the moment focus leaves, so a screen you've already moved on from can
 * never fire a late `onContinue` behind your back.
 */
export default function FeatureTourShell({
  step,
  navigation,
  header,
  children,
  ctaLabel,
  ctaSubLabel,
  onContinue,
  onSkip,
  autoAdvanceMs,
  scrollRef,
  scrollViewProps,
  footerDivider = false,
  contentPadding = 18,
  // Hides the pinned CTA pill — the step is meant to be watched, not
  // operated, so the rail fill is what shows it progressing and onContinue
  // fires on its own once it completes. Skip is unaffected by this (see
  // `skippable` below) — a hideControls step still shows Skip.
  hideControls = false,
}) {
  const insets = useSafeAreaInsets();
  const isFocused = useIsFocused();
  const reduceMotion = useReducedMotion();

  const railFill = useRef(new Animated.Value(0)).current;
  const fillAnimRef = useRef(null);
  const advancedRef = useRef(false);
  // Wall-clock bookkeeping for pause/resume: how much time is left on the
  // current run, and when the current run last (re)started — Animated has
  // no native pause, so "pausing" means stopping the timing (which freezes
  // railFill wherever it was) and, on resume, starting a fresh timing from
  // that same value for whatever time remains.
  const remainingMsRef = useRef(0);
  const runStartedAtRef = useRef(0);
  const pausedRef = useRef(false);
  // startFill's completion callback can fire long after it was created
  // (a resume from a touch that happened seconds into the step) — it calls
  // through this ref rather than closing over `handleAdvance` directly, so
  // it always runs the current onContinue, never a stale one from whenever
  // startFill itself was defined.
  const handleAdvanceRef = useRef(() => {});

  useEffect(() => {
    updateSignupProgress({ step: `feature${step + 1}` }).catch(() => {
      /* Progress is a resume convenience, never a gate — a failed write must
         not block the tour. */
    });
  }, [step]);

  const startFill = useCallback((durationMs, easing) => {
    const anim = Animated.timing(railFill, {
      toValue: 1,
      duration: durationMs,
      easing,
      useNativeDriver: true,
    });
    fillAnimRef.current = anim;
    runStartedAtRef.current = Date.now();
    remainingMsRef.current = durationMs;
    anim.start(({ finished }) => {
      if (finished) handleAdvanceRef.current();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!isFocused || !autoAdvanceMs) return undefined;

    advancedRef.current = false;
    pausedRef.current = false;
    railFill.setValue(0);

    const duration = reduceMotion ? REDUCED_AUTO_ADVANCE_MS : autoAdvanceMs;
    // Eased, not linear — a linear fill reads as a mechanical countdown
    // racing to 100%. ease-in-out gives it a gentle start, a steady middle,
    // and a soft final approach, which is what makes completion feel
    // satisfying rather than abrupt.
    startFill(duration, Easing.inOut(Easing.cubic));

    return () => {
      fillAnimRef.current?.stop?.();
      fillAnimRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFocused, autoAdvanceMs, reduceMotion]);

  const handleAdvance = useCallback(() => {
    if (advancedRef.current) return;
    advancedRef.current = true;
    fillAnimRef.current?.stop?.();
    onContinue && onContinue();
  }, [onContinue]);

  useEffect(() => {
    handleAdvanceRef.current = handleAdvance;
  }, [handleAdvance]);

  // Touching anywhere on the page holds the loader right where it is —
  // reading/scrolling shouldn't be racing a timer. Lifting the finger picks
  // up exactly where it left off, for whatever time remains.
  const handleTouchStart = useCallback(() => {
    if (!autoAdvanceMs || advancedRef.current || pausedRef.current) return;
    pausedRef.current = true;
    fillAnimRef.current?.stop?.();
    const elapsed = Date.now() - runStartedAtRef.current;
    remainingMsRef.current = Math.max(0, remainingMsRef.current - elapsed);
  }, [autoAdvanceMs]);

  const handleTouchEnd = useCallback(() => {
    if (!autoAdvanceMs || advancedRef.current || !pausedRef.current) return;
    pausedRef.current = false;
    if (remainingMsRef.current <= 0) {
      handleAdvance();
      return;
    }
    // Resuming mid-curve: a fresh ease-out from here reads as a natural
    // continuation rather than replaying the original curve's start.
    startFill(remainingMsRef.current, Easing.out(Easing.cubic));
  }, [autoAdvanceMs, handleAdvance, startFill]);

  const handleSkip = useCallback(() => {
    if (advancedRef.current) return;
    advancedRef.current = true;
    fillAnimRef.current?.stop?.();
    railFill.setValue(1);
    // Let the screen snap its own content (beats/rows/groups) to its final
    // resting state before we navigate away — synchronous, no animation.
    onSkip && onSkip();
    onContinue && onContinue();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onSkip, onContinue]);

  const goToStep = (i) => {
    if (i === step) return;
    advancedRef.current = true;
    fillAnimRef.current?.stop?.();
    navigation.navigate(TOUR_ROUTES[i]);
  };

  // Skip is independent of hideControls — hideControls only hides the
  // pinned CTA pill (Pricing is the one screen with a real Continue button
  // instead, and has no autoAdvanceMs, so skippable is naturally false
  // there without needing hideControls to also suppress it).
  const skippable = Boolean(autoAdvanceMs);

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor={colors.bgApp} />

      <View style={[styles.topRow, { paddingTop: insets.top + (Platform.OS === 'ios' ? 8 : 14) }]}>
        <View style={styles.rail}>
          {TOUR_ROUTES.map((route, i) => (
            <TouchableOpacity
              key={route}
              style={styles.railHit}
              onPress={() => goToStep(i)}
              hitSlop={{ top: 12, bottom: 12, left: 4, right: 4 }}
              accessibilityRole="button"
              accessibilityLabel={`Step ${i + 1} of ${TOUR_ROUTES.length}`}
              accessibilityState={i === step ? { selected: true } : {}}
            >
              <View style={styles.seg}>
                {i < step ? <View style={[StyleSheet.absoluteFill, styles.segDone]} /> : null}
                {i === step ? (
                  <Animated.View
                    style={[
                      StyleSheet.absoluteFill,
                      styles.segFillStatic,
                      {
                        transform: [{ scaleX: railFill }],
                        transformOrigin: 'left',
                      },
                    ]}
                  />
                ) : null}
              </View>
            </TouchableOpacity>
          ))}
        </View>

        {skippable ? (
          <TouchableOpacity
            style={styles.skipBtn}
            onPress={handleSkip}
            hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
            accessibilityRole="button"
            accessibilityLabel="Skip"
          >
            <Text style={styles.skipText}>Skip</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      {/* Raw touch events, not a responder/gesture claim — they fire on any
          touch landing here (including ones the ScrollView goes on to
          handle as a scroll) without interfering with that scroll gesture,
          which is exactly what "hold the loader while the page is touched"
          needs: pause on contact, resume on release, whatever the touch
          turned out to be. */}
      <View
        style={styles.flex}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchEnd}
      >
        {header ? <View style={styles.header}>{header}</View> : null}

        <ScrollView
          ref={scrollRef}
          style={styles.flex}
          contentContainerStyle={[
            styles.scroll,
            { paddingHorizontal: contentPadding },
            // No footer to clear the home-indicator/gesture area for us, so
            // the scroll content takes over that safe-area padding itself.
            hideControls && { paddingBottom: Math.max(insets.bottom, 12) + 12 },
          ]}
          showsVerticalScrollIndicator={false}
          {...scrollViewProps}
        >
          {children}
        </ScrollView>
      </View>

      {hideControls ? null : (
        <View
          style={[
            styles.footer,
            footerDivider && styles.footerDivider,
            { paddingBottom: Math.max(insets.bottom, 14) },
          ]}
        >
          <TouchableOpacity style={styles.cta} onPress={handleAdvance} activeOpacity={0.85}>
            <GoldFill radius={27} />
            <Text style={styles.ctaText}>{ctaLabel}</Text>
          </TouchableOpacity>
          {ctaSubLabel ? <Text style={styles.ctaSub}>{ctaSubLabel}</Text> : null}
        </View>
      )}
    </View>
  );
}

/** The design's 17px line icons, as a reusable element for every step. */
export function TourIcon({ paths, size = 17, stroke = colors.gold, strokeWidth = 1.9 }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {paths.map((d, i) => (
        <Path
          key={i}
          d={d}
          stroke={stroke}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </Svg>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bgApp },
  flex: { flex: 1 },

  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 20,
    paddingBottom: 2,
  },
  rail: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  // The touch target is taller than the 3px bar it draws, so the segments
  // stay tappable without making the rail itself a thick band.
  railHit: {
    flex: 1,
    paddingVertical: 8,
  },
  seg: {
    height: 3,
    borderRadius: 99,
    backgroundColor: withAlpha(colors.white, 0.08),
    overflow: 'hidden',
  },
  // Already-passed steps stay at the original design's muted 35% gold —
  // only the segment currently filling gets the full-strength color, so the
  // rail keeps reading "here" vs "behind you" exactly as it did before.
  segDone: { backgroundColor: withAlpha(colors.gold, 0.35) },
  segFillStatic: {
    backgroundColor: colors.gold,
  },

  skipBtn: {
    paddingVertical: 8,
    paddingHorizontal: 2,
  },
  skipText: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 12.5,
    fontWeight: '600',
    color: colors.textSecondary,
  },

  header: {
    paddingHorizontal: 22,
    paddingTop: 12,
    paddingBottom: 12,
  },

  scroll: {
    flexGrow: 1,
    paddingBottom: 12,
  },

  footer: {
    paddingHorizontal: 20,
    paddingTop: 10,
  },
  footerDivider: {
    borderTopWidth: 1,
    borderTopColor: withAlpha(colors.white, 0.05),
  },

  cta: {
    width: '100%',
    height: 54,
    borderRadius: 27,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.gold,
    ...goldButton.glow,
  },
  ctaText: {
    fontFamily: fonts.bodyBold,
    fontSize: 16,
    lineHeight: 16,
    fontWeight: '800',
    letterSpacing: -0.16,
    color: goldButton.onGold,
  },
  ctaSub: {
    textAlign: 'center',
    fontFamily: fonts.bodySemiBold,
    fontSize: 12,
    fontWeight: '600',
    color: colors.textFaint,
    marginTop: 12,
  },
});
