import React, { useRef, useState, useEffect } from "react";
import {
  View,
  Text,
  StyleSheet,
  StatusBar,
  ScrollView,
  TouchableOpacity,
  Animated,
  Easing,
  PanResponder,
  Dimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import LottieView from "lottie-react-native";
import { colors, fonts, goldButton, radius } from "../shared/theme";
import { GoldFill } from "../shared/components/GoldButton";
const { width: W } = Dimensions.get("window");
const AUTOPLAY_INTERVAL = 4200;
const SLIDE_DURATION = 460; // eased forward/loop transition
const SWIPE_THRESHOLD = W * 0.22;

/* ------------------------------------------------------------------ */
/* SLIDE 1 — Family coordination: same kangaroo.json Lottie animation   */
/* as the splash screen, for a consistent brand moment.                 */
/* ------------------------------------------------------------------ */
function KangarooHero() {
  return (
    <View
      style={{
        width: "100%",
        height: "100%",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <LottieView
        source={require("../../assets/animations/kangaroo.json")}
        autoPlay
        loop
        style={{ width: 176, height: 176 }}
      />
    </View>
  );
}

/* ------------------------------------------------------------------ */
/* SLIDE 2 — Harmonious organization: todo.json Lottie animation        */
/* ------------------------------------------------------------------ */
function OrganizeHero() {
  return (
    <View
      style={{
        width: "100%",
        height: "100%",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <LottieView
        source={require("../../assets/animations/todo.json")}
        autoPlay
        loop
        style={{ width: 220, height: 220 }}
      />
    </View>
  );
}

/* ------------------------------------------------------------------ */
/* SLIDE 3 — Private by design: Vault.json Lottie animation             */
/* ------------------------------------------------------------------ */
function SecurityHero() {
  return (
    <View
      style={{
        width: "100%",
        height: "100%",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <LottieView
        source={require("../../assets/animations/Vault.json")}
        autoPlay
        loop
        style={{ width: 220, height: 220 }}
      />
    </View>
  );
}

/* ------------------------------------------------------------------ */

const SLIDES = [
  {
    hero: KangarooHero,
    title: "Family coordination",
    body: "Tasks, groceries, schedules, and reminders — all in one place.",
  },
  {
    hero: OrganizeHero,
    title: "Harmonious organization",
    body: "Every shared list, bill, and event sorted beautifully for the whole household.",
  },
  {
    hero: SecurityHero,
    title: "Private by design",
    body: "End-to-end encrypted messages, vaults, and documents — yours alone.",
  },
];
/* Trailing clone of slide 0 lets autoplay/swipe always animate forward,
   even when looping from the last slide back to the first. */
const LOOP_SLIDES = [...SLIDES, SLIDES[0]];
export default function WelcomeScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const [activeSlide, setActiveSlide] = useState(0);
  const activeSlideRef = useRef(0);
  const translateX = useRef(new Animated.Value(0)).current;
  const dragBase = useRef(0);
  const autoplayTimer = useRef(null);

  /* Animate to `page` (0..SLIDES.length). Landing on the trailing clone
     snaps invisibly back to the real first slide once settled. */
  const goToPage = (page, animated = true) => {
    const clamped = Math.max(0, Math.min(SLIDES.length, page));
    Animated.timing(translateX, {
      toValue: -clamped * W,
      duration: animated ? SLIDE_DURATION : 0,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (!finished) return;
      const landedOnClone = clamped === SLIDES.length;
      const settled = landedOnClone ? 0 : clamped;
      if (landedOnClone) translateX.setValue(0);
      activeSlideRef.current = settled;
      setActiveSlide(settled);
    });
  };
  const stopAutoplay = () => {
    if (autoplayTimer.current) {
      clearInterval(autoplayTimer.current);
      autoplayTimer.current = null;
    }
  };
  const startAutoplay = () => {
    stopAutoplay();
    autoplayTimer.current = setInterval(() => {
      goToPage(activeSlideRef.current + 1);
    }, AUTOPLAY_INTERVAL);
  };
  useEffect(() => {
    startAutoplay();
    return stopAutoplay;
  }, []);
  const goToSlide = (idx) => {
    stopAutoplay();
    goToPage(idx);
    startAutoplay();
  };

  /* Drag both pagers together — same translateX drives hero + card in lockstep. */
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_, g) =>
        Math.abs(g.dx) > 8 && Math.abs(g.dx) > Math.abs(g.dy),
      onPanResponderGrant: () => {
        stopAutoplay();
        translateX.stopAnimation((value) => {
          dragBase.current = value;
        });
      },
      onPanResponderMove: (_, g) => {
        const raw = dragBase.current + g.dx;
        const min = -SLIDES.length * W;
        const overdrag =
          raw > 0 ? raw * 0.3 : raw < min ? min + (raw - min) * 0.3 : raw;
        translateX.setValue(overdrag);
      },
      onPanResponderRelease: (_, g) => {
        const passedThreshold =
          Math.abs(g.dx) > SWIPE_THRESHOLD || Math.abs(g.vx) > 0.5;
        let target = activeSlideRef.current;
        if (passedThreshold) target += g.dx < 0 ? 1 : -1;
        goToPage(target);
        startAutoplay();
      },
    }),
  ).current;
  return (
    <View
      style={[
        styles.container,
        {
          paddingTop: insets.top,
        },
      ]}
    >
      <StatusBar barStyle="light-content" backgroundColor={colors.canvas} />

      {/* Hero carousel — eased slide-in-from-right / release-to-left transition */}
      <View style={styles.carousel} {...panResponder.panHandlers}>
        <Animated.View
          style={{
            flexDirection: "row",
            width: W * LOOP_SLIDES.length,
            transform: [
              {
                translateX,
              },
            ],
          }}
        >
          {LOOP_SLIDES.map((slide, i) => {
            const Hero = slide.hero;
            return (
              <View
                key={`hero-${i}`}
                style={{
                  width: W,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <View style={styles.heroBox}>
                  <Hero />
                </View>
              </View>
            );
          })}
        </Animated.View>
      </View>

      {/* Content — pushed down below the hero */}
      <ScrollView
        style={styles.body}
        contentContainerStyle={styles.bodyContent}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.title}>Welcome to Rootaroo</Text>
        <Text style={styles.subtitle}>
          Everything your family needs lives in one place — shared safely,
          organized beautifully, and always with you.
        </Text>

        {/* Feature card — same translateX, always synced with the hero */}
        <View style={styles.cardPager} {...panResponder.panHandlers}>
          <Animated.View
            style={{
              flexDirection: "row",
              width: W * LOOP_SLIDES.length,
              transform: [
                {
                  translateX,
                },
              ],
            }}
          >
            {LOOP_SLIDES.map((slide, i) => (
              <View
                key={`card-${i}`}
                style={{
                  width: W,
                }}
              >
                <View style={styles.cardWrap}>
                  <View style={styles.card}>
                    <Text style={styles.cardTitle}>{slide.title}</Text>
                    <Text style={styles.cardBody}>{slide.body}</Text>
                  </View>
                </View>
              </View>
            ))}
          </Animated.View>
        </View>

        <View style={styles.dotsRow}>
          {SLIDES.map((_, i) => (
            <TouchableOpacity
              key={i}
              onPress={() => goToSlide(i)}
              hitSlop={{
                top: 8,
                bottom: 8,
                left: 4,
                right: 4,
              }}
            >
              <View
                style={[styles.dot, i === activeSlide && styles.dotActive]}
              />
            </TouchableOpacity>
          ))}
        </View>

        <View style={styles.privacyPill}>
          <Text style={styles.privacyText}>🔒 Private by design</Text>
        </View>
      </ScrollView>

      {/* Fixed CTA area */}
      <View
        style={[
          styles.ctaArea,
          {
            paddingBottom: Math.max(insets.bottom, 16) + 24,
          },
        ]}
      >
        <TouchableOpacity
          style={styles.ctaButton}
          activeOpacity={0.85}
          onPress={() => navigation.navigate("ChooseMethod")}
        >
          <GoldFill radius={radius.pill} />
          <Text style={styles.ctaText}>Get Started</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => navigation.navigate("SignIn")}
          hitSlop={{
            top: 10,
            bottom: 10,
            left: 20,
            right: 20,
          }}
        >
          <Text style={styles.existingLink}>I already have an account</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.canvas,
  },
  /* Hero carousel zone — fixed height so the top element never clips */
  carousel: {
    flexGrow: 0,
    height: 230,
    overflow: "hidden",
  },
  heroBox: {
    width: "86%",
    height: 220,
    alignItems: "center",
    justifyContent: "center",
  },
  body: {
    flex: 1,
  },
  bodyContent: {
    paddingTop: 8,
    paddingBottom: 24,
  },
  title: {
    fontFamily: fonts.displayBold,
    fontSize: 26,
    lineHeight: 32.5,
    letterSpacing: -0.01,
    color: colors.ink,
    marginBottom: 10,
    paddingHorizontal: 28,
  },
  subtitle: {
    fontFamily: fonts.body,
    fontSize: 14,
    lineHeight: 21,
    color: colors.textSecondary,
    marginBottom: 22,
    paddingHorizontal: 28,
  },
  /* Feature card pager — full-width pages, swipeable */
  cardPager: {
    flexGrow: 0,
    overflow: "hidden",
  },
  cardWrap: {
    paddingHorizontal: 28,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    padding: 22,
    marginBottom: 16,
    shadowColor: colors.shadow,
    shadowOffset: {
      width: 0,
      height: 10,
    },
    shadowOpacity: 0.06,
    shadowRadius: 28,
    elevation: 4,
  },
  cardTitle: {
    fontFamily: fonts.displayBold,
    fontSize: 16,
    lineHeight: 20.8,
    color: colors.ink,
    marginBottom: 8,
  },
  cardBody: {
    fontFamily: fonts.body,
    fontSize: 13,
    lineHeight: 19.5,
    color: colors.textSecondary,
  },
  dotsRow: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 6,
    marginBottom: 20,
    minHeight: 24,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.divider,
  },
  dotActive: {
    width: 20,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.surfaceRaised,
  },
  privacyPill: {
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 7,
    paddingHorizontal: 14,
    backgroundColor: colors.borderCool,
    borderRadius: radius.pill,
  },
  privacyText: {
    fontFamily: fonts.bodyMedium,
    fontSize: 12,
    lineHeight: 12,
    color: colors.info,
  },
  ctaArea: {
    paddingHorizontal: 28,
    paddingTop: 16,
    backgroundColor: colors.canvas,
  },
  ctaButton: {
    width: "100%",
    height: 54,
    backgroundColor: colors.gold,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 14,
  },
  ctaText: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 15,
    lineHeight: 15,
    color: goldButton.onGold,
  },
  existingLink: {
    fontFamily: fonts.bodyMedium,
    fontSize: 13,
    lineHeight: 13,
    color: colors.ink,
    textAlign: "center",
  },
});
