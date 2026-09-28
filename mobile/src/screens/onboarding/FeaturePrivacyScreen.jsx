import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Animated, Easing } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useIsFocused } from '@react-navigation/native';
import FeatureTourShell, { TourIcon } from './FeatureTourShell';
import { Eyebrow, TourCard, rowDivider } from './tourPrimitives';
import { useReducedMotion } from './useReducedMotion';
import { privacy, privacyRows } from './featureTourContent';
import { colors, fonts, radius, withAlpha } from '../../shared/theme';

// Four rows, alternating in from the left and right — a subtle horizontal
// translate + fade, staggered with a real gap so they don't all land at once.
const ROW_COUNT = privacyRows.length;
const ROW_STAGGER_MS = 340;
const ROW_ENTER_MS = 620;
const SETTLE_BUFFER_MS = 1400;
const PRIVACY_TOTAL_MS = (ROW_COUNT - 1) * ROW_STAGGER_MS + ROW_ENTER_MS + SETTLE_BUFFER_MS;
const SLIDE_PX = 34;

/**
 * Step 3 of 4 — the answer to the question the day-in-the-life leaves open.
 * Four claims about who can see what, stated flatly and without hedging,
 * because this is the objection a household has before it commits.
 */
export default function FeaturePrivacyScreen({ navigation }) {
  const isFocused = useIsFocused();
  const reduceMotion = useReducedMotion();

  const rowAnims = useRef(
    privacyRows.map((_, i) => ({
      opacity: new Animated.Value(0),
      // Even rows drift in from the left, odd rows from the right.
      translateX: new Animated.Value(i % 2 === 0 ? -SLIDE_PX : SLIDE_PX),
    })),
  ).current;
  const sequenceRef = useRef(null);

  const snapToFinal = () => {
    sequenceRef.current?.stop?.();
    rowAnims.forEach((a) => {
      a.opacity.setValue(1);
      a.translateX.setValue(0);
    });
  };

  useEffect(() => {
    if (!isFocused) return undefined;

    if (reduceMotion) {
      snapToFinal();
      return undefined;
    }

    rowAnims.forEach((a, i) => {
      a.opacity.setValue(0);
      a.translateX.setValue(i % 2 === 0 ? -SLIDE_PX : SLIDE_PX);
    });

    sequenceRef.current = Animated.stagger(
      ROW_STAGGER_MS,
      rowAnims.map((a) =>
        Animated.parallel([
          Animated.timing(a.opacity, {
            toValue: 1,
            duration: ROW_ENTER_MS,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: true,
          }),
          Animated.timing(a.translateX, {
            toValue: 0,
            duration: ROW_ENTER_MS,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: true,
          }),
        ]),
      ),
    );
    sequenceRef.current.start();

    return () => sequenceRef.current?.stop?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFocused, reduceMotion]);

  return (
    <FeatureTourShell
      step={2}
      navigation={navigation}
      contentPadding={16}
      header={
        <View style={styles.head}>
          <LinearGradient
            colors={[withAlpha(colors.goldGlow, 0.16), 'transparent']}
            style={styles.halo}
            pointerEvents="none"
          />
          <View style={styles.lockTile}>
            <View style={styles.lockShackle} />
            <View style={styles.lockBody} />
          </View>
          <Eyebrow style={styles.eyebrow}>{privacy.eyebrow}</Eyebrow>
          <Text style={styles.title}>
            {privacy.title[0]}
            {'\n'}
            {privacy.title[1]}
          </Text>
        </View>
      }
      onContinue={() => navigation.navigate('FeaturePricing')}
      autoAdvanceMs={PRIVACY_TOTAL_MS}
      hideControls
    >
      <TourCard style={styles.card}>
        {privacyRows.map((row, i) => (
          <Animated.View
            key={row.title}
            style={[
              styles.row,
              i > 0 && styles.rowDivided,
              { opacity: rowAnims[i].opacity, transform: [{ translateX: rowAnims[i].translateX }] },
            ]}
          >
            <View style={styles.rowIcon}>
              <TourIcon paths={row.paths} />
            </View>
            <View style={styles.rowText}>
              <Text style={styles.rowTitle}>{row.title}</Text>
              <Text style={styles.rowBody}>{row.body}</Text>
            </View>
          </Animated.View>
        ))}
      </TourCard>
    </FeatureTourShell>
  );
}

const styles = StyleSheet.create({
  head: { alignItems: 'center' },
  halo: {
    position: 'absolute',
    top: -110,
    width: 420,
    height: 420,
    borderRadius: 210,
  },
  lockTile: {
    width: 62,
    height: 62,
    borderRadius: radius.xl,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: withAlpha(colors.white, 0.08),
    alignItems: 'center',
    justifyContent: 'center',
  },
  lockShackle: {
    width: 15,
    height: 9,
    borderWidth: 2.2,
    borderBottomWidth: 0,
    borderColor: colors.gold,
    borderTopLeftRadius: 8,
    borderTopRightRadius: 8,
    marginBottom: -1,
  },
  lockBody: {
    width: 25,
    height: 18,
    borderRadius: 6,
    backgroundColor: colors.gold,
  },
  eyebrow: { marginTop: 18 },
  title: {
    fontFamily: fonts.display,
    fontSize: 25,
    lineHeight: 30,
    fontWeight: '800',
    letterSpacing: -0.6,
    color: colors.ink,
    marginTop: 8,
    textAlign: 'center',
  },

  card: { paddingHorizontal: 16, paddingVertical: 4, marginTop: 8 },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 13, paddingVertical: 15 },
  rowDivided: { borderTopWidth: 1, borderTopColor: rowDivider },
  rowIcon: {
    width: 32,
    height: 32,
    borderRadius: 11,
    backgroundColor: withAlpha(colors.gold, 0.11),
    borderWidth: 1,
    borderColor: withAlpha(colors.gold, 0.25),
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  rowText: { flex: 1, minWidth: 0 },
  rowTitle: {
    fontFamily: fonts.bodyBold,
    fontSize: 14.5,
    fontWeight: '700',
    color: colors.inkSoft,
  },
  rowBody: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 12.5,
    lineHeight: 19,
    fontWeight: '600',
    color: colors.textSecondary,
    marginTop: 4,
  },
});
