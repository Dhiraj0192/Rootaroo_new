import React, { useEffect, useRef, useState } from "react";
import {
  Animated,
  Easing,
  Text,
  TouchableOpacity,
  View,
  StyleSheet,
  AccessibilityInfo,
  useWindowDimensions,
} from "react-native";
import { useTranslation } from "react-i18next";
import { BlurView } from "expo-blur";
// kangarooQuote.svg defines its 22 fill colors entirely via a <style> block
// + class="filN" attributes, no direct fill= on any path. Plain SvgXml's
// parser has no <style>-block/CSS-class support at all (only inline
// style="" attributes) — every path fell back to SVG's implicit default
// fill (black), which is why the mascot rendered as a black silhouette.
// SvgCss (same react-native-svg package, '/css' subpath) runs a real
// css-select/css-tree pass that resolves <style> classes and inlines the
// fill before render — drop-in replacement, same props.
import { SvgCss } from "react-native-svg/css";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { KANGAROO_SVG_XML } from "../../assets/kangarooQuoteXml";
import { colors, fonts, goldButton, radius, spacing, withAlpha } from '../theme';

const ENTER_OFFSET = 260; // px the kangaroo starts off-screen to the left

/**
 * A side-entering character greeting, layered above (never replacing) the
 * Dashboard it's called from — see useDailyWelcome for the "first visit of
 * the day" trigger logic this purely renders.
 */
export default function DailyWelcomeOverlay({
  visible,
  name,
  quoteIndex,
  onDismiss,
}) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { width: screenWidth } = useWindowDimensions();

  const [mounted, setMounted] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);

  const scrim = useRef(new Animated.Value(0)).current;
  const kangarooX = useRef(new Animated.Value(-ENTER_OFFSET)).current;
  const card = useRef(new Animated.Value(0)).current; // 0 = hidden, 1 = shown

  useEffect(() => {
    let cancelled = false;
    AccessibilityInfo.isReduceMotionEnabled?.()
      .then((v) => {
        if (!cancelled) setReduceMotion(!!v);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    // eslint-disable-next-line no-console
    console.log(
      "[DailyWelcome][Overlay] received visible prop =",
      visible,
      ", quoteIndex =",
      quoteIndex,
    );
    if (!visible) return;
    setMounted(true);
    scrim.setValue(0);
    kangarooX.setValue(reduceMotion ? 0 : -ENTER_OFFSET);
    card.setValue(0);

    const kangarooIn = reduceMotion
      ? Animated.timing(kangarooX, {
          toValue: 0,
          duration: 200,
          useNativeDriver: true,
        })
      : Animated.spring(kangarooX, {
          toValue: 0,
          friction: 8,
          tension: 60,
          useNativeDriver: true,
        });

    Animated.sequence([
      Animated.timing(scrim, {
        toValue: 1,
        duration: 260,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.parallel([
        kangarooIn,
        Animated.timing(card, {
          toValue: 1,
          duration: 300,
          delay: 90,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
      ]),
    ]).start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, reduceMotion]);

  const handleClose = () => {
    Animated.parallel([
      Animated.timing(card, {
        toValue: 0,
        duration: 180,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(kangarooX, {
        toValue: reduceMotion ? 0 : -ENTER_OFFSET,
        duration: reduceMotion ? 160 : 240,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start(() => {
      Animated.timing(scrim, {
        toValue: 0,
        duration: 200,
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) setMounted(false);
      });
    });
    onDismiss?.();
  };

  if (!mounted) return null;

  const displayName = (name || "").trim().split(" ")[0] || "";
  const quotes = t("dashboard.dailyWelcome.quotes", { returnObjects: true });
  const quoteList = Array.isArray(quotes) ? quotes : [];
  const quote = quoteList.length
    ? quoteList[quoteIndex % quoteList.length]
    : "";

  // Kangaroo ≈ 25–30% of the horizontal composition; the quote card takes
  // the rest via flex: 1, so it stays a wide rectangle instead of being
  // squeezed toward square. Sized off screen WIDTH (not height, and not a
  // fixed px value) on purpose — the previous height-based sizing let the
  // kangaroo balloon up to 340px tall on normal phones, which is what ate
  // the card's width and forced it near-square. The SVG's viewBox is
  // square (25400x25400) so width === height here preserves its aspect
  // ratio without stretching.
  const stageWidth = screenWidth - spacing.lg * 2;
  const kangarooSize = Math.max(120, Math.min(210, stageWidth * 0.4));

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <Animated.View
        style={[StyleSheet.absoluteFill, { opacity: scrim }]}
        pointerEvents={visible ? "auto" : "none"}
        accessibilityViewIsModal
      >
        <BlurView intensity={28} tint="dark" style={StyleSheet.absoluteFill} />
        <View style={[StyleSheet.absoluteFill, styles.scrimTint]} />

        <View
          style={[
            styles.stage,
            {
              bottom: insets.bottom + spacing.md,
              paddingHorizontal: spacing.lg,
            },
          ]}
        >
          <Animated.View
            style={[
              styles.kangarooWrap,
              {
                width: kangarooSize,
                height: kangarooSize,
                marginRight: -kangarooSize * 0.22,
                transform: [{ translateX: kangarooX }],
              },
            ]}
            pointerEvents="none"
          >
            <SvgCss xml={KANGAROO_SVG_XML} width="100%" height="100%" />
          </Animated.View>

          <Animated.View
            style={[
              styles.card,
              {
                opacity: card,
                transform: [
                  {
                    translateY: card.interpolate({
                      inputRange: [0, 1],
                      outputRange: [16, 0],
                    }),
                  },
                ],
              },
            ]}
          >
            <TouchableOpacity
              onPress={handleClose}
              style={styles.closeBtn}
              activeOpacity={0.75}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              accessibilityRole="button"
              accessibilityLabel={t("dashboard.dailyWelcome.close")}
            >
              <Ionicons name="close" size={18} color={colors.navyDeep} />
            </TouchableOpacity>

            <Text style={styles.greeting} numberOfLines={2}>
              {t("dashboard.dailyWelcome.greeting", { name: displayName })}
            </Text>
            {!!quote && <Text style={styles.quote}>“{quote}”</Text>}
          </Animated.View>
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  scrimTint: {
    backgroundColor: withAlpha(colors.shadow, 0.4),
  },
  stage: {
    position: "absolute",
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "flex-end",
  },
  kangarooWrap: {
    zIndex: 2,
  },
  card: {
    flex: 1,
    zIndex: 1,
    // Solid honey note, not glass — the whole point of this redesign.
    backgroundColor: colors.goldLight,
    borderWidth: 1.5,
    borderColor: colors.gold,
    borderRadius: radius.sheet,
    padding: spacing.lg,
    paddingRight: spacing.xxl,
    marginBottom: spacing.md,
    // Softer than the old glass-on-navy shadow — a light card wants a
    // gentler lift, not the heavy drop the dark glass version had.
    shadowColor: colors.navyDark,
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.2,
    shadowRadius: 18,
    elevation: 8,
  },
  closeBtn: {
    position: "absolute",
    top: spacing.md,
    right: spacing.md,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.goldSoft,
    borderWidth: 1,
    borderColor: colors.gold,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 3,
    ...goldButton.glow,
  },
  greeting: {
    fontFamily: fonts.displayBold,
    fontSize: 16,
    fontWeight: "700",
    color: colors.navyDeep,
    marginBottom: 8,
  },
  quote: {
    fontFamily: fonts.body,
    fontSize: 14,
    lineHeight: 20,
    fontStyle: "italic",
    color: withAlpha(colors.navyDeep, 0.82),
  },
});
