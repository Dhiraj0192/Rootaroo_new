import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Animated, Easing } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useIsFocused } from '@react-navigation/native';
import Svg, { Path } from 'react-native-svg';
import FeatureTourShell from './FeatureTourShell';
import { Eyebrow, TourCard, TourAvatar, rowDivider } from './tourPrimitives';
import { useReducedMotion } from './useReducedMotion';
import {
  day,
  dayBeats,
  calDays,
  calEvent,
  grocery,
  chat,
  chores,
  ping,
  checkins,
  bill,
  vault,
} from './featureTourContent';
import { colors, fonts, radius, withAlpha } from '../../shared/theme';

// The page starts blank and builds in two layers: the header (eyebrow +
// "One ordinary day") reveals first, on its own — nothing else exists yet —
// then the eight beats stack in one after another. Each beat is itself
// two-stage: its heading (time, gold node, title, sub-line) appears first,
// then — after a real pause, not simultaneously — its preview widget rises
// in underneath. That's the "first the day lays itself out, then the
// widget" reading: you get the line, then the thing that backs it up.
//
// Every duration below is the one source of truth for both the visual
// sequence and the loader duration the shell auto-advances on — the loader
// can never finish before the eighth beat's widget has actually settled,
// because DAY_TOTAL_MS is built from these same numbers, not a guess.
const BEAT_COUNT = dayBeats.length;
const HEADER_ENTER_MS = 560;
const HEADER_RISE_PX = 16;
const HEADING_ENTER_MS = 460;
const HEADING_RISE_PX = 10;
// How long after a beat's heading starts before its widget begins — wide
// enough that the heading has clearly landed and been read before the
// widget shows up underneath it, not a simultaneous double-appear.
const HEADING_TO_WIDGET_MS = 420;
const WIDGET_ENTER_MS = 620;
const RISE_PX = 34;
const SCALE_FROM = 0.95;
// How long a beat's own reveal takes end-to-end, heading start to widget
// fully settled — this is what BEAT_STAGGER_MS is deliberately wide
// relative to, so one beat is mostly done before the next begins.
const BEAT_SETTLE_MS = HEADING_TO_WIDGET_MS + WIDGET_ENTER_MS;
const BEAT_STAGGER_MS = 820;
const SETTLE_BUFFER_MS = 1700;
const DAY_TOTAL_MS =
  HEADER_ENTER_MS + (BEAT_COUNT - 1) * BEAT_STAGGER_MS + BEAT_SETTLE_MS + SETTLE_BUFFER_MS;

// How close a beat must be to the viewport edge before we scroll it back
// into view — mirrors scrollToStep.js's own margin so this reads as the
// same "comfortable reading zone" the rest of the app already uses.
const SCROLL_MARGIN = 110;
// A beat's card is what needs to be visible, not just its top edge — this
// short lead lets the card noticeably start rising before the viewport
// glides up to meet it, so the two motions read as connected rather than
// the scroll pre-empting the card's own entrance.
const SCROLL_LEAD_MS = 160;

/**
 * Step 2 of 4 — the narrative heart of the tour. Eight timestamped beats of
 * one Tuesday, each pairing a plain-language line ("The milk runs out") with
 * a miniature of the screen that handles it.
 *
 * The miniatures are deliberately non-interactive: they are illustrations of
 * the product, not the product. Rendering them as real components would drag
 * live data, permissions and navigation into a screen whose only job is to
 * show what the app feels like.
 *
 * The timeline itself now builds bottom-to-top, one beat at a time, with the
 * screen auto-scrolling to keep the arriving beat in view — see the effect
 * below for how entrance timing, auto-scroll and the shell's loader all stay
 * in sync without hardcoding any of them against a specific phone size.
 */
export default function FeatureDayScreen({ navigation }) {
  const isFocused = useIsFocused();
  const reduceMotion = useReducedMotion();

  const scrollRef = useRef(null);
  const scrollOffsetY = useRef(0);
  const beatRefs = useRef(dayBeats.map(() => React.createRef())).current;
  const headerAnim = useRef({
    opacity: new Animated.Value(0),
    translateY: new Animated.Value(HEADER_RISE_PX),
  }).current;
  const anims = useRef(
    dayBeats.map(() => ({
      heading: {
        opacity: new Animated.Value(0),
        translateY: new Animated.Value(HEADING_RISE_PX),
      },
      widget: {
        opacity: new Animated.Value(0),
        translateY: new Animated.Value(RISE_PX),
        scale: new Animated.Value(SCALE_FROM),
      },
    })),
  ).current;
  const sequenceRef = useRef(null);
  const scrollTimersRef = useRef([]);
  const userInteractingRef = useRef(false);
  const resumeTimerRef = useRef(null);

  const clearScrollTimers = () => {
    scrollTimersRef.current.forEach(clearTimeout);
    scrollTimersRef.current = [];
    if (resumeTimerRef.current) {
      clearTimeout(resumeTimerRef.current);
      resumeTimerRef.current = null;
    }
  };

  const scrollBeatIntoView = (index) => {
    if (userInteractingRef.current) return;
    const target = beatRefs[index]?.current;
    const scrollNode = scrollRef.current;
    if (!target || !scrollNode || typeof target.measureInWindow !== 'function') return;
    target.measureInWindow((tx, ty, tw, th) => {
      if (!tw || !th || typeof scrollNode.measureInWindow !== 'function') return;
      scrollNode.measureInWindow((cx, cy, cw, ch) => {
        const viewportTop = cy;
        const viewportBottom = cy + ch;
        let delta = 0;
        if (ty < viewportTop + SCROLL_MARGIN) {
          delta = ty - (viewportTop + SCROLL_MARGIN);
        } else if (ty + th > viewportBottom - SCROLL_MARGIN) {
          delta = ty + th - (viewportBottom - SCROLL_MARGIN);
        }
        if (delta === 0 || userInteractingRef.current) return;
        const newY = Math.max(scrollOffsetY.current + delta, 0);
        scrollNode.scrollTo({ y: newY, animated: true });
      });
    });
  };

  const snapToFinal = () => {
    sequenceRef.current?.stop?.();
    clearScrollTimers();
    headerAnim.opacity.setValue(1);
    headerAnim.translateY.setValue(0);
    anims.forEach((a) => {
      a.heading.opacity.setValue(1);
      a.heading.translateY.setValue(0);
      a.widget.opacity.setValue(1);
      a.widget.translateY.setValue(0);
      a.widget.scale.setValue(1);
    });
  };

  useEffect(() => {
    if (!isFocused) return undefined;

    if (reduceMotion) {
      snapToFinal();
      return undefined;
    }

    headerAnim.opacity.setValue(0);
    headerAnim.translateY.setValue(HEADER_RISE_PX);
    anims.forEach((a) => {
      a.heading.opacity.setValue(0);
      a.heading.translateY.setValue(HEADING_RISE_PX);
      a.widget.opacity.setValue(0);
      a.widget.translateY.setValue(RISE_PX);
      a.widget.scale.setValue(SCALE_FROM);
    });

    // The page starts blank: the header reveals on its own first, then the
    // beats begin their cascade. Each beat's own animation is a parallel
    // group where the widget timings carry an internal `delay`, so the
    // heading visibly lands before the widget starts rising underneath it.
    sequenceRef.current = Animated.sequence([
      Animated.parallel([
        Animated.timing(headerAnim.opacity, {
          toValue: 1,
          duration: HEADER_ENTER_MS,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(headerAnim.translateY, {
          toValue: 0,
          duration: HEADER_ENTER_MS,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
      ]),
      Animated.stagger(
        BEAT_STAGGER_MS,
        anims.map((a) =>
          Animated.parallel([
            Animated.timing(a.heading.opacity, {
              toValue: 1,
              duration: HEADING_ENTER_MS,
              easing: Easing.out(Easing.cubic),
              useNativeDriver: true,
            }),
            Animated.timing(a.heading.translateY, {
              toValue: 0,
              duration: HEADING_ENTER_MS,
              easing: Easing.out(Easing.cubic),
              useNativeDriver: true,
            }),
            Animated.timing(a.widget.opacity, {
              toValue: 1,
              duration: WIDGET_ENTER_MS,
              delay: HEADING_TO_WIDGET_MS,
              easing: Easing.out(Easing.cubic),
              useNativeDriver: true,
            }),
            Animated.timing(a.widget.translateY, {
              toValue: 0,
              duration: WIDGET_ENTER_MS,
              delay: HEADING_TO_WIDGET_MS,
              easing: Easing.out(Easing.cubic),
              useNativeDriver: true,
            }),
            // A gentle scale-up alongside the widget's rise and fade gives
            // it a touch more physicality — it settles into its spot
            // rather than just fading into position.
            Animated.timing(a.widget.scale, {
              toValue: 1,
              duration: WIDGET_ENTER_MS,
              delay: HEADING_TO_WIDGET_MS,
              easing: Easing.out(Easing.cubic),
              useNativeDriver: true,
            }),
          ]),
        ),
      ),
    ]);
    sequenceRef.current.start();

    // Auto-scroll is scheduled off the same constants that drive the
    // entrance, not measured/guessed — beat i's heading starts at
    // HEADER_ENTER_MS + i * BEAT_STAGGER_MS, and the scroll follows a beat
    // past behind it by SCROLL_LEAD_MS so the heading is visibly already
    // rising before the viewport glides up to meet it.
    scrollTimersRef.current = dayBeats.map((_, i) =>
      setTimeout(
        () => scrollBeatIntoView(i),
        HEADER_ENTER_MS + i * BEAT_STAGGER_MS + SCROLL_LEAD_MS,
      ),
    );

    // A closing flourish once the eighth beat's widget has visibly settled:
    // glide the rest of the way to the bottom so the whole built timeline —
    // including the closing line under the last beat — is actually on
    // screen, rather than trusting per-beat scrolling alone to have landed
    // exactly there.
    scrollTimersRef.current.push(
      setTimeout(() => {
        if (userInteractingRef.current) return;
        scrollRef.current?.scrollToEnd?.({ animated: true });
      }, HEADER_ENTER_MS + (BEAT_COUNT - 1) * BEAT_STAGGER_MS + BEAT_SETTLE_MS + 200),
    );

    return () => {
      sequenceRef.current?.stop?.();
      clearScrollTimers();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFocused, reduceMotion]);

  const handleScrollBeginDrag = () => {
    userInteractingRef.current = true;
    clearScrollTimers();
  };
  const handleScrollEndDrag = () => {
    // A short cooldown before auto-scroll could resume — long enough that
    // we never fight a user who just let go, and the remaining beats simply
    // finish settling wherever the user left the viewport.
    resumeTimerRef.current = setTimeout(() => {
      userInteractingRef.current = false;
    }, 600);
  };

  return (
    <FeatureTourShell
      step={1}
      navigation={navigation}
      header={
        <Animated.View
          style={{ opacity: headerAnim.opacity, transform: [{ translateY: headerAnim.translateY }] }}
        >
          <Eyebrow>{day.eyebrow}</Eyebrow>
          <Text style={styles.title}>{day.title}</Text>
        </Animated.View>
      }
      onContinue={() => navigation.navigate('FeaturePrivacy')}
      autoAdvanceMs={DAY_TOTAL_MS}
      hideControls
      scrollRef={scrollRef}
      scrollViewProps={{
        scrollEventThrottle: 16,
        onScroll: (e) => {
          scrollOffsetY.current = e.nativeEvent.contentOffset.y;
        },
        // Deliberately NOT wiring onMomentumScrollBegin/End here — our own
        // auto-scroll calls scrollTo({animated:true}), and RN fires momentum
        // events for a programmatic animated scroll exactly as it would for
        // a user's flick. Treating those as "user is interacting" was
        // clearing every remaining scroll timer the instant beat 0's own
        // auto-scroll animation started, which is why only the first beat
        // ever scrolled into view. onScrollBeginDrag only ever fires from an
        // actual touch, so it's the only reliable "user took over" signal.
        onScrollBeginDrag: handleScrollBeginDrag,
        onScrollEndDrag: handleScrollEndDrag,
      }}
    >
      {dayBeats.map((beat, i) => (
        <Beat
          key={beat.kind}
          beat={beat}
          last={i === dayBeats.length - 1}
          anim={anims[i]}
          beatRef={beatRefs[i]}
        />
      ))}
    </FeatureTourShell>
  );
}

/**
 * One timeline row: time gutter, rule with a gold node, then the card —
 * revealed in two stages. The heading (time, node, title, sub-line) fades
 * and rises in first; the preview widget underneath it follows afterward,
 * on its own opacity/translateY/scale, so "the day lays itself out" and
 * then "the widget" read as two distinct beats, not one simultaneous block.
 */
function Beat({ beat, last, anim, beatRef }) {
  return (
    <View ref={beatRef} collapsable={false}>
      <Animated.View
        style={[
          styles.beat,
          {
            opacity: anim.heading.opacity,
            transform: [{ translateY: anim.heading.translateY }],
          },
        ]}
      >
        <View style={styles.gutter}>
          <Text style={styles.time}>{beat.time}</Text>
          <Text style={styles.meridiem}>{beat.meridiem}</Text>
        </View>
        <View style={[styles.track, last && styles.trackLast]}>
          <View style={styles.node} />
          <Text style={styles.beatTitle}>{beat.title}</Text>
          <Text style={styles.beatSub}>{beat.sub}</Text>
          <Animated.View
            style={[
              styles.preview,
              {
                opacity: anim.widget.opacity,
                transform: [{ translateY: anim.widget.translateY }, { scale: anim.widget.scale }],
              },
            ]}
          >
            {PREVIEWS[beat.kind]()}
          </Animated.View>
          {last ? <Text style={styles.closing}>{day.closing}</Text> : null}
        </View>
      </Animated.View>
    </View>
  );
}

/* ── The eight miniatures ─────────────────────────────────────────────── */

const PREVIEWS = {
  calendar: () => (
    <TourCard style={styles.pad}>
      <View style={styles.calRow}>
        {calDays.map((d) => (
          <View key={d.label} style={[styles.calDay, d.on && styles.calDayOn]}>
            <Text style={[styles.calLabel, d.on && styles.calLabelOn]}>{d.label}</Text>
            <Text style={[styles.calNum, d.on && styles.calNumOn]}>{d.num}</Text>
          </View>
        ))}
      </View>
      <View style={[styles.rowDivided, styles.calEvent]}>
        <View style={styles.eventBar} />
        <View style={styles.grow}>
          <Text style={styles.rowTitle}>{calEvent.title}</Text>
          <Text style={styles.rowMeta}>{calEvent.meta}</Text>
        </View>
        <TourAvatar name={calEvent.initial} size={24} />
      </View>
    </TourCard>
  ),

  grocery: () => (
    <TourCard style={styles.padList}>
      {grocery.map((g, i) => (
        <View key={g.name} style={[styles.listRow, i > 0 && styles.listRowDivided]}>
          <Checkbox done={g.done} />
          <Text
            style={[styles.grow, styles.rowTitle, g.done && styles.rowTitleDone]}
            numberOfLines={1}
          >
            {g.name}
          </Text>
          <Text style={styles.by}>{g.by}</Text>
        </View>
      ))}
    </TourCard>
  ),

  chat: () => (
    <View style={styles.chatWrap}>
      <View style={styles.outRow}>
        <LinearGradient
          colors={[colors.goldGlowSoft, colors.goldWarmDark]}
          start={{ x: 0.2, y: 0 }}
          end={{ x: 0.9, y: 1 }}
          style={styles.outBubble}
        >
          <Text style={styles.outText}>{chat.outgoing}</Text>
        </LinearGradient>
      </View>
      <View style={styles.inRow}>
        <TourAvatar name={chat.incomingInitial} size={24} />
        <View style={styles.inBubble}>
          <Text style={styles.inText}>{chat.incoming}</Text>
        </View>
      </View>
    </View>
  ),

  chores: () => (
    <TourCard style={styles.pad}>
      {chores.map((c, i) => (
        <View key={c.title} style={[styles.choreRow, i > 0 && styles.rowDivided]}>
          {c.done ? (
            <View style={styles.choreBoxOn}>
              <Tick color={goldOnTick} />
            </View>
          ) : (
            <View style={styles.choreBoxOff} />
          )}
          <View style={styles.grow}>
            <Text style={[styles.rowTitle, c.done && styles.rowTitleDone]}>{c.title}</Text>
            <Text style={styles.rowMeta}>{c.meta}</Text>
          </View>
          <TourAvatar name={c.initial} size={24} />
        </View>
      ))}
    </TourCard>
  ),

  ping: () => (
    <LinearGradient
      colors={[withAlpha(colors.goldGlow, 0.16), colors.surface, colors.surface]}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={styles.pingCard}
    >
      <View style={styles.pingRow}>
        <View>
          <TourAvatar name={ping.initial} size={42} style={styles.pingAvatar} />
          <View style={styles.pingBadge}>
            <Svg width={9} height={9} viewBox="0 0 24 24" fill="none">
              <Path
                d="M18 15V10a6 6 0 1 0-12 0v5l-1.5 2.5h15L18 15Z"
                stroke={goldOnTick}
                strokeWidth={3}
                strokeLinecap="round"
              />
            </Svg>
          </View>
        </View>
        <View style={styles.grow}>
          <Text style={styles.pingTitle}>{ping.title}</Text>
          <Text style={styles.pingBody}>{ping.body}</Text>
        </View>
      </View>
    </LinearGradient>
  ),

  checkins: () => (
    <View style={styles.checkinRow}>
      {checkins.map((c, i) => (
        <TourCard
          key={`${c.initial}-${i}`}
          style={[styles.checkin, !c.home && styles.checkinAway]}
        >
          <View>
            <TourAvatar name={c.initial} size={34} />
            <View style={[styles.statusDot, { backgroundColor: c.home ? colors.successBright : colors.gold }]} />
          </View>
          <Text style={[styles.checkinState, !c.home && styles.checkinStateAway]}>{c.state}</Text>
        </TourCard>
      ))}
    </View>
  ),

  bill: () => (
    <TourCard style={styles.pad}>
      <View style={styles.billHead}>
        <View>
          <Text style={styles.microLabel}>{bill.label}</Text>
          <Text style={styles.billTotal}>{bill.total}</Text>
        </View>
        <View style={styles.right}>
          <Text style={styles.microLabel}>{bill.owedLabel}</Text>
          <Text style={styles.billOwed}>{bill.owed}</Text>
        </View>
      </View>
      {/* Three bars, one per person — the split, at a glance. */}
      <View style={styles.splitRow}>
        <View style={[styles.splitBar, { backgroundColor: colors.gold }]} />
        <View style={[styles.splitBar, { backgroundColor: colors.avatarMoss }]} />
        <View style={[styles.splitBar, { backgroundColor: colors.avatarSlate }]} />
      </View>
    </TourCard>
  ),

  vault: () => (
    <TourCard style={styles.padList}>
      {vault.map((v, i) => (
        <View key={v.name} style={[styles.listRow, i > 0 && styles.listRowDivided]}>
          <View style={styles.vaultIcon}>
            <View style={styles.lockShackle} />
            <View style={styles.lockBody} />
          </View>
          <View style={styles.grow}>
            <Text style={styles.rowTitle} numberOfLines={1}>
              {v.name}
            </Text>
            <Text style={styles.rowMeta}>{v.meta}</Text>
          </View>
        </View>
      ))}
    </TourCard>
  ),
};

const goldOnTick = '#171208';

function Checkbox({ done }) {
  return (
    <View style={[styles.checkbox, done && styles.checkboxOn]}>
      {done ? <Tick color={goldOnTick} /> : null}
    </View>
  );
}

/** A checkmark drawn as SVG — the mock builds it from rotated borders. */
function Tick({ color }) {
  return (
    <Svg width={10} height={10} viewBox="0 0 24 24" fill="none">
      <Path d="M5 12.5l5 5 9-10" stroke={color} strokeWidth={3.2} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

const styles = StyleSheet.create({
  title: {
    fontFamily: fonts.display,
    fontSize: 23,
    lineHeight: 29,
    fontWeight: '800',
    letterSpacing: -0.6,
    color: colors.ink,
    marginTop: 6,
  },

  beat: { flexDirection: 'row', gap: 14 },
  gutter: { width: 52, paddingTop: 2 },
  time: {
    fontFamily: fonts.mono,
    fontSize: 12,
    fontWeight: '800',
    color: colors.gold,
  },
  meridiem: {
    fontFamily: fonts.bodyBold,
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1.1,
    color: colors.textFaint,
    marginTop: 3,
  },

  // The rule is the row's own left border, so it runs exactly as far as the
  // content beside it — no absolutely-positioned line to keep in sync.
  track: {
    flex: 1,
    minWidth: 0,
    borderLeftWidth: 1,
    borderLeftColor: withAlpha(colors.white, 0.07),
    paddingLeft: 16,
    paddingBottom: 22,
  },
  trackLast: { paddingBottom: 10 },
  node: {
    position: 'absolute',
    left: -4.5,
    top: 4,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.gold,
  },

  beatTitle: {
    fontFamily: fonts.bodyBold,
    fontSize: 14,
    fontWeight: '700',
    color: colors.inkDeep,
  },
  beatSub: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 12,
    fontWeight: '600',
    color: colors.textMuted,
    marginTop: 3,
  },
  preview: { marginTop: 11 },

  closing: {
    fontFamily: fonts.body,
    fontStyle: 'italic',
    fontSize: 15,
    lineHeight: 23,
    color: colors.textSecondary,
    marginTop: 14,
  },

  /* Shared card internals */
  pad: { paddingHorizontal: 14, paddingVertical: 13 },
  padList: { paddingHorizontal: 14, paddingVertical: 4 },
  grow: { flex: 1, minWidth: 0 },
  right: { alignItems: 'flex-end' },
  rowTitle: {
    fontFamily: fonts.bodyBold,
    fontSize: 13.5,
    fontWeight: '700',
    color: colors.inkSoft,
  },
  rowTitleDone: {
    color: colors.textMuted,
    textDecorationLine: 'line-through',
  },
  rowMeta: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 11.5,
    fontWeight: '600',
    color: colors.textMuted,
    marginTop: 2,
  },
  rowDivided: {
    marginTop: 13,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: rowDivider,
  },

  listRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    paddingVertical: 11,
  },
  listRowDivided: {
    borderTopWidth: 1,
    borderTopColor: rowDivider,
  },
  by: {
    fontFamily: fonts.bodyBold,
    fontSize: 11,
    fontWeight: '700',
    color: colors.textMuted,
  },

  /* Calendar */
  calRow: { flexDirection: 'row', gap: 6 },
  calDay: {
    flex: 1,
    borderRadius: 10,
    backgroundColor: withAlpha(colors.white, 0.03),
    borderWidth: 1,
    borderColor: withAlpha(colors.white, 0.06),
    paddingVertical: 7,
    alignItems: 'center',
  },
  calDayOn: {
    backgroundColor: withAlpha(colors.gold, 0.18),
    borderColor: withAlpha(colors.gold, 0.6),
  },
  calLabel: {
    fontFamily: fonts.bodyBold,
    fontSize: 8.5,
    fontWeight: '800',
    letterSpacing: 0.85,
    color: colors.textFaint,
  },
  calLabelOn: { color: colors.gold },
  calNum: {
    fontFamily: fonts.mono,
    fontSize: 13,
    fontWeight: '800',
    color: colors.textMuted,
    marginTop: 3,
  },
  calNumOn: { color: colors.goldGlowPale },
  calEvent: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  eventBar: {
    width: 3,
    height: 30,
    borderRadius: 99,
    backgroundColor: colors.gold,
  },

  /* Grocery */
  checkbox: {
    width: 19,
    height: 19,
    borderRadius: 7,
    borderWidth: 2,
    borderColor: withAlpha(colors.white, 0.18),
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxOn: {
    borderColor: colors.gold,
    backgroundColor: colors.gold,
  },

  /* Chat */
  chatWrap: { gap: 9 },
  outRow: { flexDirection: 'row', justifyContent: 'flex-end' },
  outBubble: {
    maxWidth: '84%',
    paddingHorizontal: 13,
    paddingVertical: 10,
    borderRadius: 16,
    borderBottomRightRadius: 5,
  },
  outText: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 13.5,
    lineHeight: 19,
    fontWeight: '600',
    color: '#1A1408',
  },
  inRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 9 },
  inBubble: {
    maxWidth: '78%',
    paddingHorizontal: 13,
    paddingVertical: 10,
    borderRadius: 16,
    borderBottomLeftRadius: 5,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: withAlpha(colors.white, 0.07),
  },
  inText: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 13.5,
    lineHeight: 19,
    fontWeight: '600',
    color: colors.inkSoft,
  },

  /* Chores */
  choreRow: { flexDirection: 'row', alignItems: 'center', gap: 11 },
  choreBoxOn: {
    width: 21,
    height: 21,
    borderRadius: 8,
    backgroundColor: colors.gold,
    alignItems: 'center',
    justifyContent: 'center',
  },
  choreBoxOff: {
    width: 21,
    height: 21,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: withAlpha(colors.white, 0.18),
  },

  /* Ping */
  pingCard: {
    borderRadius: radius.cardLg,
    borderWidth: 1.5,
    borderColor: withAlpha(colors.gold, 0.4),
    padding: 14,
    overflow: 'hidden',
  },
  pingRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  pingAvatar: {
    borderWidth: 2,
    borderColor: withAlpha(colors.gold, 0.5),
  },
  pingBadge: {
    position: 'absolute',
    right: -4,
    bottom: -4,
    width: 19,
    height: 19,
    borderRadius: 10,
    backgroundColor: colors.goldSoft,
    borderWidth: 2.5,
    borderColor: colors.canvasBright,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pingTitle: {
    fontFamily: fonts.display,
    fontSize: 14.5,
    fontWeight: '800',
    color: colors.ink,
  },
  pingBody: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 12,
    fontWeight: '600',
    color: colors.inkMuted,
    marginTop: 3,
  },

  /* Check-ins */
  checkinRow: { flexDirection: 'row', gap: 9 },
  checkin: {
    flex: 1,
    minWidth: 0,
    borderRadius: radius.lg,
    paddingVertical: 12,
    paddingHorizontal: 8,
    alignItems: 'center',
    gap: 7,
  },
  checkinAway: { borderColor: withAlpha(colors.gold, 0.28) },
  statusDot: {
    position: 'absolute',
    right: -1,
    bottom: -1,
    width: 11,
    height: 11,
    borderRadius: 6,
    borderWidth: 2.5,
    borderColor: colors.canvasBright,
  },
  checkinState: {
    fontFamily: fonts.bodyBold,
    fontSize: 10.5,
    fontWeight: '700',
    color: colors.textSecondary,
    textAlign: 'center',
  },
  checkinStateAway: { color: colors.gold },

  /* Split bill */
  billHead: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' },
  microLabel: {
    fontFamily: fonts.bodyBold,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.4,
    color: colors.textMuted,
  },
  billTotal: {
    fontFamily: fonts.mono,
    fontSize: 26,
    fontWeight: '800',
    letterSpacing: -0.5,
    color: colors.ink,
    marginTop: 7,
  },
  billOwed: {
    fontFamily: fonts.mono,
    fontSize: 19,
    fontWeight: '800',
    color: colors.successBright,
    marginTop: 7,
  },
  splitRow: { flexDirection: 'row', gap: 4, marginTop: 13 },
  splitBar: { flex: 1, height: 5, borderRadius: 99 },

  /* Vault */
  vaultIcon: {
    width: 30,
    height: 30,
    borderRadius: 10,
    backgroundColor: withAlpha(colors.gold, 0.1),
    borderWidth: 1,
    borderColor: withAlpha(colors.gold, 0.24),
    alignItems: 'center',
    justifyContent: 'center',
  },
  lockShackle: {
    width: 8,
    height: 5,
    borderWidth: 1.6,
    borderBottomWidth: 0,
    borderColor: colors.gold,
    borderTopLeftRadius: 5,
    borderTopRightRadius: 5,
    marginBottom: -1,
  },
  lockBody: {
    width: 13,
    height: 9,
    borderRadius: 3,
    backgroundColor: colors.gold,
  },
});
