import React, {
  useEffect,
  useState,
  useCallback,
  useRef,
  useMemo,
} from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  StatusBar,
  Image,
  Modal,
  Platform,
  TextInput,
  Animated,
  Easing,
  Dimensions,
} from "react-native";
import { showAlert } from "../shared/services/themedAlert";
import { useNavigation, useFocusEffect } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { BlurView } from "expo-blur";
import Svg, { Circle, SvgXml } from "react-native-svg";
import ConfettiCannon from "react-native-confetti-cannon";
import { Ionicons } from "@expo/vector-icons";
import { dashboardApi } from "../shared/api/dashboard";
import { notificationApi } from "../shared/api/notification";
import * as NavigationBar from "expo-navigation-bar";
import { useAuthStore } from "../shared/store/authStore";
import { householdApi } from "../shared/api/household";
import { useFeedStore } from "../shared/store/feedStore";
import { useEngagementStore } from "../shared/store/engagementStore";
import { useFeedPhotos } from "../shared/hooks/useFeedPhotos";
import { taskApi } from "../shared/api/task";
import { expenseApi } from "../shared/api/expense";
import { vaultApi } from "../shared/api/vault";
import { eventApi } from "../shared/api/event";
import { homeRequests } from "../shared/cache/homePrefetch";
import { readCache, writeCache } from "../shared/cache/screenCache";
import { weatherApi } from "../shared/api/weather";
import * as Location from "expo-location";
import { ensureLocation } from "../shared/permissions";
import { colors, fonts, goldButton, radius, spacing, withAlpha } from '../shared/theme';
import { GoldFill } from '../shared/components/GoldButton';
import Avatar from "../components/Avatar";
import LoadingSkeleton from "../components/LoadingSkeleton";
import { KeyboardAvoider } from "../shared/components/KeyboardAware";
import GlassCard, { GlassSheen } from "../shared/components/GlassCard";
import { useTranslation } from "react-i18next";
import { useDailyWelcome } from "../shared/hooks/useDailyWelcome";
import DailyWelcomeOverlay from "../shared/components/DailyWelcomeOverlay";
import { SpotlightTourProvider, AttachStep } from "react-native-spotlight-tour";
import TourTooltip from "../shared/components/TourTooltip";
import { scrollToStep } from "../shared/utils/scrollToStep";
import ContributorsStrip from "../shared/components/ContributorsStrip";
import { useTabBarDockHeight } from "../shared/hooks/useTabBarDockHeight";

/* ═══════════════════════════════════════════════
   Dashboard · Night glass
   Deep navy ambient field · tiled doodle backdrop ·
   gradient-filled frosted cards · gold ember accents.
   Same widgets, data and handlers as before.
   ═══════════════════════════════════════════════ */

const GOLD = colors.goldGlow;

/* Ambient navy field — radial washes behind the glass. Stretched to fill. */
const AMBIENT_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" preserveAspectRatio="none">
  <defs>
    <radialGradient id="lift" cx="0.12" cy="-0.06" r="0.75">
      <stop offset="0" stop-color="${colors.navyLift}" stop-opacity="1"/>
      <stop offset="1" stop-color="${colors.navyLift}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="ember" cx="0.96" cy="0.10" r="0.55">
      <stop offset="0" stop-color="${colors.goldGlow}" stop-opacity="0.16"/>
      <stop offset="1" stop-color="${colors.goldGlow}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="floor" cx="0.5" cy="1.05" r="0.65">
      <stop offset="0" stop-color="${colors.navyMid}" stop-opacity="1"/>
      <stop offset="1" stop-color="${colors.navyMid}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="100" height="100" fill="${colors.navyBase}"/>
  <rect width="100" height="100" fill="url(#lift)"/>
  <rect width="100" height="100" fill="url(#ember)"/>
  <rect width="100" height="100" fill="url(#floor)"/>
</svg>`;

// Notification bell (Feather "bell") — Dashboard top-right.
const BELL_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${colors.textOnDark}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
  <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
</svg>`;
function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return "Good morning,";
  if (h < 18) return "Good afternoon,";
  return "Good evening,";
}
function formatDate() {
  return new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}
function initials(name) {
  return name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}
function timeHM(iso) {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}
function startOfWeek(d) {
  const day = new Date(d);
  day.setDate(day.getDate() - ((day.getDay() + 6) % 7)); // Monday
  day.setHours(0, 0, 0, 0);
  return day;
}
function sameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/* ── Widget label (11px w600 ls 0.5, muted slate) ── */
function WidgetLabel({ children, color = colors.textOnDarkLabel, style }) {
  return (
    <Text
      style={[
        styles.widgetLabel,
        {
          color,
        },
        style,
      ]}
    >
      {children}
    </Text>
  );
}

/* ── Gradient sheen + glass card ──────────────────────────────────
   The goldish-glass recipe (diagonal sheen gradient over a translucent
   dark panel) now lives in the shared GlassCard component — this was its
   original, most-refined implementation, extracted so every other screen
   reaches for the same thing instead of re-deriving it. Aliased to the
   names this file already uses so none of its many call sites change.

   tone 'gold'  → primary (brand gold), for accent surfaces.
   tone 'blue'  → secondary (navy lift), for the hero.
   default      → neutral white glass.                              */
const CardSheen = GlassSheen;
const Card = GlassCard;

/* ── Streak ring — SVG arc, gold sweep over a faint track ── */
function StreakRing({ value, progress }) {
  const size = 92;
  const stroke = 7;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(1, progress));
  return (
    <View style={styles.ringWrap}>
      <Svg width={size} height={size}>
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={withAlpha(colors.white, 0.1)}
          strokeWidth={stroke}
          fill="none"
        />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={GOLD}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${c * pct} ${c}`}
          fill="none"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </Svg>
      <View style={styles.ringInner} pointerEvents="none">
        <Text style={styles.ringNum}>{value}</Text>
        <Text style={styles.ringUnit}>DAYS</Text>
      </View>
    </View>
  );
}
export default function DashboardScreen() {
  const nav = useNavigation();
  const insets = useSafeAreaInsets();
  const dockHeight = useTabBarDockHeight();
  const user = useAuthStore((s) => s.user);
  const householdId = useAuthStore((s) => s.householdId);
  const celebrate = useAuthStore((s) => s.celebrate);
  const clearCelebration = useAuthStore((s) => s.clearCelebration);
  const showTour = useAuthStore((s) => s.showTour);
  const dismissTour = useAuthStore((s) => s.dismissTour);
  const triggerFeedTour = useAuthStore((s) => s.triggerFeedTour);

  // Daily Welcome Quote — first Dashboard visit of the local calendar day,
  // per authenticated member. Trigger/persistence/quote-selection logic all
  // lives in useDailyWelcome + dailyWelcomePersist; Dashboard only supplies
  // the member id and quote count and renders the overlay. Declared up here
  // (rather than further down, where it's used) so the App Tour effect
  // below can read `dailyWelcome.visible`.
  const { t } = useTranslation();
  const dailyWelcomeQuotes = t("dashboard.dailyWelcome.quotes", {
    returnObjects: true,
  });
  const dailyWelcomeQuoteCount = Array.isArray(dailyWelcomeQuotes)
    ? dailyWelcomeQuotes.length
    : 0;
  const dailyWelcome = useDailyWelcome(user?.id, dailyWelcomeQuoteCount);

  const scrollRef = useRef(null);
  const scrollOffsetY = useRef(0);
  const bellRef = useRef(null);
  const streakRef = useRef(null);
  const calendarRef = useRef(null);
  const tasksRef = useRef(null);
  const quickActionsRef = useRef(null);
  const vaultRef = useRef(null);
  const tourRef = useRef(null);
  // Stable reference across re-renders — an inline array literal here would
  // recreate on every Dashboard render (data refresh, focus effects, etc.)
  // and restart the tour's in-flight scroll sequence each time.
  const tourSteps = useMemo(() => {
    const meta = [
      {
        ref: bellRef,
        title: "Notifications",
        body: "Tap here to see updates from your household.",
      },
      {
        ref: streakRef,
        title: "Family Streak",
        body: "Keep your family's daily streak going by staying active together.",
      },
      {
        ref: calendarRef,
        title: "Calendar",
        body: "See upcoming events and tap any day to check what's planned.",
      },
      {
        ref: tasksRef,
        title: "Tasks",
        body: "Track shared to-dos and see what's pending.",
      },
      {
        ref: quickActionsRef,
        title: "Quick Actions",
        body: "Send an instant status update — Home, On My Way, Safe, or Groceries.",
      },
      {
        ref: vaultRef,
        title: "Vault",
        body: "Store family documents and photos, encrypted and private.",
      },
    ];
    return meta.map(({ ref, title, body }, i) => ({
      before: () => scrollToStep(scrollRef, scrollOffsetY, ref),
      render: (props) => {
        const isChainLast = i === meta.length - 1;
        return (
          <TourTooltip
            {...props}
            title={title}
            body={body}
            total={meta.length}
            continueLabel={isChainLast ? "Continue to Feed" : undefined}
            onContinue={
              isChainLast
                ? () => {
                    props.stop();
                    nav.navigate("FeedStack");
                    triggerFeedTour();
                  }
                : undefined
            }
          />
        );
      },
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // SpotlightTourProvider's ref (set via useImperativeHandle, a layout effect)
  // isn't guaranteed attached by the time this passive effect first runs under
  // this app's bridgeless/Fabric setup, and how long it takes varies with
  // device load — poll every frame, uncapped, until unmount rather than
  // assume it's ready on the first pass or give up after a fixed count.
  useEffect(() => {
    if (!showTour) return;
    let cancelled = false;
    const tryStart = () => {
      if (cancelled) return;
      if (tourRef.current) {
        tourRef.current.start();
        dismissTour();
      } else {
        requestAnimationFrame(tryStart);
      }
    };
    tryStart();
    return () => {
      cancelled = true;
    };
  }, [showTour, dismissTour]);
  const engagementEventAt = useEngagementStore((s) => s.lastEventAt);
  const [showConfetti, setShowConfetti] = useState(false);

  // Existing first-login celebration stays independent of the Daily Welcome
  // trigger — it still fires purely off `celebrate`, never off whether the
  // welcome is showing. The only thing coordinated here is *timing*, so a
  // brand-new account doesn't get both firing on top of each other: a short
  // delay gives useDailyWelcome's async SecureStore check a moment to
  // resolve before confetti decides whether the welcome is currently up.
  const pendingCelebrationRef = useRef(false);
  useEffect(() => {
    if (!celebrate) return undefined;
    const timer = setTimeout(() => {
      if (dailyWelcome.visible) {
        pendingCelebrationRef.current = true;
        return;
      }
      setShowConfetti(true);
      clearCelebration();
    }, 200);
    return () => clearTimeout(timer);
  }, [celebrate, clearCelebration, dailyWelcome.visible]);
  const handleDailyWelcomeDismiss = useCallback(() => {
    dailyWelcome.dismiss();
    if (pendingCelebrationRef.current) {
      pendingCelebrationRef.current = false;
      setShowConfetti(true);
      clearCelebration();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearCelebration]);

  // Every Home widget starts from last session's data (screenCache) so a
  // cold start paints immediately; load() below refreshes it in place.
  const [data, setData] = useState(() => readCache("home:dashboard") ?? null);
  const [unreadCount, setUnreadCount] = useState(
    () => readCache("home:dashboard")?.notifications?.unreadCount || 0,
  );
  const [members, setMembers] = useState(() => readCache("home:members") || []);
  const [loading, setLoading] = useState(() => !readCache("home:dashboard"));
  const [refreshing, setRefreshing] = useState(false);
  const [fetchError, setFetchError] = useState(false);
  const [weather, setWeather] = useState(null);

  // Widget data
  const [coverPhotoUrl, setCoverPhotoUrl] = useState(
    () => readCache("home:cover") ?? null,
  );
  const [pendingTasks, setPendingTasks] = useState(
    () => readCache("home:pendingTasks") || [],
  );
  const [oweText, setOweText] = useState(null);
  const [oweName, setOweName] = useState(null);
  const [latestDoc, setLatestDoc] = useState(null);
  const [latestDocTime, setLatestDocTime] = useState("");
  // Shared with the photo gallery — one fetch, one copy of the photo list.
  // autoLoad off: the focus effect below already fetches, including on mount.
  const feedPhotos = useFeedPhotos({ autoLoad: false });
  const refreshFeed = useFeedStore((s) => s.fetchFeed);
  // Two stacked image layers that ping-pong: the hidden one is swapped to the
  // upcoming photo while it is still invisible, so a visible layer's source
  // never changes mid-fade.
  const [feedSlots, setFeedSlots] = useState([null, null]);
  const feedFade = useRef(new Animated.Value(0)).current; // 0 → slot A, 1 → slot B
  const feedFadeInverse = useRef(
    feedFade.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
  ).current;
  const feedIndexRef = useRef(0); // index of the photo currently on screen
  const feedTopRef = useRef(0); // which slot is currently visible

  // Calendar + household widgets (real data)
  const [events, setEvents] = useState(() => readCache("home:events") || []);
  const [weekAnchor, setWeekAnchor] = useState(() => startOfWeek(new Date()));
  const [selectedDate, setSelectedDate] = useState(() => new Date());

  // Streak strip — which of the 7 days the detail line describes (6 = today)
  const [streakIdx, setStreakIdx] = useState(6);

  // Quick notify
  const [showPicker, setShowPicker] = useState(false);
  const [pendingAction, setPendingAction] = useState("");
  const [customMsg, setCustomMsg] = useState("");
  const [selMembers, setSelMembers] = useState(new Set());
  const [sending, setSending] = useState(false);
  // Throttles the focus-triggered refetch below so switching tabs quickly
  // doesn't hammer the API — still catches "did something elsewhere, came
  // back to Home" without a manual pull-to-refresh.
  const lastLoadAtRef = useRef(0);
  // The first load picks up the requests prefetched during the splash
  // (homePrefetch); every later one (focus, pull, live events) goes fresh.
  const firstLoadRef = useRef(true);

  // Weather pill next to the greeting — best-effort, once per mount. Silent
  // permission ask (no primer sheet) since a weather widget isn't worth
  // interrupting the dashboard for; if location is denied or the lookup
  // fails, the pill just never appears.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (!(await ensureLocation({ silent: true }))) return;
        let pos = await Location.getLastKnownPositionAsync();
        if (!pos) {
          pos = await Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.Low,
          });
        }
        const result = await weatherApi.get(
          pos.coords.latitude,
          pos.coords.longitude,
        );
        if (!cancelled) setWeather(result);
      } catch {
        /* no weather pill this session — non-critical */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const load = useCallback(async () => {
    lastLoadAtRef.current = Date.now();
    setFetchError(false);
    const first = firstLoadRef.current;
    firstLoadRef.current = false;
    // Each widget fills in as its own response lands — Home no longer waits
    // for the slowest of four requests before showing anything.
    if (householdId) {
      (first ? homeRequests.members(householdId) : householdApi.getMembers(householdId))
        .then((m) => {
          setMembers(m);
          writeCache("home:members", m);
        })
        .catch(() => {});
      (first ? homeRequests.household(householdId) : householdApi.getHousehold(householdId))
        .then((hh) => {
          const cover = hh?.coverPhotoUrl || null;
          setCoverPhotoUrl(cover);
          writeCache("home:cover", cover);
        })
        .catch(() => {});
    } else {
      setMembers([]);
      setCoverPhotoUrl(null);
    }
    // Calendar widget — all household events (filtered per selected day).
    (first ? homeRequests.events() : eventApi.list())
      .then((calendarEvents) => {
        setEvents(calendarEvents || []);
        writeCache("home:events", calendarEvents || []);
      })
      .catch(() => {});
    try {
      const d = await (first ? homeRequests.dashboard() : dashboardApi.get());
      setData(d);
      setUnreadCount(d?.notifications?.unreadCount || 0);
      writeCache("home:dashboard", d);
    } catch {
      setFetchError(true);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [householdId]);
  useEffect(() => {
    load();
  }, [load]);

  // A household member completed something (task/todo/grocery/check-in/
  // calendar/feed/ping) on another device — refetch so the streak ring and
  // leaderboard update without waiting for a focus or manual refresh.
  useEffect(() => {
    if (engagementEventAt > 0) load();
  }, [engagementEventAt, load]);

  // Today's Focus — top 3 pending tasks
  useEffect(() => {
    taskApi
      .list({
        group: "pending",
      })
      .then((res) => {
        const arr = Array.isArray(res) ? res : res?.pending || [];
        setPendingTasks(arr.slice(0, 3));
        writeCache("home:pendingTasks", arr.slice(0, 3));
      })
      .catch(() => {});
  }, []);

  // Balance — expense summary
  useEffect(() => {
    expenseApi
      .getSummary()
      .then((s) => {
        const mine = (s?.netBalances || []).find((b) => b.userId === user?.id);
        if (mine && Math.abs(mine.netBalance) > 0.01) {
          const amt = `$${Math.abs(mine.netBalance).toFixed(0)}`;
          if (mine.netBalance > 0) {
            setOweText(`You're owed ${amt}`);
          } else {
            setOweText(`You owe ${amt}`);
          }
          // counterparty from ledger
          const entry = (s?.ledger || []).find(
            (l) => l.toUserId === user?.id || l.fromUserId === user?.id,
          );
          if (entry)
            setOweName(
              mine.netBalance > 0 ? entry.fromUserName : entry.toUserName,
            );
        }
      })
      .catch(() => {});
  }, [user?.id]);

  // Vault — latest document. Names are end-to-end encrypted, so the dashboard
  // shows only that a file exists and when it was added, without unlocking the vault.
  useEffect(() => {
    vaultApi
      .list({ limit: 1 })
      .then((r) => {
        if (r.documents?.length) {
          setLatestDoc("Encrypted file");
          setLatestDocTime(timeHM(r.documents[0].createdAt));
        }
      })
      .catch(() => {});
  }, []);

  // Re-check on every focus so a photo just posted to the Feed shows up here.
  // The store hands back the same list when nothing changed, so an unchanged
  // refetch does not restart the rotation.
  useFocusEffect(
    useCallback(() => {
      refreshFeed();
    }, [refreshFeed]),
  );

  // Re-check unread count on every focus so the bell badge clears as soon as
  // the user comes back from reading notifications (cheap single-field call —
  // no need for a full dashboard reload just for this).
  // Skips the first focus: the dashboard load on mount already carries it.
  const unreadFocusSeenRef = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (!unreadFocusSeenRef.current) {
        unreadFocusSeenRef.current = true;
        return;
      }
      notificationApi
        .getUnreadCount()
        .then(setUnreadCount)
        .catch(() => {});
    }, []),
  );

  // Re-check the full dashboard (streak, activity, leaderboard, tasks/
  // groceries counts) on focus so completing something on another tab and
  // tabbing back to Home shows it immediately — not just on manual
  // pull-to-refresh. Throttled so rapid tab-switching doesn't refetch every
  // time; the initial mount's own `load()` already sets the timer so this
  // never double-fires on first render.
  useFocusEffect(
    useCallback(() => {
      if (Date.now() - lastLoadAtRef.current > 15000) {
        load();
      }
    }, [load]),
  );

  // Seed both layers whenever the photo set changes.
  useEffect(() => {
    feedIndexRef.current = 0;
    feedTopRef.current = 0;
    feedFade.setValue(0);
    setFeedSlots([feedPhotos[0]?.uri ?? null, feedPhotos[1]?.uri ?? null]);
  }, [feedPhotos, feedFade]);

  // Auto-rotate every 3s with a crossfade. A single photo just sits there.
  useEffect(() => {
    if (feedPhotos.length < 2) return undefined;
    const timer = setInterval(() => {
      const nextIndex = (feedIndexRef.current + 1) % feedPhotos.length;
      const nextTop = feedTopRef.current === 0 ? 1 : 0;
      Animated.timing(feedFade, {
        toValue: nextTop,
        duration: 600,
        easing: Easing.inOut(Easing.ease),
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (!finished) return;
        feedIndexRef.current = nextIndex;
        feedTopRef.current = nextTop;
        // Preload the photo after this one into the now-hidden layer, so it has
        // a full 3s to decode before it is faded in.
        const following = feedPhotos[(nextIndex + 1) % feedPhotos.length].uri;
        const hidden = nextTop === 0 ? 1 : 0;
        setFeedSlots((prev) => {
          if (prev[hidden] === following) return prev;
          const next = [...prev];
          next[hidden] = following;
          return next;
        });
      });
    }, 3000);
    return () => clearInterval(timer);
  }, [feedPhotos, feedFade]);
  useEffect(() => {
    if (Platform.OS !== "android") return;
    NavigationBar.setBackgroundColorAsync(colors.navyDeep);
    NavigationBar.setButtonStyleAsync("light");
  }, []);
  const activity = data?.activity || [];
  const recentActivity = data?.recentActivity || [];
  const completedToday = data?.tasks.completedToday || 0;

  /* ── Streak: 7 day pills ──
     `engaged` comes straight from the server's streak truth — a chore OR a
     chat message/ping/check-in/feed post/calendar event — so a pill can
     never show "done" while the copy below it says "no activity", and vice
     versa. */
  const streakDays = (() => {
    const days = activity.slice(-7);
    while (days.length < 7)
      days.unshift({
        date: "",
        tasksCompleted: 0,
        todosCompleted: 0,
        groceriesBought: 0,
        engaged: false,
      });
    return days.map((d, i) => {
      const total =
        (d.tasksCompleted || 0) +
        (d.todosCompleted || 0) +
        (d.groceriesBought || 0);
      const isToday = i === days.length - 1;
      return {
        done: !!d.engaged,
        isToday,
        total,
        label: d.date
          ? new Date(d.date).toLocaleDateString("en-US", {
              weekday: "narrow",
            })
          : "",
      };
    });
  })();
  const doneCount = streakDays.filter((d) => d.done).length;
  const selDay = streakDays[streakIdx] || streakDays[6];
  const streakDetail = selDay?.isToday
    ? completedToday > 0
      ? `${completedToday} task${completedToday > 1 ? "s" : ""} completed today. Keep it going.`
      : selDay.done
        ? "Streak kept alive today. Nice work."
        : "Nothing yet today. A task, a check-in, or catching up with the family keeps it going."
    : selDay?.total > 0
      ? `${selDay.total} activit${selDay.total === 1 ? "y" : "ies"} completed this day.`
      : selDay?.done
        ? "The family stayed connected this day."
        : "No activity recorded this day.";
  const streakDetailMeta = selDay?.isToday ? "TODAY" : selDay?.label || "";
  const bestStreak = data?.streak?.longest ?? data?.streak?.best ?? null;

  /* ── Harmony score ──
     One formula, no artificial floor: 0 completed activities this week
     means the score and the progress bar both genuinely read 0, not a
     hardcoded "everyone starts at 40" baseline. 5 points per completed
     task/todo/grocery-bought item, capped at 100 (reached at 20 items/week).
     The displayed number and the bar's fill % are now always the same
     value, instead of two different formulas over the same input. */
  const weekTotal = activity.reduce(
    (a, d) =>
      a +
      (d.tasksCompleted || 0) +
      (d.todosCompleted || 0) +
      (d.groceriesBought || 0),
    0,
  );
  const weeklyPct = Math.min(100, Math.round(weekTotal * 5));
  const harmonyScore = weeklyPct;
  const activitiesThisWeek = weekTotal;

  /* ── Leaderboard (server-computed, real) ── */
  const leaderboard = (data?.leaderboard || [])
    .map((e) => ({
      name: e.displayName,
      points: e.points,
    }))
    .slice(0, 3);
  const topMemberName = data?.leaderboard?.[0]?.displayName || "";

  const QUICK_ACTIONS = [
    {
      icon: "home-outline",
      label: "Home",
      template: "I've reached home safe! 🏠",
    },
    {
      icon: "car-outline",
      label: "On My Way",
      template: "I'm on my way now! 🚗",
    },
    {
      icon: "shield-checkmark-outline",
      label: "Safe",
      template: "Just checking in — I'm safe! ✅",
    },
    {
      icon: "cart-outline",
      label: "Groceries",
      template: "Heading out to grab groceries! 🛒",
    },
  ];
  const NUDGE_PRESETS = [
    { icon: "eye-outline", caption: "Reminder", message: "Just a reminder 👀" },
    {
      icon: "alarm-outline",
      caption: "Don't forget",
      message: "Don't forget!",
    },
    {
      icon: "checkmark-circle-outline",
      caption: "Check it",
      message: "Please check this",
    },
    {
      icon: "hand-left-outline",
      caption: "Your turn",
      message: "Can you take care of this?",
    },
    { icon: "flash-outline", caption: "Hurry", message: "Hurry up, please!" },
    {
      icon: "call-outline",
      caption: "Call me",
      message: "Can you call me back?",
    },
  ];
  const handleQuickNotify = (action) => {
    const q = QUICK_ACTIONS.find((x) => x.label === action);
    setPendingAction(q?.label || action);
    setCustomMsg(q?.template || "");
    setSelMembers(new Set());
    setShowPicker(true);
  };
  const canSend =
    selMembers.size > 0 && (customMsg.trim().length > 0 || !!pendingAction);
  const handleSendNotify = async () => {
    const ids = Array.from(selMembers);
    if (!ids.length) return;
    const msg = customMsg.trim();
    const action =
      pendingAction === "Nudge"
        ? "nudged you"
        : pendingAction || "sent you a message";
    setSending(true);
    setShowPicker(false);
    try {
      await dashboardApi.quickNotify(action, ids, msg || undefined);
    } catch (e) {
      showAlert(
        "Error",
        e?.response?.data?.message ||
          e?.message ||
          "Could not send notification",
      );
    } finally {
      setSending(false);
    }
  };
  const focusItems = pendingTasks.map((t) => ({
    title: t.title,
    meta: t.dueDate
      ? new Date(t.dueDate).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
        })
      : "Anytime",
  }));
  if (loading) {
    return (
      <View
        style={[
          styles.root,
          {
            paddingTop: insets.top,
          },
        ]}
      >
        <StatusBar barStyle="light-content" backgroundColor={colors.navyDeep} />
        <SvgXml
          xml={AMBIENT_SVG}
          width="100%"
          height="100%"
          style={styles.ambient}
        />
        <View style={{ paddingTop: 24, flex: 1 }}>
          <LoadingSkeleton variant="dashboard" dark />
        </View>
      </View>
    );
  }
  const weekStrip = Array.from({
    length: 7,
  }).map((_, i) => {
    const d = new Date(weekAnchor);
    d.setDate(weekAnchor.getDate() + i);
    const isToday = sameDay(d, new Date());
    const isSelected = sameDay(d, selectedDate);
    return {
      key: d.toDateString(),
      date: d,
      label: d.toLocaleDateString("en-US", {
        weekday: "narrow",
      }),
      num: d.getDate(),
      bg: isToday ? GOLD : "transparent",
      color: isToday ? colors.navyDeep : colors.textOnDarkBody,
      dot: events.some((e) => sameDay(new Date(e.startsAt), d))
        ? GOLD
        : "transparent",
      isSelected,
    };
  });
  const selectedDayEvents = events
    .filter((e) => sameDay(new Date(e.startsAt), selectedDate))
    .sort(
      (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
    );
  return (
    <SpotlightTourProvider
      ref={tourRef}
      steps={tourSteps}
      shape="rectangle"
      motion="slide"
      overlayColor={colors.shadow}
      overlayOpacity={0.82}
    >
      <View style={styles.root}>
        <StatusBar
          barStyle="light-content"
          backgroundColor="transparent"
          translucent
        />

        {/* ═══════ AMBIENT NAVY FIELD (behind everything) ═══════ */}
        <SvgXml
          xml={AMBIENT_SVG}
          width="100%"
          height="100%"
          style={styles.ambient}
        />

        <ScrollView
          ref={scrollRef}
          style={styles.scroll}
          showsVerticalScrollIndicator={false}
          onScroll={(e) => {
            scrollOffsetY.current = e.nativeEvent.contentOffset.y;
          }}
          scrollEventThrottle={16}
          contentContainerStyle={{
            paddingBottom: dockHeight + 16,
          }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true);
                load();
                refreshFeed();
              }}
              tintColor={GOLD}
            />
          }
        >
          {/* Clears the status bar / notch now that the hero photo is gone. */}
          <View
            style={{
              height: insets.top + 12,
            }}
          />

          {/* ═══════ HEADER ROW — avatar + bell.
              In normal flow (they used to be absolutely pinned over the hero
              photo). With the photo gone, pinning made them sit on top of the
              greeting, so they now occupy their own row instead. ═══════ */}
          <View style={styles.headerRow}>
            <TouchableOpacity
              onPress={() =>
                nav.navigate("MoreStack", { screen: "EditProfile" })
              }
              activeOpacity={0.8}
              hitSlop={{
                top: 8,
                bottom: 8,
                left: 8,
                right: 8,
              }}
            >
              <Avatar
                url={user?.avatarUrl}
                emoji={user?.avatarEmoji}
                name={user?.name}
                id={user?.id}
                size={46}
                style={styles.selfAvatarRing}
              />
            </TouchableOpacity>

            <AttachStep index={0} style={{ alignSelf: "center" }}>
              <TouchableOpacity
                ref={bellRef}
                style={styles.notifBtn}
                onPress={() => nav.navigate("Notifications")}
                activeOpacity={0.8}
                hitSlop={{
                  top: 8,
                  bottom: 8,
                  left: 8,
                  right: 8,
                }}
              >
                <SvgXml xml={BELL_SVG} width={22} height={22} />
                {unreadCount > 0 && (
                  <View style={styles.notifBadge}>
                    <Text style={styles.notifBadgeText}>
                      {unreadCount > 9 ? "9+" : unreadCount}
                    </Text>
                  </View>
                )}
              </TouchableOpacity>
            </AttachStep>
          </View>

          {/* ═══════ GREETING (sits directly on the field) ═══════ */}
          <View style={styles.greetBlock}>
            <View style={styles.greetDateRow}>
              <Text style={styles.greetDate}>{formatDate()}</Text>
              {weather && (
                <View style={styles.weatherPill}>
                  <Text style={styles.weatherPillText}>
                    {weather.emoji} {weather.tempC}°C
                  </Text>
                </View>
              )}
            </View>
            <View style={styles.greetRow}>
              <Text style={styles.greetTitle} numberOfLines={2}>
                {getGreeting()} {user?.name?.split(" ")[0] || "there"}
              </Text>

              {/* Member avatars — other household members only, not yourself */}
              <View style={styles.avatarStack}>
                {members
                  .filter((m) => m.userId !== user?.id)
                  .slice(0, 5)
                  .map((m, i) => (
                    <View
                      key={m.userId}
                      style={[
                        styles.avatarWrap,
                        i > 0 && {
                          marginLeft: -8,
                        },
                      ]}
                    >
                      <Avatar
                        url={m.avatarUrl}
                        emoji={m.avatarEmoji}
                        name={m.displayName || m.name || "??"}
                        id={m.userId}
                        size={32}
                        style={styles.avatarCircle}
                      />
                      <View style={styles.onlineDot} />
                    </View>
                  ))}
              </View>
            </View>
          </View>

          {/* ═══════ BODY ═══════ */}
          <View style={styles.body}>
            {fetchError && (
              <Card
                style={{
                  alignItems: "center",
                  gap: 10,
                  marginBottom: 20,
                }}
              >
                <Text
                  style={{
                    fontSize: 13,
                    color: colors.textOnDarkMuted,
                  }}
                >
                  Couldn't load your dashboard
                </Text>
                <TouchableOpacity
                  style={styles.retryBtn}
                  onPress={() => {
                    setLoading(true);
                    load();
                  }}
                >
                  <Text style={styles.retryText}>Tap to retry</Text>
                </TouchableOpacity>
              </Card>
            )}

            {!fetchError && data && (
              <>
                {/* ── Family Streak (hero) ── */}
                <AttachStep index={1} fill>
                  <BlurView
                    ref={streakRef}
                    intensity={22}
                    tint="dark"
                    style={styles.streakCard}
                  >
                    <CardSheen radius={26} tone="blue" />
                    <View style={styles.rowBetween}>
                      <WidgetLabel>FAMILY STREAK</WidgetLabel>
                      {bestStreak != null && (
                        <View style={styles.bestChip}>
                          <Text style={styles.bestChipText}>
                            BEST {bestStreak}
                          </Text>
                        </View>
                      )}
                    </View>

                    <View style={styles.streakBody}>
                      <StreakRing
                        value={data?.streak?.current ?? 0}
                        progress={doneCount / 7}
                      />
                      <View style={styles.streakCopy}>
                        <Text style={styles.streakHeadline}>
                          {doneCount >= 7
                            ? "Perfect week — everyone showed up."
                            : `${7 - doneCount} more day${7 - doneCount === 1 ? "" : "s"} to a full week`}
                        </Text>
                        <Text style={styles.streakSub}>
                          {doneCount} of the last 7 days had activity.
                        </Text>
                        <View style={styles.progressTrack}>
                          <LinearGradient
                            colors={[colors.goldGlowDeep, GOLD]}
                            start={{ x: 0, y: 0 }}
                            end={{ x: 1, y: 0 }}
                            style={[
                              styles.progressFill,
                              {
                                width: `${Math.round((doneCount / 7) * 100)}%`,
                              },
                            ]}
                          />
                        </View>
                      </View>
                    </View>

                    {/* 7 day pills */}
                    <View style={styles.pillRow}>
                      {streakDays.map((d, i) => {
                        const sel = i === streakIdx;
                        return (
                          <TouchableOpacity
                            key={i}
                            style={styles.pillCol}
                            onPress={() => setStreakIdx(i)}
                            activeOpacity={0.7}
                          >
                            <View
                              style={[
                                styles.pill,
                                d.done && styles.pillDone,
                                sel && styles.pillSelected,
                              ]}
                            >
                              <Text
                                style={[
                                  styles.pillGlyph,
                                  d.done && styles.pillGlyphDone,
                                ]}
                              >
                                {d.done ? "✓" : "·"}
                              </Text>
                            </View>
                            <Text
                              style={[
                                styles.pillLabel,
                                sel && styles.pillLabelSel,
                              ]}
                            >
                              {d.label || "·"}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>

                    <View style={styles.streakFooter}>
                      <Text style={styles.streakDetail}>{streakDetail}</Text>
                      {!!streakDetailMeta && (
                        <Text style={styles.streakDetailMeta}>
                          {streakDetailMeta}
                        </Text>
                      )}
                    </View>

                    <ContributorsStrip activity={recentActivity} />
                  </BlurView>
                </AttachStep>

                {/* ── Family Harmony Score ── */}
                <TouchableOpacity
                  style={[
                    styles.card,
                    {
                      borderRadius: 22,
                    },
                  ]}
                  onPress={() => nav.navigate("TasksStack")}
                  activeOpacity={0.7}
                >
                  <CardSheen radius={22} />
                  <View style={styles.rowBetween}>
                    <WidgetLabel>FAMILY HARMONY SCORE</WidgetLabel>
                    <Text style={styles.greenDelta}>
                      ▲ +{activitiesThisWeek} this week
                    </Text>
                  </View>
                  <View style={styles.scoreRow}>
                    <Text style={styles.scoreNum}>{harmonyScore}</Text>
                    <Text style={styles.scoreMeta}>
                      weekly progress {weeklyPct}%
                    </Text>
                  </View>
                  <View style={styles.progressTrack}>
                    <LinearGradient
                      colors={[colors.goldGlowDeep, GOLD]}
                      start={{ x: 0, y: 0 }}
                      end={{ x: 1, y: 0 }}
                      style={[
                        styles.progressFill,
                        {
                          width: `${weeklyPct}%`,
                        },
                      ]}
                    />
                  </View>
                  <Text style={styles.scoreCaption}>
                    {activitiesThisWeek} family activities completed this week
                  </Text>
                  {leaderboard.map((p, i) => (
                    <View key={i} style={styles.lbRow}>
                      <Text
                        style={[styles.lbRank, i === 0 && styles.lbRankTop]}
                      >
                        {String(i + 1).padStart(2, "0")}
                      </Text>
                      <Text style={styles.lbName} numberOfLines={1}>
                        {p.name}
                      </Text>
                      <Text style={styles.lbPts}>{p.points} pts</Text>
                    </View>
                  ))}
                </TouchableOpacity>

                {/* ── Today's Focus ── */}
                {/*<Card style={{ marginBottom: 20 }}>
                <WidgetLabel
                  style={{
                    marginBottom: 14,
                  }}
                >
                  TODAY'S FOCUS
                </WidgetLabel>
                {focusItems.length === 0 ? (
                  <Text style={styles.emptyText}>No tasks for today — enjoy the calm 🎉</Text>
                ) : (
                  focusItems.map((f, i) => (
                    <TouchableOpacity
                      key={i}
                      style={[styles.focusRow, i < focusItems.length - 1 && styles.focusRowBorder]}
                      onPress={() => nav.navigate('TasksStack')}
                      activeOpacity={0.7}
                    >
                      <Text style={styles.focusTitle} numberOfLines={1}>
                        {f.title}
                      </Text>
                      <Text style={styles.focusMeta}>{f.meta}</Text>
                    </TouchableOpacity>
                  ))
                )}
              </Card>*/}

                {/* ── Calendar ── */}
                <AttachStep index={2} fill>
                  <TouchableOpacity
                    ref={calendarRef}
                    style={[
                      styles.card,
                      {
                        borderRadius: 22,
                        padding: 20,
                      },
                    ]}
                    onPress={() =>
                      nav.navigate("MoreStack", {
                        screen: "Calendar",
                      })
                    }
                    activeOpacity={0.7}
                  >
                    <CardSheen radius={22} />
                    <View style={styles.rowBetween}>
                      <WidgetLabel>CALENDAR</WidgetLabel>
                      <View style={styles.calControls}>
                        <TouchableOpacity
                          onPress={() =>
                            setWeekAnchor((p) => {
                              const n = new Date(p);
                              n.setDate(n.getDate() - 7);
                              return n;
                            })
                          }
                          hitSlop={{
                            top: 6,
                            bottom: 6,
                            left: 6,
                            right: 6,
                          }}
                        >
                          <Text style={styles.calArrow}>‹</Text>
                        </TouchableOpacity>
                        <Text style={styles.calMonth}>
                          {weekAnchor.toLocaleDateString("en-US", {
                            month: "long",
                            year: "numeric",
                          })}
                        </Text>
                        <TouchableOpacity
                          onPress={() =>
                            setWeekAnchor((p) => {
                              const n = new Date(p);
                              n.setDate(n.getDate() + 7);
                              return n;
                            })
                          }
                          hitSlop={{
                            top: 6,
                            bottom: 6,
                            left: 6,
                            right: 6,
                          }}
                        >
                          <Text style={styles.calArrow}>›</Text>
                        </TouchableOpacity>
                      </View>
                    </View>
                    <View style={styles.weekStrip}>
                      {weekStrip.map((w) => (
                        <TouchableOpacity
                          key={w.key}
                          style={styles.weekCol}
                          onPress={() => setSelectedDate(w.date)}
                          activeOpacity={0.6}
                        >
                          <Text style={styles.weekLabel}>{w.label}</Text>
                          <View
                            style={[
                              styles.weekDay,
                              {
                                backgroundColor: w.bg,
                              },
                              w.isSelected && styles.weekDaySelected,
                            ]}
                          >
                            <Text
                              style={[
                                styles.weekNum,
                                {
                                  color: w.color,
                                },
                              ]}
                            >
                              {w.num}
                            </Text>
                          </View>
                          <View
                            style={[
                              styles.weekDot,
                              {
                                backgroundColor: w.dot,
                              },
                            ]}
                          />
                        </TouchableOpacity>
                      ))}
                    </View>
                    <View style={styles.calDivider} />
                    {events.length === 0 ? (
                      <Text style={styles.calMeta}>
                        No events yet — add one in the Calendar
                      </Text>
                    ) : selectedDayEvents.length === 0 ? (
                      <Text style={styles.calMeta}>
                        No events this day — tap a date to switch
                      </Text>
                    ) : (
                      selectedDayEvents.slice(0, 3).map((e) => (
                        <View key={e.id} style={styles.calEventRow}>
                          <View style={styles.calEventDot} />
                          <Text style={styles.calEvent} numberOfLines={1}>
                            {e.title}
                          </Text>
                          <Text style={styles.calEventTime}>
                            {timeHM(e.startsAt)}
                          </Text>
                        </View>
                      ))
                    )}
                  </TouchableOpacity>
                </AttachStep>

                {/* ── Tasks + Balance two-up ── */}
                <View style={styles.twoUp}>
                  <View style={styles.col}>
                    <AttachStep index={3} fill style={{ flex: 1 }}>
                      <TouchableOpacity
                        ref={tasksRef}
                        style={styles.halfCard}
                        onPress={() => nav.navigate("TasksStack")}
                        activeOpacity={0.7}
                      >
                        <CardSheen radius={20} />
                        <WidgetLabel
                          style={{
                            marginBottom: 12,
                          }}
                        >
                          TASKS
                        </WidgetLabel>
                        <Text style={styles.halfNum}>{data.tasks.pending}</Text>
                        <Text style={styles.halfMeta}>
                          {data.tasks.pending === 0 ? "all clear" : "due today"}
                          {data.tasks.overdue > 0
                            ? ` · ${data.tasks.overdue} overdue`
                            : ""}
                        </Text>
                      </TouchableOpacity>
                    </AttachStep>
                  </View>
                  <View style={styles.col}>
                    <TouchableOpacity
                      style={styles.halfCard}
                      onPress={() =>
                        nav.navigate("MoreStack", {
                          screen: "ExpenseList",
                        })
                      }
                      activeOpacity={0.7}
                    >
                      <CardSheen radius={20} />
                      <WidgetLabel
                        style={{
                          marginBottom: 12,
                        }}
                      >
                        BALANCE
                      </WidgetLabel>
                      <Text
                        style={[styles.halfNum, styles.balanceNum]}
                        numberOfLines={1}
                      >
                        {oweText || "Settled up"}
                      </Text>
                      <Text style={styles.halfMeta} numberOfLines={1}>
                        {oweName || (oweText ? "" : "nothing owed")}
                      </Text>
                    </TouchableOpacity>
                  </View>
                </View>

                {/* ── Grocery + To-do two-up ── */}
                <View style={styles.twoUp}>
                  <View style={styles.col}>
                    <TouchableOpacity
                      style={styles.halfCard}
                      onPress={() =>
                        nav.navigate("MoreStack", {
                          screen: "GroceryList",
                        })
                      }
                      activeOpacity={0.7}
                    >
                      <CardSheen radius={20} />
                      <WidgetLabel
                        style={{
                          marginBottom: 12,
                        }}
                      >
                        GROCERY
                      </WidgetLabel>
                      <Text style={styles.halfNum} numberOfLines={1} adjustsFontSizeToFit>
                        {data.groceries.pending} left
                      </Text>
                      <Text style={styles.halfMeta} numberOfLines={1}>
                        {data.groceries.pending > 0
                          ? `${data.groceries.pending} item${data.groceries.pending > 1 ? "s" : ""} on the list`
                          : "list is clear"}
                      </Text>
                    </TouchableOpacity>
                  </View>
                  <View style={styles.col}>
                    <TouchableOpacity
                      style={styles.halfCard}
                      onPress={() =>
                        nav.navigate("MoreStack", {
                          screen: "TodoList",
                        })
                      }
                      activeOpacity={0.7}
                    >
                      <CardSheen radius={20} />
                      <WidgetLabel
                        style={{
                          marginBottom: 12,
                        }}
                      >
                        TO-DO
                      </WidgetLabel>
                      <Text style={styles.halfNum} numberOfLines={1} adjustsFontSizeToFit>
                        {data.todos.pending} to do
                      </Text>
                      <Text style={styles.halfMeta} numberOfLines={1}>
                        {data.todos.completedToday > 0
                          ? `${data.todos.completedToday} done today`
                          : data.todos.pending === 0
                            ? "all clear"
                            : "none done today"}
                      </Text>
                    </TouchableOpacity>
                  </View>
                </View>

                {/* ── Feed + Nudge two-up ── */}
                <View style={styles.twoUp}>
                  <View style={styles.col}>
                    <TouchableOpacity
                      style={styles.feedCard}
                      onPress={() => nav.navigate("PhotoGallery")}
                      activeOpacity={0.85}
                    >
                      {feedPhotos.length > 0 ? (
                        <>
                          {feedSlots[0] ? (
                            <Animated.Image
                              source={{ uri: feedSlots[0] }}
                              style={[
                                styles.feedImage,
                                { opacity: feedFadeInverse },
                              ]}
                              resizeMode="cover"
                            />
                          ) : null}
                          {feedSlots[1] ? (
                            <Animated.Image
                              source={{ uri: feedSlots[1] }}
                              style={[styles.feedImage, { opacity: feedFade }]}
                              resizeMode="cover"
                            />
                          ) : null}
                        </>
                      ) : (
                        <View style={[styles.feedImage, styles.feedPlaceholder]}>
                          <Text
                            style={{
                              fontSize: 26,
                              opacity: 0.5,
                            }}
                          >
                            📸
                          </Text>
                          <Text style={styles.feedCaption} numberOfLines={1}>
                            Share a moment
                          </Text>
                        </View>
                      )}
                      {feedPhotos.length > 0 ? (
                        <LinearGradient
                          colors={[
                            withAlpha(colors.navyDark, 0),
                            withAlpha(colors.navyDark, 0.45),
                          ]}
                          style={styles.feedGradient}
                          pointerEvents="none"
                        />
                      ) : null}
                    </TouchableOpacity>
                  </View>
                  <View style={styles.col}>
                    <TouchableOpacity
                      style={[
                        styles.card,
                        styles.nudgeCard,
                        {
                          borderRadius: 20,
                        },
                      ]}
                      onPress={() => handleQuickNotify("Nudge")}
                      activeOpacity={0.7}
                    >
                      <CardSheen radius={20} />
                      <WidgetLabel>NUDGE</WidgetLabel>
                      <View
                        style={{
                          marginTop: 10,
                        }}
                      >
                        <Text style={styles.nudgeCardTitle} numberOfLines={1}>
                          Send a quick reminder
                        </Text>
                        <Text style={styles.nudgeCardMeta} numberOfLines={1}>
                          Tap to nudge someone
                        </Text>
                      </View>
                    </TouchableOpacity>
                  </View>
                </View>

                {/* ── Quick Actions ── */}
                <AttachStep index={4} fill>
                  <View ref={quickActionsRef} collapsable={false}>
                    <Card
                      radius={20}
                      style={{
                        paddingVertical: 18,
                        paddingHorizontal: 16,
                        marginBottom: 20,
                      }}
                    >
                      <WidgetLabel
                        style={{
                          marginBottom: 14,
                          marginHorizontal: 2,
                        }}
                      >
                        QUICK ACTIONS
                      </WidgetLabel>
                      <View style={styles.qaRow}>
                        {QUICK_ACTIONS.map((q, i) => (
                          <TouchableOpacity
                            key={i}
                            style={styles.qaItem}
                            onPress={() => handleQuickNotify(q.label)}
                            activeOpacity={0.7}
                          >
                            <View style={styles.qaGlyph}>
                              <Ionicons name={q.icon} size={20} color={GOLD} />
                            </View>
                            <Text style={styles.qaLabel} numberOfLines={1}>
                              {q.label}
                            </Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                    </Card>
                  </View>
                </AttachStep>

                {/* ── Family Activity ── */}
                {/* <TouchableOpacity
                style={[
                  styles.card,
                  {
                    borderRadius: 20,
                    padding: 20,
                  },
                ]}
                onPress={() => nav.navigate('TasksStack')}
                activeOpacity={0.7}
              >
                <CardSheen radius={20} />
                <WidgetLabel
                  style={{
                    marginBottom: 14,
                  }}
                >
                  FAMILY ACTIVITY
                </WidgetLabel>
                {recentActivity.length === 0 ? (
                  <Text style={styles.emptyText}>
                    No activity yet — complete tasks to see it here
                  </Text>
                ) : (
                  recentActivity.slice(0, 4).map((a, i) => {
                    const verb =
                      a.kind === 'grocery'
                        ? 'bought groceries'
                        : a.kind === 'todo'
                          ? 'finished a todo'
                          : a.kind === 'ping'
                            ? 'pinged the household'
                            : a.kind === 'checkin'
                              ? 'checked in'
                              : a.kind === 'calendar'
                                ? 'added an event'
                                : a.kind === 'feed'
                                  ? 'shared a post'
                                  : 'completed a task';
                    const date = new Date(a.date);
                    return (
                      <View key={i} style={styles.actRow}>
                        {a.avatarUrl ? (
                          <Image
                            source={{
                              uri: a.avatarUrl,
                            }}
                            style={styles.actAvatar}
                          />
                        ) : (
                          <View style={styles.actAvatar}>
                            <Text style={styles.actAvatarText}>
                              {a.avatarEmoji || initials(a.displayName)}
                            </Text>
                          </View>
                        )}
                        <Text style={styles.actText} numberOfLines={1}>
                          {a.displayName} {verb}
                        </Text>
                        <Text style={styles.actTime}>
                          {date.toLocaleDateString('en-US', {
                            weekday: 'short',
                          })}
                        </Text>
                      </View>
                    );
                  })
                )}
              </TouchableOpacity> */}

                {/* ── Vault · LOCKED ── */}
                <AttachStep index={5} fill>
                  <TouchableOpacity
                    ref={vaultRef}
                    style={styles.vaultCard}
                    onPress={() =>
                      nav.navigate("MoreStack", {
                        screen: "Vault",
                      })
                    }
                    activeOpacity={0.85}
                  >
                    <CardSheen radius={20} tone="gold" />
                    <View
                      style={{
                        flex: 1,
                      }}
                    >
                      <Text style={styles.vaultLabel}>VAULT · LOCKED</Text>
                      <Text style={styles.vaultTitle} numberOfLines={1}>
                        {latestDoc || "No documents yet"}
                      </Text>
                    </View>
                    <Text style={styles.vaultTime}>{latestDocTime || ""}</Text>
                  </TouchableOpacity>
                </AttachStep>

                {/* ── This Week ── */}
                <Card radius={20} style={{ padding: 20, marginBottom: 20 }}>
                  <WidgetLabel
                    style={{
                      marginBottom: 10,
                    }}
                  >
                    THIS WEEK
                  </WidgetLabel>
                  <Text style={styles.insightsText}>
                    Family completed {activitiesThisWeek} activit
                    {activitiesThisWeek === 1 ? "y" : "ies"} this week
                    {topMemberName
                      ? `. ${topMemberName.split(" ")[0]} was the most active.`
                      : ""}
                  </Text>
                </Card>
              </>
            )}
          </View>
        </ScrollView>

        {/* ── Quick notify modal ── */}
        <Modal
          visible={showPicker}
          animationType="slide"
          transparent
          statusBarTranslucent
          onRequestClose={() => setShowPicker(false)}
          navigationBarTranslucent
        >
          {/* The overlay itself is the avoider — no extra nesting, and the
            bottom sheet rises with the keyboard instead of sitting under it. */}
          <KeyboardAvoider style={mo.overlay}>
            <View
              style={[
                mo.sheet,
                {
                  paddingBottom: insets.bottom + spacing.lg,
                },
              ]}
            >
              <View style={mo.handle} />
              <Text style={mo.title}>
                {pendingAction === "Nudge" ? "Send a Nudge" : "Quick Notify"}
              </Text>

              <ScrollView
                style={mo.body}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
              >
                {/* Quick messages — Nudge flow only */}
                {pendingAction === "Nudge" && (
                  <>
                    <Text style={mo.nudgeSectionLabel}>QUICK MESSAGES</Text>
                    <View style={mo.presetGrid}>
                      {NUDGE_PRESETS.map((preset) => {
                        const active = customMsg === preset.message;
                        return (
                          <TouchableOpacity
                            key={preset.message}
                            style={mo.presetItem}
                            onPress={() => setCustomMsg(preset.message)}
                            activeOpacity={0.7}
                          >
                            <View
                              style={[
                                mo.presetGlyph,
                                active && mo.presetGlyphActive,
                              ]}
                            >
                              <Ionicons
                                name={preset.icon}
                                size={22}
                                color={active ? colors.navyDeep : GOLD}
                              />
                            </View>
                            <Text
                              style={[
                                mo.presetLabel,
                                active && mo.presetLabelActive,
                              ]}
                              numberOfLines={1}
                            >
                              {preset.caption}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  </>
                )}

                {/* Custom message */}
                <TextInput
                  style={mo.input}
                  value={customMsg}
                  onChangeText={setCustomMsg}
                  placeholder="Type a custom message…"
                  placeholderTextColor={colors.textOnDarkDim}
                  multiline
                  maxLength={500}
                />

                {/* Recipients */}
                <TouchableOpacity
                  style={mo.allRow}
                  onPress={() => {
                    const o = members.filter((m) => m.userId !== user?.id);
                    selMembers.size === o.length
                      ? setSelMembers(new Set())
                      : setSelMembers(new Set(o.map((m) => m.userId)));
                  }}
                  activeOpacity={0.7}
                >
                  <Text style={mo.allText}>Notify All</Text>
                  {(() => {
                    const allSelected =
                      selMembers.size > 0 &&
                      selMembers.size ===
                        members.filter((m) => m.userId !== user?.id).length;
                    return (
                      <View style={[mo.cb, allSelected && mo.cbOn]}>
                        {allSelected && (
                          <CheckIcon size={10} color={colors.navyDeep} />
                        )}
                      </View>
                    );
                  })()}
                </TouchableOpacity>
                {members
                  .filter((m) => m.userId !== user?.id)
                  .map((m) => {
                    const checked = selMembers.has(m.userId);
                    return (
                      <TouchableOpacity
                        key={m.userId}
                        style={[mo.mRow, checked && mo.mRowSel]}
                        onPress={() => {
                          const n = new Set(selMembers);
                          checked ? n.delete(m.userId) : n.add(m.userId);
                          setSelMembers(n);
                        }}
                        activeOpacity={0.7}
                      >
                        <View
                          style={{
                            flexDirection: "row",
                            alignItems: "center",
                            gap: 12,
                          }}
                        >
                          <Avatar
                            url={m.avatarUrl}
                            emoji={m.avatarEmoji}
                            name={m.displayName || m.name || m.email || "??"}
                            id={m.userId}
                            size={36}
                          />
                          <Text style={mo.mName}>
                            {m.displayName || m.name || m.email}
                          </Text>
                        </View>
                        <View style={[mo.cb, checked && mo.cbOn]}>
                          {checked && (
                            <CheckIcon size={10} color={colors.navyDeep} />
                          )}
                        </View>
                      </TouchableOpacity>
                    );
                  })}
              </ScrollView>

              <View style={mo.actions}>
                <TouchableOpacity
                  style={mo.cancelBtn}
                  onPress={() => setShowPicker(false)}
                  activeOpacity={0.7}
                >
                  <Text style={mo.cancelText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[mo.sendBtn, !canSend && mo.sendBtnDisabled]}
                  onPress={handleSendNotify}
                  disabled={!canSend || sending}
                  activeOpacity={0.7}
                >
                  <GoldFill radius={radius.md} disabled={!canSend || sending} />
                  {sending ? (
                    <ActivityIndicator size="small" color={colors.navyDeep} />
                  ) : (
                    <Text style={mo.sendText}>Notify ({selMembers.size})</Text>
                  )}
                </TouchableOpacity>
              </View>
            </View>
          </KeyboardAvoider>
        </Modal>

        {showConfetti && (
          <ConfettiCannon
            count={150}
            origin={{ x: Dimensions.get("window").width / 2, y: -20 }}
            fallSpeed={5500}
            fadeOut
            explosionSpeed={450}
            colors={[GOLD, colors.goldWarm, colors.white, colors.navyBase]}
            onAnimationEnd={() => setShowConfetti(false)}
          />
        )}

        <DailyWelcomeOverlay
          visible={dailyWelcome.visible}
          name={user?.name}
          quoteIndex={dailyWelcome.quoteIndex}
          onDismiss={handleDailyWelcomeDismiss}
        />
      </View>
    </SpotlightTourProvider>
  );
}
function CheckIcon({ size = 10, color = colors.navyDeep }) {
  return (
    <View
      style={{
        width: size,
        height: size,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <View
        style={{
          width: size * 0.6,
          height: size * 0.35,
          borderLeftWidth: 2,
          borderBottomWidth: 2,
          borderColor: color,
          transform: [
            {
              rotate: "-45deg",
            },
          ],
          marginTop: -2,
        }}
      />
    </View>
  );
}

/* ═══════════════════ Styles ═══════════════════ */
/* Glass recipe: translucent white fill + hairline white border + deep drop
   shadow. Repeated on every card so they read as one material. */
const GLASS_FILL = withAlpha(colors.white, 0.045);
const GLASS_FILL_LIFT = withAlpha(colors.white, 0.055);
const GLASS_BORDER = withAlpha(colors.white, 0.09);
const GLASS_BORDER_LIFT = withAlpha(colors.white, 0.1);
const GLASS_HAIRLINE = withAlpha(colors.white, 0.06);

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.navyDeep,
  },
  ambient: {
    ...StyleSheet.absoluteFillObject,
  },
  scroll: {
    flex: 1,
  },
  /* Header row holding the avatar + bell, above the greeting. */
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 24,
    paddingBottom: 14,
  },
  notifBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: withAlpha(colors.white, 0.1),
    borderWidth: 1,
    borderColor: GLASS_BORDER,
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
  },
  notifBadge: {
    position: "absolute",
    top: -2,
    right: -2,
    minWidth: 17,
    height: 17,
    borderRadius: 8.5,
    paddingHorizontal: 4,
    backgroundColor: colors.dangerOnDark,
    borderWidth: 1.5,
    borderColor: colors.navyBase,
    alignItems: "center",
    justifyContent: "center",
  },
  notifBadgeText: {
    fontSize: 10,
    fontWeight: "700",
    fontFamily: fonts.bodySemiBold,
    color: colors.white,
    lineHeight: 12,
  },
  selfAvatarRing: {
    borderWidth: 2,
    borderColor: withAlpha(colors.white, 0.85),
  },
  loadingWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  loadingText: {
    fontFamily: fonts.body,
    fontSize: 13,
    color: colors.textOnDarkMuted,
  },
  /* Glass cards. No shadow/elevation on purpose: the fill is see-through,
     and Android draws an elevation shadow through it as a faint inner box
     (the streak card never had one, which is why only it looked clean). */
  card: {
    backgroundColor: GLASS_FILL,
    borderWidth: 1,
    borderColor: GLASS_BORDER,
    padding: 22,
    marginBottom: 20,
  },
  widgetLabel: {
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 0.5,
    fontFamily: fonts.bodySemiBold,
  },
  /* Greeting */
  greetBlock: {
    paddingHorizontal: 24,
    paddingBottom: 20,
  },
  greetDateRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 6,
  },
  greetDate: {
    fontFamily: fonts.body,
    fontSize: 15,
    letterSpacing: 0.3,
    color: colors.textOnDarkFaint,
  },
  weatherPill: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: radius.pill,
    backgroundColor: withAlpha(colors.textOnDark, 0.12),
  },
  weatherPillText: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 13,
    color: colors.textOnDark,
  },
  greetRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  greetTitle: {
    flex: 1,
    // Caveat — a deliberate, Dashboard-greeting-only exception to the
    // Nunito Sans system (loaded separately in useAppFonts.js, not part of
    // the `fonts.*` token map on purpose — this is the one place it's used
    // anywhere in the app). Size bumped and tracking loosened from the
    // previous Nunito value: a handwritten script reads visually smaller
    // than a geometric sans at the same pixel size, and negative
    // letterSpacing tightens/breaks a connected cursive face's letterforms.
    fontSize: 30,
    lineHeight: 36,
    fontWeight: "500",
    color: colors.textOnDark,
    letterSpacing: 0,
    fontFamily: "Caveat_500Medium",
  },
  avatarStack: {
    flexDirection: "row",
  },
  avatarWrap: {
    position: "relative",
  },
  avatarCircle: {
    width: 32,
    height: 32,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: withAlpha(colors.navyDeep, 0.9),
  },
  avatarInitials: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 11,
    fontWeight: "600",
    color: colors.textOnDarkBody,
  },
  avatarEmoji: {
    fontSize: 15,
  },
  onlineDot: {
    position: "absolute",
    bottom: -1,
    right: -1,
    width: 9,
    height: 9,
    borderRadius: 4.5,
    backgroundColor: colors.successOnDark,
    borderWidth: 2,
    borderColor: colors.navyDeep,
  },
  /* Body */
  body: {
    paddingHorizontal: 20,
    paddingBottom: 0,
  },
  retryBtn: {
    backgroundColor: GOLD,
    borderRadius: 12,
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  retryText: {
    fontFamily: fonts.bodyBold,
    fontSize: 13,
    fontWeight: "700",
    color: colors.navyDeep,
  },
  rowBetween: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 4,
  },
  /* ── Streak hero ── */
  streakCard: {
    borderRadius: 26,
    overflow: "hidden",
    padding: 20,
    marginBottom: 20,
    backgroundColor: GLASS_FILL_LIFT,
    borderWidth: 1,
    borderColor: GLASS_BORDER_LIFT,
  },
  bestChip: {
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: withAlpha(colors.goldGlow, 0.12),
    borderWidth: 1,
    borderColor: withAlpha(colors.goldGlow, 0.25),
  },
  bestChipText: {
    fontSize: 10,
    fontWeight: "500",
    color: GOLD,
    fontFamily: fonts.mono,
  },
  streakBody: {
    flexDirection: "row",
    alignItems: "center",
    gap: 18,
    marginTop: 12,
    marginBottom: 18,
  },
  ringWrap: {
    width: 92,
    height: 92,
    alignItems: "center",
    justifyContent: "center",
  },
  ringInner: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
  ringNum: {
    fontSize: 30,
    fontWeight: "800",
    color: colors.textOnDark,
    letterSpacing: -0.6,
    fontFamily: fonts.display,
  },
  ringUnit: {
    fontFamily: fonts.bodyMedium,
    fontSize: 9,
    letterSpacing: 1,
    fontWeight: "500",
    color: colors.textOnDarkMuted,
    marginTop: 2,
  },
  streakCopy: {
    flex: 1,
  },
  streakHeadline: {
    fontSize: 15,
    lineHeight: 20,
    fontWeight: "600",
    color: colors.textOnDark,
    marginBottom: 6,
    fontFamily: fonts.bodySemiBold,
  },
  streakSub: {
    fontFamily: fonts.body,
    fontSize: 12,
    lineHeight: 18,
    color: colors.textOnDarkMuted,
    marginBottom: 12,
  },
  pillRow: {
    flexDirection: "row",
    gap: 6,
    marginBottom: 14,
  },
  pillCol: {
    flex: 1,
    alignItems: "center",
    gap: 7,
  },
  pill: {
    width: "100%",
    height: 44,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: withAlpha(colors.white, 0.06),
    borderWidth: 1,
    borderColor: GLASS_BORDER_LIFT,
  },
  pillDone: {
    backgroundColor: withAlpha(colors.goldGlow, 0.2),
    borderColor: withAlpha(colors.goldGlow, 0.32),
  },
  pillSelected: {
    borderColor: withAlpha(colors.goldGlow, 0.75),
  },
  pillGlyph: {
    fontSize: 13,
    fontWeight: "700",
    color: colors.textOnDarkFaint,
    fontFamily: "PlusJakartaSans_700Bold",
  },
  pillGlyphDone: {
    color: colors.goldGlowPale,
  },
  pillLabel: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 10,
    fontWeight: "600",
    color: colors.textOnDarkFaint,
  },
  pillLabelSel: {
    color: GOLD,
  },
  streakFooter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    borderTopWidth: 1,
    borderTopColor: withAlpha(colors.white, 0.08),
    paddingTop: 12,
  },
  streakDetail: {
    fontFamily: fonts.body,
    flex: 1,
    fontSize: 12,
    lineHeight: 17,
    color: colors.textOnDarkLabel,
  },
  streakDetailMeta: {
    fontSize: 11,
    fontWeight: "500",
    color: GOLD,
    fontFamily: fonts.mono,
  },
  /* ── Harmony ── */
  greenDelta: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 11,
    fontWeight: "600",
    color: colors.successOnDark,
  },
  scoreRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 10,
    marginBottom: 8,
  },
  scoreNum: {
    fontSize: 40,
    fontWeight: "800",
    color: colors.textOnDark,
    letterSpacing: -0.8,
    fontFamily: fonts.display,
  },
  scoreMeta: {
    fontFamily: fonts.body,
    fontSize: 13,
    color: colors.textOnDarkMuted,
  },
  progressTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: withAlpha(colors.white, 0.1),
    marginBottom: 8,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    borderRadius: 3,
  },
  scoreCaption: {
    fontFamily: fonts.body,
    fontSize: 12,
    lineHeight: 17,
    color: colors.textOnDarkMuted,
    marginBottom: 14,
  },
  lbRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: GLASS_HAIRLINE,
  },
  lbRank: {
    width: 20,
    fontSize: 11,
    fontWeight: "600",
    color: colors.textOnDarkLabel,
    fontFamily: fonts.mono,
  },
  lbRankTop: {
    color: GOLD,
  },
  lbName: {
    fontFamily: fonts.bodyMedium,
    flex: 1,
    fontSize: 14,
    fontWeight: "500",
    color: colors.textOnDarkBody,
  },
  lbPts: {
    fontSize: 13,
    fontWeight: "500",
    color: colors.textOnDarkMuted,
    fontFamily: fonts.mono,
  },
  emptyText: {
    fontFamily: fonts.body,
    fontSize: 13,
    color: colors.textOnDarkMuted,
    paddingVertical: 6,
  },
  /* ── Focus ── */
  focusRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 11,
  },
  focusRowBorder: {
    borderBottomWidth: 1,
    borderBottomColor: GLASS_HAIRLINE,
  },
  focusTitle: {
    flex: 1,
    fontSize: 15,
    fontWeight: "500",
    color: colors.textOnDarkSoft,
    fontFamily: fonts.bodySemiBold,
    marginRight: 10,
  },
  focusMeta: {
    fontFamily: fonts.body,
    fontSize: 13,
    color: colors.textOnDarkMuted,
  },
  /* ── Calendar ── */
  calMonth: {
    fontFamily: fonts.bodyMedium,
    fontSize: 12,
    fontWeight: "500",
    color: colors.textOnDarkMuted,
  },
  weekStrip: {
    flexDirection: "row",
    marginBottom: 14,
    marginTop: 16,
  },
  weekCol: {
    flex: 1,
    alignItems: "center",
    gap: 5,
  },
  weekLabel: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 10,
    fontWeight: "600",
    color: colors.textOnDarkDim,
  },
  weekDay: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  weekNum: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 12,
    fontWeight: "600",
  },
  weekDot: {
    width: 4,
    height: 4,
    borderRadius: 2,
  },
  calDivider: {
    height: 1,
    backgroundColor: withAlpha(colors.white, 0.08),
    marginBottom: 12,
  },
  calEvent: {
    fontSize: 15,
    fontWeight: "700",
    color: colors.textOnDarkSoft,
    fontFamily: fonts.bodyBold,
  },
  calMeta: {
    fontFamily: fonts.body,
    fontSize: 12,
    color: colors.textOnDarkMuted,
  },
  calControls: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  calArrow: {
    fontSize: 20,
    fontWeight: "600",
    color: colors.textOnDarkBody,
    lineHeight: 22,
  },
  weekDaySelected: {
    borderWidth: 1.5,
    borderColor: GOLD,
  },
  calEventRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 4,
  },
  calEventDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: GOLD,
  },
  calEventTime: {
    fontFamily: fonts.body,
    fontSize: 12,
    color: colors.textOnDarkDim,
    marginLeft: "auto",
  },
  /* ── Two-up ── */
  twoUp: {
    flexDirection: "row",
    gap: 14,
    marginBottom: 20,
  },
  // Equal columns for every two-up row, so all rows split at the same x
  // no matter how wide a tile's text is.
  col: {
    flex: 1,
    flexBasis: 0,
    minWidth: 0,
  },
  halfCard: {
    flex: 1,
    backgroundColor: GLASS_FILL,
    borderWidth: 1,
    borderColor: GLASS_BORDER,
    borderRadius: 20,
    padding: 18,
  },
  halfNum: {
    fontSize: 24,
    fontWeight: "700",
    color: colors.textOnDark,
    marginBottom: 5,
    fontFamily: fonts.bodyBold,
  },
  balanceNum: {
    color: colors.dangerOnDark,
    fontSize: 20,
  },
  halfMeta: {
    fontFamily: fonts.body,
    fontSize: 12,
    color: colors.textOnDarkMuted,
  },
  feedCard: {
    flex: 1,
    position: "relative",
    borderRadius: 20,
    overflow: "hidden",
    height: 130,
    borderWidth: 1,
    borderColor: GLASS_BORDER,
  },
  feedImage: {
    // Absolute so the two crossfading layers stack; the card has a fixed height.
    ...StyleSheet.absoluteFillObject,
  },
  feedPlaceholder: {
    backgroundColor: colors.navySurface,
    alignItems: "center",
    justifyContent: "center",
  },
  feedGradient: {
    ...StyleSheet.absoluteFillObject,
  },
  feedCaption: {
    marginTop: 6,
    fontSize: 12,
    fontWeight: "600",
    color: colors.white,
    fontFamily: fonts.bodySemiBold,
  },
  nudgeCard: {
    padding: 18,
    marginBottom: 0,
    flex: 1,
    justifyContent: "space-between",
  },
  nudgeCardTitle: {
    fontSize: 15,
    fontWeight: "700",
    color: colors.textOnDarkSoft,
    marginBottom: 4,
    fontFamily: fonts.bodyBold,
  },
  nudgeCardMeta: {
    fontFamily: fonts.body,
    fontSize: 12,
    color: colors.textOnDarkMuted,
  },
  /* ── Quick actions ── */
  qaRow: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  qaItem: {
    alignItems: "center",
    gap: 8,
    flex: 1,
  },
  qaGlyph: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: withAlpha(GOLD, 0.16),
    alignItems: "center",
    justifyContent: "center",
  },
  qaLabel: {
    fontFamily: fonts.bodyMedium,
    fontSize: 10,
    fontWeight: "500",
    color: colors.textOnDarkMuted,
    textAlign: "center",
  },
  /* ── Activity ── */
  actRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: GLASS_HAIRLINE,
  },
  actAvatar: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: withAlpha(colors.white, 0.09),
    alignItems: "center",
    justifyContent: "center",
  },
  actAvatarText: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 11,
    fontWeight: "600",
    color: colors.textOnDarkBody,
  },
  actText: {
    fontFamily: fonts.body,
    flex: 1,
    fontSize: 13,
    color: colors.textOnDarkBody,
  },
  actTime: {
    fontFamily: fonts.body,
    fontSize: 11,
    color: colors.textOnDarkDim,
  },
  /* ── Vault (gold-tinted glass) ── */
  vaultCard: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    borderRadius: 20,
    padding: 18,
    marginBottom: 20,
    backgroundColor: withAlpha(colors.goldGlow, 0.07),
    borderWidth: 1,
    borderColor: withAlpha(colors.goldGlow, 0.22),
  },
  vaultLabel: {
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 0.5,
    color: colors.goldGlowDim,
    marginBottom: 8,
    fontFamily: fonts.bodySemiBold,
  },
  vaultTitle: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.textOnDark,
    fontFamily: fonts.bodySemiBold,
  },
  vaultTime: {
    fontSize: 11,
    fontWeight: "500",
    color: GOLD,
    fontFamily: fonts.mono,
  },
  insightsText: {
    fontSize: 15,
    lineHeight: 22,
    fontWeight: "600",
    color: colors.textOnDarkSoft,
    fontFamily: fonts.bodySemiBold,
  },
});

/* ── Modal ── */
/* Notify Members sheet — night glass to match the screen it opens from. */
const mo = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: withAlpha(colors.navyDark, 0.7),
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: colors.navyBase,
    borderTopLeftRadius: radius.xl + 4,
    borderTopRightRadius: radius.xl + 4,
    borderTopWidth: 1,
    borderColor: GLASS_BORDER,
    paddingTop: spacing.sm,
    paddingHorizontal: spacing.xxl,
    maxHeight: "85%",
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: withAlpha(colors.white, 0.18),
    alignSelf: "center",
    marginBottom: spacing.xxl,
  },
  title: {
    fontSize: 20,
    fontWeight: "800",
    fontFamily: fonts.display,
    color: colors.textOnDark,
    marginBottom: spacing.lg,
  },
  body: {
    flexGrow: 0,
  },
  // Preset nudge message icons
  presetGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.md,
    marginBottom: spacing.lg,
  },
  presetItem: {
    width: "30%",
    alignItems: "center",
    gap: 6,
  },
  presetGlyph: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: withAlpha(GOLD, 0.16),
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "transparent",
  },
  presetGlyphActive: {
    backgroundColor: colors.goldGlow,
    borderColor: colors.goldGlow,
  },
  presetLabel: {
    fontSize: 10.5,
    fontWeight: "600",
    fontFamily: fonts.bodySemiBold,
    color: colors.textOnDarkMuted,
    textAlign: "center",
  },
  presetLabelActive: {
    color: GOLD,
  },
  // Custom message input
  input: {
    minHeight: 72,
    backgroundColor: withAlpha(colors.white, 0.05),
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: GLASS_BORDER,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    fontSize: 14,
    fontFamily: fonts.body,
    color: colors.textOnDark,
    textAlignVertical: "top",
    marginBottom: spacing.lg,
  },
  // Recipients
  allRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: GLASS_BORDER,
  },
  allText: {
    fontSize: 15,
    fontWeight: "700",
    fontFamily: fonts.displayBold,
    color: colors.textOnDark,
  },
  mRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 14,
    paddingHorizontal: 4,
    borderBottomWidth: 1,
    borderBottomColor: GLASS_HAIRLINE,
  },
  mRowSel: {
    backgroundColor: withAlpha(colors.goldGlow, 0.1),
  },
  mName: {
    fontSize: 15,
    fontWeight: "600",
    fontFamily: fonts.bodySemiBold,
    color: colors.textOnDarkBody,
  },
  cb: {
    width: 24,
    height: 24,
    borderRadius: radius.pill,
    borderWidth: 2,
    borderColor: withAlpha(colors.white, 0.2),
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "transparent",
  },
  cbOn: {
    backgroundColor: colors.goldGlow,
    borderColor: colors.goldGlow,
  },
  nudgeSectionLabel: {
    fontSize: 11,
    fontWeight: "700",
    fontFamily: fonts.bodySemiBold,
    color: colors.textFaint,
    letterSpacing: 0.6,
    marginBottom: spacing.sm,
  },
  // Footer actions
  actions: {
    flexDirection: "row",
    gap: spacing.md,
    marginTop: spacing.xxl,
  },
  cancelBtn: {
    flex: 1,
    paddingVertical: 15,
    borderRadius: radius.md,
    backgroundColor: withAlpha(colors.white, 0.07),
    alignItems: "center",
  },
  cancelText: {
    fontSize: 15,
    fontWeight: "700",
    fontFamily: fonts.bodySemiBold,
    color: colors.textOnDarkMuted,
  },
  sendBtn: {
    flex: 1,
    paddingVertical: 15,
    borderRadius: radius.md,
    backgroundColor: colors.gold,
    alignItems: "center",
    ...goldButton.glow,
  },
  sendBtnDisabled: {
    opacity: 0.35,
  },
  sendText: {
    fontSize: 15,
    fontWeight: "700",
    fontFamily: fonts.displayBold,
    color: colors.navyDeep,
  },
});
