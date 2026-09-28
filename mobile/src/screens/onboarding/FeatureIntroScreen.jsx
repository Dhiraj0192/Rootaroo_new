import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Animated, Easing } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useIsFocused } from '@react-navigation/native';
import FeatureTourShell from './FeatureTourShell';
import { AvatarStack } from './tourPrimitives';
import { useTourHousehold } from './useTourHousehold';
import { useReducedMotion } from './useReducedMotion';
import { intro } from './featureTourContent';
import { colors, fonts, withAlpha } from '../../shared/theme';

/** The mock's three faces, used until the real household has members. */
const FALLBACK_NAMES = ['Sid', 'Sera', 'Vacancy'];

// Four beats — brand, title, subtitle, seat row — each a fade + a small
// upward drift, one after another with a real breathing gap between them
// (a wider stagger than the per-item duration would need alone) rather than
// a near-simultaneous cascade. ~3.0s total before the loader hands off to
// Day — enough to actually read the statement once, not just glimpse it.
const ITEM_COUNT = 4;
const STAGGER_MS = 260;
const ITEM_MS = 620;
const SETTLE_BUFFER_MS = 1600;
const INTRO_TOTAL_MS = (ITEM_COUNT - 1) * STAGGER_MS + ITEM_MS + SETTLE_BUFFER_MS;
const RISE_PX = 14;
const SCALE_FROM = 0.94;
const HALO_FADE_MS = 1100;

/**
 * Step 1 of 4 — the opening. A centred statement rather than a list: the
 * design opens on what Rootaroo IS ("a private home for the <family>") and
 * saves the privacy answer for the step after the day-in-the-life.
 */
export default function FeatureIntroScreen({ navigation }) {
  const { name, memberNames } = useTourHousehold();
  const isFocused = useIsFocused();
  const reduceMotion = useReducedMotion();

  const householdName = name || intro.fallbackHouseholdName;
  const names = memberNames.length ? memberNames : FALLBACK_NAMES;
  const shown = names.slice(0, 3);
  const extra = names.length > 3 ? `+${names.length - 3}` : null;

  const items = useRef(
    Array.from({ length: ITEM_COUNT }, () => ({
      opacity: new Animated.Value(0),
      translateY: new Animated.Value(RISE_PX),
      scale: new Animated.Value(SCALE_FROM),
    })),
  ).current;
  const halo = useRef({ opacity: new Animated.Value(0), scale: new Animated.Value(0.9) }).current;
  const sequenceRef = useRef(null);

  const snapToFinal = () => {
    sequenceRef.current?.stop?.();
    items.forEach((it) => {
      it.opacity.setValue(1);
      it.translateY.setValue(0);
      it.scale.setValue(1);
    });
    halo.opacity.setValue(1);
    halo.scale.setValue(1);
  };

  useEffect(() => {
    if (!isFocused) return undefined;

    if (reduceMotion) {
      snapToFinal();
      return undefined;
    }

    items.forEach((it) => {
      it.opacity.setValue(0);
      it.translateY.setValue(RISE_PX);
      it.scale.setValue(SCALE_FROM);
    });
    halo.opacity.setValue(0);
    halo.scale.setValue(0.9);

    // The warm halo blooms in first, on its own — it's the mood-setter, not
    // content, so it gets a beat to itself before anything else arrives.
    Animated.parallel([
      Animated.timing(halo.opacity, {
        toValue: 1,
        duration: HALO_FADE_MS,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(halo.scale, {
        toValue: 1,
        duration: HALO_FADE_MS,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();

    sequenceRef.current = Animated.stagger(
      STAGGER_MS,
      items.map((it) =>
        Animated.parallel([
          Animated.timing(it.opacity, {
            toValue: 1,
            duration: ITEM_MS,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: true,
          }),
          Animated.timing(it.translateY, {
            toValue: 0,
            duration: ITEM_MS,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: true,
          }),
          // A soft scale-up alongside the rise and fade — each element
          // settles into place rather than simply appearing.
          Animated.timing(it.scale, {
            toValue: 1,
            duration: ITEM_MS,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: true,
          }),
        ]),
      ),
    );
    sequenceRef.current.start();

    return () => {
      sequenceRef.current?.stop?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFocused, reduceMotion]);

  return (
    <FeatureTourShell
      step={0}
      navigation={navigation}
      onContinue={() => navigation.navigate('FeatureDay')}
      autoAdvanceMs={INTRO_TOTAL_MS}
      hideControls
      contentPadding={26}
    >
      {/* Same plain-background-plus-bubble treatment as Privacy's header —
          one soft circular glow, not a full-screen wash. Absolutely
          positioned and non-interactive so it never affects layout. */}
      <Animated.View
        style={[styles.halo, { opacity: halo.opacity, transform: [{ scale: halo.scale }] }]}
        pointerEvents="none"
      >
        <LinearGradient
          colors={[withAlpha(colors.goldGlow, 0.18), 'transparent']}
          style={StyleSheet.absoluteFill}
        />
      </Animated.View>

      <View style={styles.body}>
        <View style={styles.centerGroup}>
          <Animated.Text
            style={[
              styles.brand,
              {
                opacity: items[0].opacity,
                transform: [{ translateY: items[0].translateY }, { scale: items[0].scale }],
              },
            ]}
          >
            {intro.brand}
          </Animated.Text>

          <Animated.Text
            style={[
              styles.title,
              {
                opacity: items[1].opacity,
                transform: [{ translateY: items[1].translateY }, { scale: items[1].scale }],
              },
            ]}
          >
            {intro.titleLead}
            {'\n'}
            {intro.titleTail}
            <Text style={styles.titleAccent}>{householdName}</Text>.
          </Animated.Text>

          <Animated.Text
            style={[
              styles.subtitle,
              {
                opacity: items[2].opacity,
                transform: [{ translateY: items[2].translateY }, { scale: items[2].scale }],
              },
            ]}
          >
            {intro.body}
          </Animated.Text>
        </View>

        {/* Anchored toward the bottom of the page rather than part of the
            centered stack above — one line, not two. */}
        <Animated.View
          style={[
            styles.seatRow,
            {
              opacity: items[3].opacity,
              transform: [{ translateY: items[3].translateY }, { scale: items[3].scale }],
            },
          ]}
        >
          <AvatarStack names={shown} extra={extra} />
          <Text style={styles.seatText} numberOfLines={1}>
            {intro.seatLine.join(' ')}
          </Text>
        </Animated.View>
      </View>
    </FeatureTourShell>
  );
}

const styles = StyleSheet.create({
  // Same bubble size/position as Privacy's header halo — a plain background
  // with one soft circular glow behind the content, not a full-screen wash.
  // `overflow: hidden` is required here: the animated wrapper is what needs
  // to fade/scale (so the gradient child has to use absoluteFill to track
  // its size), and without this, borderRadius on a View never clips an
  // absoluteFill child — it was rendering as an uncapped square gradient
  // patch instead of a circular bubble.
  halo: {
    position: 'absolute',
    alignSelf: 'center',
    top: -110,
    width: 420,
    height: 420,
    borderRadius: 210,
    overflow: 'hidden',
  },

  // The centered stack (brand/title/subtitle) and the seat line are now two
  // separate sections: `body` just stacks them, `centerGroup` is the one
  // that claims the flexible space and centers its own content within it —
  // which leaves the seat line sitting on its own, below center, toward the
  // bottom of the page rather than folded into the centered group.
  body: {
    flex: 1,
  },
  centerGroup: {
    flex: 1,
    justifyContent: 'center',
  },

  brand: {
    fontFamily: fonts.display,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 2.2,
    color: colors.gold,
  },

  title: {
    fontFamily: fonts.display,
    fontSize: 38,
    lineHeight: 41,
    fontWeight: '800',
    letterSpacing: -1.3,
    color: colors.ink,
    marginTop: 14,
  },
  titleAccent: { color: colors.gold },

  subtitle: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 15.5,
    lineHeight: 25,
    fontWeight: '600',
    color: colors.inkMuted,
    marginTop: 18,
    maxWidth: 320,
  },

  seatRow: {
    flexDirection: 'row',
    alignSelf: 'center',
    alignItems: 'center',
    gap: 12,
    paddingBottom: 32,
  },
  seatText: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 13.5,
    lineHeight: 19,
    fontWeight: '600',
    color: colors.textMuted,
  },
});
