import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  TextInput,
  StatusBar,
  Modal,
  Animated,
  Dimensions,
  Linking,
  AppState,
} from 'react-native';
import { PanGestureHandler, State } from 'react-native-gesture-handler';
import { showAlert } from '../shared/services/themedAlert';
import {
  Map as MapLibreMap,
  Camera,
  Marker,
  GeoJSONSource,
  Layer,
} from '@maplibre/maplibre-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Location from 'expo-location';
import { ensureLocation, hasPermission } from '../shared/permissions';
import { checkInApi } from '../shared/api/checkin';
import { pingApi } from '../shared/api/ping';
import { placeApi } from '../shared/api/place';
import { householdApi } from '../shared/api/household';
import { usePingStore } from '../shared/store/pingStore';
import { useAuthStore } from '../shared/store/authStore';
import { colors, fonts, goldButton, radius, withAlpha } from '../shared/theme';
import { GoldFill } from '../shared/components/GoldButton';
import { haversineDistanceKm, formatDistance } from '../shared/utils/geo';
import Avatar from '../components/Avatar';
import { KeyboardAvoider } from '../shared/components/KeyboardAware';
import { useTabBarDockHeight } from '../shared/hooks/useTabBarDockHeight';
import { DARK_MAP_STYLE } from '../shared/constants/darkMapStyle';
const PLACE_ICON_EMOJI = {
  home: '⌂',
  office: '💼',
  school: '🎓',
  custom: '★',
};
const PLACE_ICON_OPTIONS = ['home', 'office', 'school', 'custom'];
// How long the responder shares their location before accepting — always
// foreground-only (no background tracking), auto-stops on duration elapse
// or the app being backgrounded.
const SHARE_DURATION_OPTIONS = [
  { minutes: 15, label: '15 min' },
  { minutes: 30, label: '30 min' },
  { minutes: 60, label: '1 hour' },
  { minutes: 120, label: '2 hours' },
];
const SHARE_TICK_MS = 45_000; // how often a location update is pushed while sharing
const SCREEN_HEIGHT = Dimensions.get('window').height;
const TRAY_COLLAPSED_HEIGHT = 300;
const TRAY_EXPANDED_HEIGHT = Math.round(SCREEN_HEIGHT * 0.9);
function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
function formatCountdown(msRemaining) {
  const totalSeconds = Math.max(0, Math.floor(msRemaining / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, '0')} left`;
}

/**
 * Free, no-API-key, no-billing map: MapLibre GL Native (a real native
 * MapView, not a WebView) styled with OpenFreeMap's "dark" vector tiles.
 * Pins (self/ping-everyone drop pin, saved places, last-known member
 * positions, and the "focus" pin for a tapped Recent entry) are plain RN
 * views rendered as native map markers via <Marker>.
 */

/**
 * CheckInScreen ("Ping") — map-first redesign (concept approved by user).
 * Three capabilities live in one persistent bottom tray over a live map:
 *  1. Ping everyone — broadcast your current location to the household.
 *  2. Request location — ask a specific member to share theirs.
 *  3. Saved places — bookmark Home/Office/School/custom locations, shown
 *     as permanent pins on the map and quick chips in the tray.
 *
 * Location permission is requested ONLY on tap (FR-166); no background
 * tracking (FR-167). If the user declines, we still send a timestamp-only
 * check-in (FR-168) — the success copy adapts.
 */
export default function CheckInScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const dockHeight = useTabBarDockHeight();
  const currentUserId = useAuthStore((s) => s.user?.id || '');
  const householdId = useAuthStore((s) => s.householdId);
  const [loading, setLoading] = useState(true);
  const [checkingIn, setCheckingIn] = useState(false);
  const [recent, setRecent] = useState([]);
  // null = idle; success object = show Screen 33
  const [success, setSuccess] = useState(null);

  // ── Ping: request a member's location ──
  const incoming = usePingStore((s) => s.incoming);
  const outgoing = usePingStore((s) => s.outgoing);
  const setIncoming = usePingStore((s) => s.setIncoming);
  const removeIncoming = usePingStore((s) => s.removeIncoming);
  const [members, setMembers] = useState([]);
  const [showMemberPicker, setShowMemberPicker] = useState(false);
  const [requestingPingId, setRequestingPingId] = useState(null);
  const [respondingPingId, setRespondingPingId] = useState(null);
  // Incoming request awaiting a duration choice before it's accepted.
  const [durationRequest, setDurationRequest] = useState(null);
  // The live share this device is currently broadcasting (if any):
  // { pingRequestId, requesterName, expiresAt }.
  const [activeShare, setActiveShare] = useState(null);
  const [shareNow, setShareNow] = useState(() => Date.now()); // ticks every second while activeShare is set, to drive the countdown
  const shareIntervalRef = useRef(null);
  const shareAppStateSubRef = useRef(null);
  const shareCountdownRef = useRef(null);

  // ── Saved places ──
  const [places, setPlaces] = useState([]);
  const [showPlaceSheet, setShowPlaceSheet] = useState(false);
  const [editingPlaceId, setEditingPlaceId] = useState(null);
  const [placeName, setPlaceName] = useState('');
  const [placeIcon, setPlaceIcon] = useState('home');
  const [placeCoords, setPlaceCoords] = useState(null);
  const [locatingPlace, setLocatingPlace] = useState(false);
  const [savingPlace, setSavingPlace] = useState(false);
  const [deletingPlaceId, setDeletingPlaceId] = useState(null);

  // Map state — starts centered on the household area (Kathmandu); after a
  // ping the marker jumps to the shared location.
  const [mapCenter, setMapCenter] = useState({
    latitude: 27.7172,
    longitude: 85.324,
  });
  const [mapZoom, setMapZoom] = useState(12);
  const [mapPin, setMapPin] = useState(null);
  const [focusPin, setFocusPin] = useState(null);
  // My current position, fetched specifically to draw a route line to focusPin.
  const [myLocation, setMyLocation] = useState(null);

  // ── Bottom tray: drag the handle up/down to reveal more of "Recent" ──
  // The tray is a fixed-height absolute overlay on top of the map, animated
  // purely via `transform: translateY` (native driver) rather than resizing
  // its layout `height` — resizing would force the map's WebView to reflow
  // on every frame of the drag, which is what made the old version feel
  // sluggish. translateY 0 = fully expanded, MAX_TRAY_TRANSLATE = collapsed.
  const MAX_TRAY_TRANSLATE = TRAY_EXPANDED_HEIGHT - TRAY_COLLAPSED_HEIGHT;
  const trayTranslateY = useRef(new Animated.Value(MAX_TRAY_TRANSLATE)).current;
  const trayTranslateValue = useRef(MAX_TRAY_TRANSLATE);
  const trayExpanded = useRef(false);
  useEffect(() => {
    const id = trayTranslateY.addListener(({ value }) => {
      trayTranslateValue.current = value;
    });
    return () => trayTranslateY.removeListener(id);
  }, [trayTranslateY]);
  // Drag tracking runs entirely on the native thread via
  // react-native-gesture-handler + Animated.event — PanResponder's JS-thread
  // touch handling was the source of the visible lag/glitch while dragging.
  // `trayTranslateY.setOffset/setValue(0)` on grant + feeding the gesture's
  // raw `translationY` straight back into `trayTranslateY` itself (same
  // Animated.Value that carries the offset) is the standard offset+delta
  // pattern — Animated.event MUST target the offset-bearing value directly,
  // a separate value here would never actually move the rendered transform.
  const onTrayGestureEvent = useRef(
    Animated.event([{ nativeEvent: { translationY: trayTranslateY } }], {
      useNativeDriver: true,
    }),
  ).current;
  const onTrayHandlerStateChange = useCallback(
    (event) => {
      const { state, oldState, translationY, velocityY } = event.nativeEvent;
      if (state === State.BEGAN) {
        trayTranslateY.stopAnimation(() => {
          trayTranslateY.setOffset(trayTranslateValue.current);
          trayTranslateY.setValue(0);
        });
        return;
      }
      if (oldState === State.ACTIVE) {
        trayTranslateY.flattenOffset();
        // PanGestureHandler reports velocity in px/s, PanResponder's old
        // thresholds were px/ms — ×1000 to keep the same feel.
        const shouldExpand = translationY < -40 || velocityY < -400;
        const shouldCollapse = translationY > 40 || velocityY > 400;
        const willExpand = shouldCollapse
          ? false
          : shouldExpand
            ? true
            : trayTranslateValue.current < MAX_TRAY_TRANSLATE / 2;
        trayExpanded.current = willExpand;
        Animated.spring(trayTranslateY, {
          toValue: clamp(willExpand ? 0 : MAX_TRAY_TRANSLATE, 0, MAX_TRAY_TRANSLATE),
          useNativeDriver: true,
          bounciness: 4,
        }).start();
      }
    },
    [trayTranslateY, MAX_TRAY_TRANSLATE],
  );
  const collapseTray = useCallback(() => {
    trayExpanded.current = false;
    Animated.spring(trayTranslateY, {
      toValue: MAX_TRAY_TRANSLATE,
      useNativeDriver: true,
      bounciness: 4,
    }).start();
  }, [trayTranslateY, MAX_TRAY_TRANSLATE]);

  // Jump the map to a Recent entry's location — used when the user taps a row.
  // Also fetches my own current position so a route line can be drawn to it.
  const handleFocusRecent = useCallback(
    async (item) => {
      if (item.latitude == null || item.longitude == null) return;
      const name = item.user?.displayName || 'Family member';
      setMapCenter({
        latitude: item.latitude,
        longitude: item.longitude,
      });
      setMapZoom(16);
      setFocusPin({
        latitude: item.latitude,
        longitude: item.longitude,
        label: `${name} · ${timeLabel(item.checkedInAt)}`,
        name,
        checkInId: item.id,
      });
      collapseTray();
      try {
        // Incidental locate — the user tapped a pin, not a "find me" button,
        // so a refusal must not interrupt with the permission sheet.
        if (!(await ensureLocation({ silent: true }))) {
          setMyLocation(null);
          return;
        }
        const pos = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        setMyLocation({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
        });
      } catch {
        setMyLocation(null);
      }
    },
    [collapseTray],
  );
  const dismissRoute = useCallback(() => {
    setFocusPin(null);
    setMyLocation(null);
  }, []);
  const handleOpenDirections = useCallback(() => {
    if (!focusPin) return;
    const url = `https://www.google.com/maps/dir/?api=1&destination=${focusPin.latitude},${focusPin.longitude}`;
    Linking.openURL(url).catch(() => {
      showAlert('Error', 'Could not open Maps.');
    });
  }, [focusPin]);

  // While viewing someone's shared location, follow their live position for
  // as long as they're actively sharing (matched via the CheckIn id the
  // accept flow created, since that's what both the Recent-list pin and the
  // PingRequest.checkInId already share).
  useEffect(() => {
    if (!focusPin?.checkInId || outgoing.length === 0) return;
    const live = outgoing.find(
      (r) => r.checkInId === focusPin.checkInId && r.liveLatitude != null && r.liveLongitude != null,
    );
    if (!live) return;
    setFocusPin((prev) =>
      prev && prev.checkInId === focusPin.checkInId
        ? { ...prev, latitude: live.liveLatitude, longitude: live.liveLongitude, label: `${prev.name} · Live` }
        : prev,
    );
  }, [outgoing, focusPin?.checkInId]);

  // Reverse-geocode a coordinate into "City, Region, Country" (or a fallback).
  const geocode = useCallback(async (lat, lng) => {
    try {
      const geo = await Location.reverseGeocodeAsync({
        latitude: lat,
        longitude: lng,
      });
      const g = geo[0];
      if (g) {
        return [g.city, g.region, g.country].filter(Boolean).join(', ') || 'shared location';
      }
    } catch {
      // fall through
    }
    return 'shared location';
  }, []);
  const load = useCallback(async () => {
    try {
      setLoading(true);
      const tl = await checkInApi.list({
        limit: 20,
      });
      setRecent(tl.items);
    } catch {
      // keep existing state
    } finally {
      setLoading(false);
    }
  }, []);
  const loadPlaces = useCallback(async () => {
    try {
      const list = await placeApi.list();
      setPlaces(list);
      if (list.length > 0) {
        setMapCenter({
          latitude: list[0].latitude,
          longitude: list[0].longitude,
        });
      }
    } catch {
      // keep existing state
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    loadPlaces();
  }, [loadPlaces]);
  useEffect(() => {
    if (!householdId) return;
    householdApi
      .getMembers(householdId)
      .then(setMembers)
      .catch(() => {});
  }, [householdId]);
  useEffect(() => {
    pingApi
      .list({
        direction: 'incoming',
        status: 'pending',
      })
      .then((data) => setIncoming(data.items))
      .catch(() => {});
  }, [setIncoming]);

  // Members keyed by userId — the authoritative source for avatarUrl/avatarEmoji
  // (check-in payloads' nested `user` isn't guaranteed to include them).
  const membersById = React.useMemo(() => {
    const map = new Map();
    for (const m of members) map.set(m.userId, m);
    return map;
  }, [members]);

  // ── Member "last seen" pins — latest located check-in per member ──
  const memberPins = React.useMemo(() => {
    const latest = new Map();
    for (const item of recent) {
      if (item.latitude == null || item.longitude == null) continue;
      const existing = latest.get(item.userId);
      if (!existing || new Date(item.checkedInAt) > new Date(existing.checkedInAt)) {
        latest.set(item.userId, item);
      }
    }
    return Array.from(latest.values()).map((item) => {
      const member = membersById.get(item.userId);
      const displayName = member?.displayName || item.user?.displayName || 'Family member';
      return {
        userId: item.userId,
        latitude: item.latitude,
        longitude: item.longitude,
        displayName,
        avatarUrl: member?.avatarUrl,
        avatarEmoji: member?.avatarEmoji,
        initial: displayName.charAt(0).toUpperCase(),
      };
    });
  }, [recent, membersById]);
  const handleRequestPing = useCallback(async (member) => {
    setRequestingPingId(member.userId);
    try {
      await pingApi.create(member.userId);
      setShowMemberPicker(false);
      showAlert('Request sent', `Asked ${member.displayName} to share their location.`);
    } catch (e) {
      const msg = e?.response?.data?.error || 'Could not send the request. Please try again.';
      showAlert('Error', msg);
    } finally {
      setRequestingPingId(null);
    }
  }, []);
  // Ends the current live-share loop. `notifyServer` is false when the
  // share already ended server-side (duration elapsed) — no need to tell it
  // again — and true for the app-backgrounded / manual-stop / unmount cases.
  const stopShareLoop = useCallback((notifyServer = true) => {
    if (shareIntervalRef.current) {
      clearInterval(shareIntervalRef.current);
      shareIntervalRef.current = null;
    }
    if (shareCountdownRef.current) {
      clearInterval(shareCountdownRef.current);
      shareCountdownRef.current = null;
    }
    if (shareAppStateSubRef.current) {
      shareAppStateSubRef.current.remove();
      shareAppStateSubRef.current = null;
    }
    setActiveShare((prev) => {
      if (prev && notifyServer) {
        pingApi.stopShare(prev.pingRequestId).catch(() => {});
      }
      return null;
    });
  }, []);

  // Foreground-only: pushes a location update every SHARE_TICK_MS until the
  // duration elapses or the app is backgrounded (matches the app's existing
  // "no background location tracking" policy — this loop simply doesn't run
  // while backgrounded, it isn't paused-and-resumed).
  const startShareLoop = useCallback(
    (pingRequestId, expiresAt, requesterName) => {
      setActiveShare({ pingRequestId, expiresAt, requesterName });
      setShareNow(Date.now());

      const pushTick = async () => {
        if (Date.now() >= new Date(expiresAt).getTime()) {
          stopShareLoop(false);
          return;
        }
        try {
          // Background tick — the sheet would surface while the user is
          // somewhere else entirely.
          if (!(await ensureLocation({ silent: true }))) return;
          const pos = await Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.Balanced,
          });
          await pingApi.updateLocation(pingRequestId, {
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
          });
        } catch {
          // a single missed tick isn't fatal — the next one retries
        }
      };

      shareIntervalRef.current = setInterval(pushTick, SHARE_TICK_MS);
      shareCountdownRef.current = setInterval(() => setShareNow(Date.now()), 1000);
      shareAppStateSubRef.current = AppState.addEventListener('change', (nextState) => {
        if (nextState !== 'active') {
          stopShareLoop(true);
        }
      });
    },
    [stopShareLoop],
  );

  useEffect(() => () => stopShareLoop(true), [stopShareLoop]);

  const handleRespondPing = useCallback(
    async (request, action, durationMinutes) => {
      setRespondingPingId(request.id);
      try {
        if (action === 'decline') {
          await pingApi.respond(request.id, {
            action: 'decline',
          });
          removeIncoming(request.id);
          return;
        }
        let lat = null;
        let lng = null;
        let place = null;
        // Accepting a ping is a deliberate "here's where I am", so explain a
        // refusal — but still respond without coords if they decline.
        if (await ensureLocation()) {
          const pos = await Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.Balanced,
          });
          lat = pos.coords.latitude;
          lng = pos.coords.longitude;
          place = await geocode(lat, lng);
        }
        const response = await pingApi.respond(request.id, {
          action: 'accept',
          latitude: lat,
          longitude: lng,
          address: place,
          durationMinutes,
        });
        removeIncoming(request.id);
        if (response?.shareExpiresAt) {
          startShareLoop(request.id, response.shareExpiresAt, request.requester?.displayName);
        }
        await load();
      } catch (e) {
        const msg = e?.response?.data?.error || 'Could not respond. Please try again.';
        showAlert('Error', msg);
      } finally {
        setRespondingPingId(null);
      }
    },
    [geocode, removeIncoming, load, startShareLoop],
  );
  const handlePingEveryone = useCallback(async () => {
    if (checkingIn) return;
    setCheckingIn(true);
    try {
      let lat = null;
      let lng = null;
      let place = null;
      let shared = false;

      // Permission asked only when the user taps the button (FR-166).
      // Declining still checks them in, just without a location attached.
      if (await ensureLocation()) {
        const pos = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        lat = pos.coords.latitude;
        lng = pos.coords.longitude;
        shared = true;
        place = await geocode(lat, lng);
      }
      await checkInApi.create({
        latitude: lat,
        longitude: lng,
        address: place,
        note: null,
      });
      if (lat && lng) {
        setMapCenter({
          latitude: lat,
          longitude: lng,
        });
        setMapZoom(15);
        setMapPin({
          latitude: lat,
          longitude: lng,
        });
        setFocusPin(null);
        setMyLocation(null);
      }
      setSuccess({
        sharedLocation: shared,
        place,
      });
      await load();
    } catch (e) {
      const msg = e?.response?.data?.error || 'Could not share your location. Please try again.';
      showAlert('Error', msg);
    } finally {
      setCheckingIn(false);
    }
  }, [checkingIn, geocode, load]);
  const handleLocateMe = useCallback(async () => {
    try {
      if (!(await ensureLocation())) return;
      const pos = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      setMapCenter({
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
      });
      setMapZoom(15);
      setFocusPin(null);
      setMyLocation(null);
    } catch {
      // ignore
    }
  }, []);

  // ── Saved places ──
  const openAddPlace = useCallback(() => {
    setEditingPlaceId(null);
    setPlaceName('');
    setPlaceIcon('home');
    setPlaceCoords(null);
    setShowPlaceSheet(true);
  }, []);
  const openEditPlace = useCallback((place) => {
    setEditingPlaceId(place.id);
    setPlaceName(place.name);
    setPlaceIcon(place.icon);
    setPlaceCoords({
      latitude: place.latitude,
      longitude: place.longitude,
      address: place.address,
    });
    setShowPlaceSheet(true);
  }, []);
  const handleUseCurrentLocationForPlace = useCallback(async () => {
    // The place sheet is a Modal and so is the permission sheet; stacking one
    // on the other is unreliable on Android. Drop this sheet while the gate
    // runs and bring it straight back — the form lives in screen state
    // (placeName/placeIcon/placeCoords), so nothing the user typed is lost.
    if (!(await hasPermission('location'))) {
      setShowPlaceSheet(false);
      const allowed = await ensureLocation();
      setShowPlaceSheet(true);
      if (!allowed) return;
    }
    setLocatingPlace(true);
    try {
      const pos = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      const address = await geocode(pos.coords.latitude, pos.coords.longitude);
      setPlaceCoords({
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        address,
      });
    } catch {
      showAlert('Error', 'Could not get your current location.');
    } finally {
      setLocatingPlace(false);
    }
  }, [geocode]);
  const handleSavePlace = useCallback(async () => {
    if (!placeName.trim() || !placeCoords) return;
    setSavingPlace(true);
    try {
      if (editingPlaceId) {
        await placeApi.update(editingPlaceId, {
          name: placeName.trim(),
          icon: placeIcon,
          latitude: placeCoords.latitude,
          longitude: placeCoords.longitude,
          address: placeCoords.address,
        });
      } else {
        await placeApi.create({
          name: placeName.trim(),
          icon: placeIcon,
          latitude: placeCoords.latitude,
          longitude: placeCoords.longitude,
          address: placeCoords.address,
        });
      }
      await loadPlaces();
      setEditingPlaceId(null);
      setPlaceName('');
      setPlaceIcon('home');
      setPlaceCoords(null);
    } catch (e) {
      const msg = e?.response?.data?.error || 'Could not save this place. Please try again.';
      showAlert('Error', msg);
    } finally {
      setSavingPlace(false);
    }
  }, [placeName, placeIcon, placeCoords, editingPlaceId, loadPlaces]);
  const handleDeletePlace = useCallback(
    (place) => {
      showAlert('Delete place', `Remove "${place.name}" from saved places?`, [
        {
          text: 'Cancel',
          style: 'cancel',
        },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setDeletingPlaceId(place.id);
            try {
              await placeApi.remove(place.id);
              await loadPlaces();
              if (editingPlaceId === place.id) {
                setEditingPlaceId(null);
                setPlaceName('');
                setPlaceCoords(null);
              }
            } catch {
              showAlert('Error', 'Could not delete this place.');
            } finally {
              setDeletingPlaceId(null);
            }
          },
        },
      ]);
    },
    [loadPlaces, editingPlaceId],
  );

  // ── Screen 33: Ping Success ──
  if (success) {
    return (
      <View style={styles.root}>
        <StatusBar barStyle="light-content" backgroundColor={colors.canvas} />
        <View
          style={[
            styles.container,
            {
              paddingTop: insets.top,
            },
          ]}
        >
          <View style={styles.successWrap}>
            <View style={styles.successCircle}>
              <Text style={styles.successCheck}>✓</Text>
            </View>
            <Text style={styles.successTitle}>Location shared</Text>
            <Text style={styles.successSub}>
              {success.sharedLocation && success.place
                ? `Your household was notified you arrived at ${success.place}.`
                : 'Your household was notified.'}
            </Text>
            <TouchableOpacity
              style={styles.doneBtn}
              onPress={() => {
                setSuccess(null);
              }}
              activeOpacity={0.8}
            >
              <Text style={styles.doneBtnText}>Done</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    );
  }

  // ── Main — Ping Home (map-first) ──
  return (
    <View style={styles.dataRoot}>
      <StatusBar barStyle="light-content" backgroundColor={colors.canvas} />

      {/* Header — back button + centered title + add-place, all one row */}
      <View
        style={[
          styles.header,
          {
            paddingTop: insets.top,
            height: 56 + insets.top,
          },
        ]}
      >
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => navigation.goBack()}
          hitSlop={{
            top: 8,
            bottom: 8,
            left: 8,
            right: 8,
          }}
        >
          <Text style={styles.backIcon}>‹</Text>
        </TouchableOpacity>
        <View
          style={[
            styles.headerTitleWrap,
            {
              top: insets.top,
              height: 56,
            },
          ]}
        >
          <Text style={styles.headerTitle}>Ping</Text>
        </View>
        <View style={styles.headerSpacer}>
          <TouchableOpacity style={styles.addBtn} onPress={openAddPlace} activeOpacity={0.8}>
            <Text style={styles.addBtnText}>+</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Map fills the remaining space */}
      <View style={styles.map}>
        <MapLibreMap
          style={StyleSheet.absoluteFill}
          mapStyle={DARK_MAP_STYLE}
          compass={false}
          logo={false}
          attribution
          touchPitch={false}
          touchRotate={false}
        >
          <Camera
            center={[mapCenter.longitude, mapCenter.latitude]}
            zoom={mapZoom}
            duration={600}
          />

          {mapPin && (
            <Marker lngLat={[mapPin.longitude, mapPin.latitude]}>
              <View style={styles.nativeSelfPin} />
            </Marker>
          )}

          {places.map((place) => (
            <Marker key={place.id} lngLat={[place.longitude, place.latitude]} anchor="bottom">
              <View style={styles.nativePlacePinWrap}>
                <View style={styles.nativePlacePinCircle}>
                  <Text style={styles.nativePlacePinEmoji}>{PLACE_ICON_EMOJI[place.icon]}</Text>
                </View>
                <Text style={styles.nativePlacePinLabel}>{place.name}</Text>
              </View>
            </Marker>
          ))}

          {memberPins.map((member) => (
            <Marker key={member.userId} lngLat={[member.longitude, member.latitude]}>
              <View style={styles.nativeMemberPin}>
                <Avatar
                  url={member.avatarUrl}
                  emoji={member.avatarEmoji}
                  name={member.displayName}
                  id={member.userId}
                  size={19}
                />
              </View>
            </Marker>
          ))}

          {focusPin && myLocation && (
            <GeoJSONSource
              id="routeLine"
              data={{
                type: 'Feature',
                geometry: {
                  type: 'LineString',
                  coordinates: [
                    [myLocation.longitude, myLocation.latitude],
                    [focusPin.longitude, focusPin.latitude],
                  ],
                },
                properties: {},
              }}
            >
              <Layer
                id="routeLineLayer"
                type="line"
                style={{
                  lineColor: colors.ink,
                  lineWidth: 2.5,
                  lineDasharray: [2, 2],
                  lineOpacity: 0.7,
                }}
              />
            </GeoJSONSource>
          )}

          {myLocation && (
            <Marker lngLat={[myLocation.longitude, myLocation.latitude]}>
              <View style={styles.nativeMyLocationPin} />
            </Marker>
          )}

          {focusPin && (
            <Marker lngLat={[focusPin.longitude, focusPin.latitude]} anchor="bottom">
              <View style={styles.nativeFocusPinWrap}>
                <View style={styles.nativeFocusLabel}>
                  <Text style={styles.nativeFocusLabelText}>{focusPin.label}</Text>
                </View>
                <View style={styles.nativeFocusPinShape} />
              </View>
            </Marker>
          )}
        </MapLibreMap>

        {/* Incoming ping requests — overlaid on the map, not blocking */}
        {incoming.length > 0 && (
          <View style={styles.pingBannerList} pointerEvents="box-none">
            {incoming.map((request) => (
              <View key={request.id} style={styles.pingBanner}>
                <Text style={styles.pingBannerText}>
                  {request.requester?.displayName || 'Someone'} wants your location
                </Text>
                <View style={styles.pingBannerActions}>
                  <TouchableOpacity
                    style={styles.pingDeclineBtn}
                    onPress={() => handleRespondPing(request, 'decline')}
                    disabled={respondingPingId === request.id}
                    activeOpacity={0.8}
                  >
                    <Text style={styles.pingDeclineText}>Decline</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.pingAcceptBtn}
                    onPress={() => setDurationRequest(request)}
                    disabled={respondingPingId === request.id}
                    activeOpacity={0.8}
                  >
                    <GoldFill radius={12} disabled={respondingPingId === request.id} />
                    {respondingPingId === request.id ? (
                      <ActivityIndicator size="small" color={colors.onAccent} />
                    ) : (
                      <Text style={styles.pingAcceptText}>Share</Text>
                    )}
                  </TouchableOpacity>
                </View>
              </View>
            ))}
          </View>
        )}

        {/* Live share indicator — this device is currently broadcasting */}
        {activeShare && (
          <View style={styles.shareStatusCard} pointerEvents="box-none">
            <Text style={styles.shareStatusText} numberOfLines={1}>
              Sharing with {activeShare.requesterName || 'them'} ·{' '}
              {formatCountdown(new Date(activeShare.expiresAt).getTime() - shareNow)}
            </Text>
            <TouchableOpacity
              onPress={() => stopShareLoop(true)}
              activeOpacity={0.8}
              hitSlop={8}
            >
              <Text style={styles.shareStatusStop}>Stop</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Route to a shared location — distance readout + hand off to native Maps */}
        {focusPin && (
          <View style={styles.routeCard} pointerEvents="box-none">
            <View style={styles.routeCardRow}>
              <Text style={styles.routeCardText} numberOfLines={1}>
                {myLocation
                  ? `${focusPin.name} · ${formatDistance(haversineDistanceKm(myLocation, focusPin))} away`
                  : `${focusPin.name}'s location`}
              </Text>
              <TouchableOpacity
                onPress={dismissRoute}
                hitSlop={{
                  top: 8,
                  bottom: 8,
                  left: 8,
                  right: 8,
                }}
              >
                <Text style={styles.routeCardClose}>✕</Text>
              </TouchableOpacity>
            </View>
            <TouchableOpacity
              style={styles.routeCardDirectionsBtn}
              onPress={handleOpenDirections}
              activeOpacity={0.8}
            >
              <Text style={styles.routeCardDirectionsText}>Open in Maps</Text>
            </TouchableOpacity>
          </View>
        )}

        <TouchableOpacity style={styles.locateBtn} onPress={handleLocateMe} activeOpacity={0.85}>
          <Text style={styles.locateBtnText}>◎</Text>
        </TouchableOpacity>
      </View>

      {/* Bottom tray — persistent, holds all three Ping capabilities.
          Drag the handle to expand it and see more of "Recent". Fixed
          height + animated transform (not layout height) keeps the drag
          smooth — the map behind it never has to reflow mid-gesture. */}
      <Animated.View
        style={[
          styles.tray,
          {
            height: TRAY_EXPANDED_HEIGHT,
            paddingBottom: dockHeight + 12,
            transform: [
              {
                translateY: trayTranslateY,
              },
            ],
          },
        ]}
      >
        <PanGestureHandler
          onGestureEvent={onTrayGestureEvent}
          onHandlerStateChange={onTrayHandlerStateChange}
        >
          <Animated.View style={styles.handleGrabArea}>
            <View style={styles.handle} />
          </Animated.View>
        </PanGestureHandler>

        <View style={styles.actionRow}>
          <TouchableOpacity
            style={[styles.actionCard, styles.actionPrimary]}
            onPress={handlePingEveryone}
            disabled={checkingIn}
            activeOpacity={0.85}
          >
            {checkingIn ? (
              <ActivityIndicator size="small" color={colors.gold} />
            ) : (
              <>
                <Text style={styles.actionIconPrimary}>◈</Text>
                <Text style={styles.actionTitlePrimary}>Ping everyone</Text>
                <Text style={styles.actionSubPrimary}>Share your location with the household</Text>
              </>
            )}
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.actionCard, styles.actionSecondary]}
            onPress={() => setShowMemberPicker(true)}
            activeOpacity={0.85}
          >
            <Text style={styles.actionIconSecondary}>⚲</Text>
            <Text style={styles.actionTitleSecondary}>Request location</Text>
            <Text style={styles.actionSubSecondary}>Ask a member to share theirs</Text>
          </TouchableOpacity>
        </View>

        <View>
          <Text style={styles.sectionLabel}>Saved places</Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.placesRail}
          >
            {places.map((place) => (
              <TouchableOpacity
                key={place.id}
                style={styles.placeChip}
                onPress={() => openEditPlace(place)}
                activeOpacity={0.8}
              >
                <View style={styles.placeChipDot}>
                  <Text style={styles.placeChipDotText}>{PLACE_ICON_EMOJI[place.icon]}</Text>
                </View>
                <Text style={styles.placeChipName}>{place.name}</Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity
              style={styles.placeChipAdd}
              onPress={openAddPlace}
              activeOpacity={0.8}
            >
              <Text style={styles.placeChipAddText}>+ Add place</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>

        <FlatList
          data={recent}
          keyExtractor={(item) => item.id}
          style={styles.recentList}
          ItemSeparatorComponent={() => <View style={styles.recentSeparator} />}
          ListHeaderComponent={<Text style={styles.sectionLabel}>Recent</Text>}
          renderItem={({ item }) => {
            const member = membersById.get(item.userId);
            const name = member?.displayName || item.user?.displayName || 'Family member';
            const hasLocation = item.latitude != null && item.longitude != null;
            const place = item.address || (hasLocation ? 'Location shared' : 'Ping sent');
            return (
              <TouchableOpacity
                style={styles.recentRow}
                onPress={() => handleFocusRecent(item)}
                disabled={!hasLocation}
                activeOpacity={0.65}
              >
                <Avatar
                  url={member?.avatarUrl}
                  emoji={member?.avatarEmoji}
                  name={name}
                  id={item.userId}
                  size={34}
                />
                <View style={styles.recentInfo}>
                  <Text style={styles.recentName} numberOfLines={1}>
                    {name}
                  </Text>
                  <View style={styles.recentPlaceRow}>
                    <View
                      style={[
                        styles.statusDot,
                        hasLocation ? styles.statusDotSage : styles.statusDotMuted,
                      ]}
                    />
                    <Text style={styles.recentPlace} numberOfLines={1}>
                      {place}
                    </Text>
                  </View>
                </View>
                <View style={styles.recentRight}>
                  <Text style={styles.recentTime}>{timeLabel(item.checkedInAt)}</Text>
                  {hasLocation && <Text style={styles.recentChevron}>›</Text>}
                </View>
              </TouchableOpacity>
            );
          }}
          ListEmptyComponent={
            <Text style={styles.emptyText}>
              No pings yet. Tap "Ping everyone" to let your family know you're safe.
            </Text>
          }
        />
      </Animated.View>

      {loading && (
        <View style={styles.loadingWrap}>
          <ActivityIndicator size="small" color={colors.gold} />
        </View>
      )}

      {/* Member picker — who to request a location from */}
      <Modal
        visible={showMemberPicker}
        transparent
        animationType="slide"
        onRequestClose={() => setShowMemberPicker(false)}
      >
        <TouchableOpacity
          style={styles.sheetOverlay}
          activeOpacity={1}
          onPress={() => setShowMemberPicker(false)}
        />
        <View
          style={[
            styles.sheetBox,
            {
              paddingBottom: insets.bottom + 12,
            },
          ]}
        >
          <View style={styles.pickHandleGrabArea}>
            <View style={styles.handle} />
          </View>
          <View style={styles.pickHeader}>
            <View style={styles.pickHeaderIcon}>
              <Text style={styles.pickHeaderIconText}>⚲</Text>
            </View>
            <View
              style={{
                flex: 1,
              }}
            >
              <Text style={styles.sheetTitle}>Request location</Text>
              <Text style={styles.pickHeaderSub}>
                Ask a family member to share where they are right now
              </Text>
            </View>
            <TouchableOpacity
              onPress={() => setShowMemberPicker(false)}
              hitSlop={{
                top: 8,
                bottom: 8,
                left: 8,
                right: 8,
              }}
              style={styles.pickCloseBtn}
            >
              <Text style={styles.pickCloseIcon}>✕</Text>
            </TouchableOpacity>
          </View>
          {members.filter((m) => m.userId !== currentUserId).length === 0 ? (
            <View style={styles.pickEmpty}>
              <View style={styles.pickEmptyIcon}>
                <Text style={styles.pickEmptyIconText}>👪</Text>
              </View>
              <Text style={styles.pickEmptyTitle}>No one else here yet</Text>
              <Text style={styles.pickEmptyText}>
                Invite family members to your household to be able to request their location.
              </Text>
            </View>
          ) : (
            <FlatList
              data={members.filter((m) => m.userId !== currentUserId)}
              keyExtractor={(item) => item.userId}
              ItemSeparatorComponent={() => <View style={styles.pickSeparator} />}
              contentContainerStyle={styles.pickList}
              renderItem={({ item }) => {
                const isRequesting = requestingPingId === item.userId;
                return (
                  <TouchableOpacity
                    style={styles.pickRow}
                    onPress={() => handleRequestPing(item)}
                    disabled={isRequesting}
                    activeOpacity={0.7}
                  >
                    <View style={styles.pickAvatar}>
                      <Avatar
                        url={item.avatarUrl}
                        emoji={item.avatarEmoji}
                        name={item.displayName}
                        id={item.userId}
                        size={40}
                      />
                    </View>
                    <View style={styles.pickInfo}>
                      <Text style={styles.pickName}>{item.displayName}</Text>
                      <View style={styles.pickRolePill}>
                        <Text style={styles.pickRoleText}>{item.role}</Text>
                      </View>
                    </View>
                    <View style={[styles.pickPingBtn, isRequesting && styles.pickPingBtnBusy]}>
                      {isRequesting ? (
                        <ActivityIndicator size="small" color={colors.goldDeep} />
                      ) : (
                        <Text style={styles.pickPingBtnText}>Ping</Text>
                      )}
                    </View>
                  </TouchableOpacity>
                );
              }}
            />
          )}
        </View>
      </Modal>

      {/* Duration picker — how long to share location before accepting */}
      <Modal
        visible={!!durationRequest}
        transparent
        animationType="slide"
        onRequestClose={() => setDurationRequest(null)}
      >
        <TouchableOpacity
          style={styles.sheetOverlay}
          activeOpacity={1}
          onPress={() => setDurationRequest(null)}
        />
        <View
          style={[
            styles.sheetBox,
            {
              paddingBottom: insets.bottom + 12,
            },
          ]}
        >
          <View style={styles.pickHandleGrabArea}>
            <View style={styles.handle} />
          </View>
          <View style={styles.pickHeader}>
            <View style={styles.pickHeaderIcon}>
              <Text style={styles.pickHeaderIconText}>⏱</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.sheetTitle}>Share for how long?</Text>
              <Text style={styles.pickHeaderSub}>
                {durationRequest?.requester?.displayName || 'They'} will see your location update
                live until this time runs out.
              </Text>
            </View>
            <TouchableOpacity
              onPress={() => setDurationRequest(null)}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              style={styles.pickCloseBtn}
            >
              <Text style={styles.pickCloseIcon}>✕</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.durationOptionsRow}>
            {SHARE_DURATION_OPTIONS.map((opt) => (
              <TouchableOpacity
                key={opt.minutes}
                style={styles.durationOption}
                activeOpacity={0.8}
                disabled={respondingPingId === durationRequest?.id}
                onPress={() => {
                  const request = durationRequest;
                  setDurationRequest(null);
                  handleRespondPing(request, 'accept', opt.minutes);
                }}
              >
                <GoldFill radius={14} disabled={respondingPingId === durationRequest?.id} />
                <Text style={styles.durationOptionText}>{opt.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      </Modal>

      {/* Saved places — add / edit / manage */}
      <Modal
        visible={showPlaceSheet}
        transparent
        animationType="slide"
        onRequestClose={() => setShowPlaceSheet(false)}
        statusBarTranslucent
        navigationBarTranslucent
      >
        <KeyboardAvoider>
        <TouchableOpacity
          style={styles.sheetOverlay}
          activeOpacity={1}
          onPress={() => setShowPlaceSheet(false)}
        />
        <View
          style={[
            styles.placeSheetBox,
            {
              paddingBottom: insets.bottom + 12,
            },
          ]}
        >
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>{editingPlaceId ? 'Edit place' : 'Save a place'}</Text>
            <TouchableOpacity
              onPress={() => setShowPlaceSheet(false)}
              hitSlop={{
                top: 8,
                bottom: 8,
                left: 8,
                right: 8,
              }}
            >
              <Text style={styles.sheetClose}>Close</Text>
            </TouchableOpacity>
          </View>

          <ScrollView contentContainerStyle={styles.placeForm} keyboardShouldPersistTaps="handled">
            <View style={styles.miniMap}>
              {placeCoords ? (
                <MapLibreMap
                  style={StyleSheet.absoluteFill}
                  mapStyle={DARK_MAP_STYLE}
                  compass={false}
                  logo={false}
                  attribution={false}
                  dragPan={false}
                  touchZoom={false}
                  touchRotate={false}
                  touchPitch={false}
                  doubleTapZoom={false}
                  doubleTapHoldZoom={false}
                >
                  <Camera center={[placeCoords.longitude, placeCoords.latitude]} zoom={15} />
                  <Marker lngLat={[placeCoords.longitude, placeCoords.latitude]}>
                    <View style={styles.nativeSelfPin} />
                  </Marker>
                </MapLibreMap>
              ) : (
                <View style={styles.miniMapEmpty}>
                  <Text style={styles.miniMapEmptyText}>No location set yet</Text>
                </View>
              )}
            </View>
            <TouchableOpacity
              style={styles.useCurrentBtn}
              onPress={handleUseCurrentLocationForPlace}
              disabled={locatingPlace}
              activeOpacity={0.8}
            >
              {locatingPlace ? (
                <ActivityIndicator size="small" color={colors.goldDeep} />
              ) : (
                <Text style={styles.useCurrentText}>◎ Use my current location</Text>
              )}
            </TouchableOpacity>

            <View>
              <Text style={styles.fieldLabel}>Name</Text>
              <TextInput
                style={styles.fakeInput}
                placeholder="e.g. Home, Office, School"
                placeholderTextColor={colors.textMuted}
                value={placeName}
                onChangeText={setPlaceName}
                maxLength={100}
              />
            </View>

            <View>
              <Text style={styles.fieldLabel}>Icon</Text>
              <View style={styles.iconPicker}>
                {PLACE_ICON_OPTIONS.map((opt) => (
                  <TouchableOpacity
                    key={opt}
                    style={[styles.iconOpt, placeIcon === opt && styles.iconOptSelected]}
                    onPress={() => setPlaceIcon(opt)}
                    activeOpacity={0.8}
                  >
                    <Text
                      style={[styles.iconOptText, placeIcon === opt && styles.iconOptTextSelected]}
                    >
                      {PLACE_ICON_EMOJI[opt]}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            <TouchableOpacity
              style={[
                styles.saveBtn,
                (!placeName.trim() || !placeCoords || savingPlace) && styles.saveBtnDisabled,
              ]}
              onPress={handleSavePlace}
              disabled={!placeName.trim() || !placeCoords || savingPlace}
              activeOpacity={0.85}
            >
              <GoldFill radius={radius.card} disabled={!placeName.trim() || !placeCoords || savingPlace} />
              {savingPlace ? (
                <ActivityIndicator size="small" color={colors.onAccent} />
              ) : (
                <Text style={styles.saveBtnText}>
                  {editingPlaceId ? 'Update place' : 'Save place'}
                </Text>
              )}
            </TouchableOpacity>

            {places.length > 0 && (
              <View style={styles.savedList}>
                <Text style={styles.fieldLabel}>Your places</Text>
                {places.map((place) => (
                  <View key={place.id} style={styles.savedRow}>
                    <View style={styles.savedIcon}>
                      <Text style={styles.savedIconText}>{PLACE_ICON_EMOJI[place.icon]}</Text>
                    </View>
                    <View style={styles.savedInfo}>
                      <Text style={styles.savedName}>{place.name}</Text>
                      {!!place.address && (
                        <Text style={styles.savedAddr} numberOfLines={1}>
                          {place.address}
                        </Text>
                      )}
                    </View>
                    <TouchableOpacity
                      onPress={() => openEditPlace(place)}
                      hitSlop={{
                        top: 8,
                        bottom: 8,
                        left: 8,
                        right: 8,
                      }}
                    >
                      <Text style={styles.savedAction}>Edit</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => handleDeletePlace(place)}
                      hitSlop={{
                        top: 8,
                        bottom: 8,
                        left: 8,
                        right: 8,
                      }}
                    >
                      {deletingPlaceId === place.id ? (
                        <ActivityIndicator size="small" color={colors.danger} />
                      ) : (
                        <Text style={[styles.savedAction, styles.savedActionDanger]}>Delete</Text>
                      )}
                    </TouchableOpacity>
                  </View>
                ))}
              </View>
            )}
          </ScrollView>
        </View>
        </KeyboardAvoider>
      </Modal>
    </View>
  );
}

/** Smart time label: today → "7:58am"; else date. Matches mock "7:58am". */
function timeLabel(iso) {
  const d = new Date(iso);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return d
      .toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
      })
      .toLowerCase();
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday =
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate();
  if (isYesterday) return 'Yesterday';
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}
const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.canvas,
  },
  dataRoot: {
    flex: 1,
    backgroundColor: colors.canvas,
  },
  // Header (back + centered title + add, one row, clear of the status bar)
  header: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  backBtn: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backIcon: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.ink,
    lineHeight: 20,
  },
  headerTitleWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    fontFamily: fonts.displayBold,
    fontSize: 17,
    lineHeight: 22,
    color: colors.ink,
  },
  headerSpacer: {
    flex: 1,
    alignItems: 'flex-end',
  },
  addBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  addBtnText: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.ink,
    lineHeight: 20,
  },
  // Map
  map: {
    flex: 1,
    backgroundColor: colors.borderCool,
  },
  // Native map markers (rendered as real RN views via <Marker>, not HTML)
  nativeSelfPin: {
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: colors.gold,
    borderWidth: 3,
    borderColor: colors.surface,
    shadowColor: colors.black,
    shadowOffset: {
      width: 0,
      height: 1,
    },
    shadowOpacity: 0.4,
    shadowRadius: 4,
    elevation: 3,
  },
  nativeMyLocationPin: {
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: colors.info,
    borderWidth: 3,
    borderColor: colors.surface,
    shadowColor: colors.black,
    shadowOffset: {
      width: 0,
      height: 1,
    },
    shadowOpacity: 0.4,
    shadowRadius: 4,
    elevation: 3,
  },
  nativePlacePinWrap: {
    alignItems: 'center',
    gap: 3,
  },
  nativePlacePinCircle: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.gold,
    borderWidth: 2.5,
    borderColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: colors.black,
    shadowOffset: {
      width: 0,
      height: 3,
    },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 4,
  },
  nativePlacePinEmoji: {
    fontSize: 14,
  },
  nativePlacePinLabel: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 9,
    fontWeight: '600',
    color: colors.ink,
    backgroundColor: withAlpha(colors.white, 0.9),
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 5,
  },
  nativeMemberPin: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: colors.goldPale,
    borderWidth: 2.5,
    borderColor: colors.success,
    alignItems: 'center',
    justifyContent: 'center',
  },
  nativeFocusPinWrap: {
    alignItems: 'center',
    gap: 4,
  },
  nativeFocusLabel: {
    backgroundColor: colors.surfaceRaised,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 8,
    shadowColor: colors.black,
    shadowOffset: {
      width: 0,
      height: 3,
    },
    shadowOpacity: 0.3,
    shadowRadius: 10,
    elevation: 5,
  },
  nativeFocusLabelText: {
    fontFamily: fonts.bodySemiBold,
    color: colors.onAccent,
    fontWeight: '600',
    fontSize: 12,
  },
  nativeFocusPinShape: {
    width: 34,
    height: 34,
    borderTopLeftRadius: 17,
    borderTopRightRadius: 17,
    borderBottomRightRadius: 17,
    borderBottomLeftRadius: 0,
    transform: [
      {
        rotate: '-45deg',
      },
    ],
    backgroundColor: colors.surfaceRaised,
    borderWidth: 2.5,
    borderColor: colors.surface,
    shadowColor: colors.black,
    shadowOffset: {
      width: 0,
      height: 4,
    },
    shadowOpacity: 0.35,
    shadowRadius: 10,
    elevation: 5,
  },
  locateBtn: {
    position: 'absolute',
    right: 14,
    bottom: TRAY_COLLAPSED_HEIGHT + 14,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: colors.shadow,
    shadowOffset: {
      width: 0,
      height: 3,
    },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 4,
  },
  locateBtnText: {
    fontSize: 16,
    color: colors.ink,
  },
  // Incoming ping banners — overlaid on the map
  pingBannerList: {
    position: 'absolute',
    left: 12,
    right: 12,
    top: 12,
    gap: 10,
  },
  pingBanner: {
    // Opaque, not the translucent-glass pattern used elsewhere — this card
    // floats over the map's light basemap rather than the app's dark canvas,
    // so a translucent gold tint with light `ink` text was nearly invisible.
    backgroundColor: colors.canvasSoft,
    borderRadius: radius.card,
    borderWidth: 1.5,
    borderColor: colors.gold,
    padding: 14,
    shadowColor: colors.shadow,
    shadowOffset: {
      width: 0,
      height: 8,
    },
    shadowOpacity: 0.25,
    shadowRadius: 16,
    elevation: 6,
  },
  pingBannerText: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 14,
    color: colors.ink,
    marginBottom: 10,
  },
  pingBannerActions: {
    flexDirection: 'row',
    gap: 10,
  },
  pingDeclineBtn: {
    flex: 1,
    height: 40,
    borderRadius: 12,
    backgroundColor: colors.surface,
    borderWidth: 1.5,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pingDeclineText: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 13,
    color: colors.ink,
  },
  pingAcceptBtn: {
    flex: 1,
    height: 40,
    borderRadius: 12,
    backgroundColor: colors.gold,
    alignItems: 'center',
    justifyContent: 'center',
    ...goldButton.glow,
  },
  pingAcceptText: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 13,
    color: colors.onAccent,
  },
  // Live-share status — this device is currently broadcasting its location
  shareStatusCard: {
    position: 'absolute',
    left: 12,
    right: 12,
    top: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.canvasSoft,
    borderRadius: radius.card,
    borderWidth: 1.5,
    borderColor: colors.gold,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  shareStatusText: {
    flex: 1,
    fontFamily: fonts.bodySemiBold,
    fontSize: 13,
    color: colors.ink,
    marginRight: 10,
  },
  shareStatusStop: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 13,
    color: colors.dangerOnDark,
  },
  // Duration picker — options row inside the sheet
  durationOptionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    paddingHorizontal: 20,
    paddingBottom: 20,
  },
  durationOption: {
    flexGrow: 1,
    minWidth: '45%',
    height: 48,
    borderRadius: 14,
    backgroundColor: colors.gold,
    alignItems: 'center',
    justifyContent: 'center',
    shadowOpacity: 0,
    shadowRadius: 0,
    elevation: 0,
  },
  durationOptionText: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 14,
    color: colors.onAccent,
  },
  // Route-to-shared-location card — distance + "Open in Maps"
  routeCard: {
    position: 'absolute',
    left: 12,
    right: 66,
    bottom: TRAY_COLLAPSED_HEIGHT + 14,
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 12,
    gap: 8,
    shadowColor: colors.shadow,
    shadowOffset: {
      width: 0,
      height: 4,
    },
    shadowOpacity: 0.18,
    shadowRadius: 12,
    elevation: 6,
  },
  routeCardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  routeCardText: {
    flex: 1,
    fontFamily: fonts.bodySemiBold,
    fontSize: 13,
    color: colors.ink,
  },
  routeCardClose: {
    fontSize: 13,
    color: colors.textMuted,
  },
  routeCardDirectionsBtn: {
    height: 36,
    borderRadius: 10,
    backgroundColor: colors.info,
    alignItems: 'center',
    justifyContent: 'center',
  },
  routeCardDirectionsText: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 13,
    color: colors.onAccent,
  },
  // Bottom tray — fixed-height absolute overlay, slid up/down via transform
  tray: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.canvasElevated,
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    // borderWidth: 1,
    // borderColor: colors.border,
    // borderBottomWidth: 0,
    paddingHorizontal: 20,
    paddingTop: 10,
    gap: 14,
    shadowColor: colors.shadow,
    shadowOffset: {
      width: 0,
      height: -8,
    },
    shadowOpacity: 0.1,
    shadowRadius: 20,
    elevation: 10,
  },
  handleGrabArea: {
    height: 32,
    marginTop: -6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 10,
  },
  actionCard: {
    flex: 1,
    borderRadius: 16,
    padding: 14,
    gap: 3,
    minHeight: 84,
  },
  actionPrimary: {
    // Same glass surface as the secondary tile — matches the rest of the
    // app's navy/glass theme. Primary emphasis comes from the gold accent
    // on the icon/title, not a solid fill block.
    backgroundColor: colors.surface,
    // borderWidth: 1.5,
    // borderColor: colors.border,
  },
  actionSecondary: {
    backgroundColor: colors.surface,
    borderWidth: 1.5,
    borderColor: colors.border,
  },
  actionIconPrimary: {
    fontSize: 18,
    color: colors.gold,
    marginBottom: 2,
  },
  actionIconSecondary: {
    fontSize: 18,
    color: colors.ink,
    marginBottom: 2,
  },
  actionTitlePrimary: {
    fontFamily: fonts.displayBold,
    fontSize: 14,
    color: colors.ink,
  },
  actionTitleSecondary: {
    fontFamily: fonts.displayBold,
    fontSize: 14,
    color: colors.ink,
  },
  actionSubPrimary: {
    fontFamily: fonts.body,
    fontSize: 11,
    lineHeight: 15,
    color: colors.textSecondary,
  },
  actionSubSecondary: {
    fontFamily: fonts.body,
    fontSize: 11,
    lineHeight: 15,
    color: colors.textSecondary,
  },
  sectionLabel: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.4,
    color: colors.textMuted,
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  placesRail: {
    gap: 8,
    paddingRight: 8,
  },
  placeChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    backgroundColor: colors.canvasElevated,
    borderRadius: 20,
    paddingVertical: 6,
    paddingHorizontal: 12,
    paddingLeft: 6,
  },
  placeChipDot: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: colors.gold,
    alignItems: 'center',
    justifyContent: 'center',
  },
  placeChipDotText: {
    fontSize: 11,
    color: colors.onAccent,
  },
  placeChipName: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 13,
    color: colors.ink,
  },
  placeChipAdd: {
    backgroundColor: 'transparent',
    borderWidth: 1.4,
    borderColor: colors.border,
    borderStyle: 'dashed',
    borderRadius: 20,
    paddingVertical: 7,
    paddingHorizontal: 14,
    justifyContent: 'center',
  },
  placeChipAddText: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 13,
    color: colors.textSecondary,
  },
  recentList: {
    flex: 1,
  },
  recentSeparator: {
    height: 1,
    backgroundColor: colors.border,
    marginLeft: 34 + 10,
  },
  recentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 9,
  },
  recentInfo: {
    flex: 1,
    gap: 3,
  },
  recentName: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 13.5,
    color: colors.ink,
  },
  recentPlaceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  statusDotSage: {
    backgroundColor: colors.success,
  },
  statusDotMuted: {
    backgroundColor: colors.surfaceRaised,
  },
  recentPlace: {
    flex: 1,
    fontFamily: fonts.body,
    fontSize: 12,
    color: colors.textSecondary,
  },
  recentRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  recentTime: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.textMuted,
  },
  recentChevron: {
    fontSize: 18,
    color: colors.textMuted,
    fontWeight: '700',
    marginTop: -2,
  },
  emptyText: {
    fontFamily: fonts.body,
    fontSize: 13,
    color: colors.textMuted,
    lineHeight: 19,
    paddingVertical: 8,
  },
  loadingWrap: {
    position: 'absolute',
    alignSelf: 'center',
    top: '48%',
  },
  // Screen 33 — Success
  container: {
    flex: 1,
  },
  successCircle: {
    width: 140,
    height: 140,
    borderRadius: 9999,
    backgroundColor: colors.successDeep,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
    marginBottom: 28,
    shadowColor: colors.successDeep,
    shadowOffset: {
      width: 0,
      height: 12,
    },
    shadowOpacity: 0.35,
    shadowRadius: 32,
    elevation: 6,
  },
  successCheck: {
    fontFamily: fonts.displayBold,
    fontSize: 72,
    color: colors.onAccent,
  },
  successWrap: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 32,
    paddingBottom: 60,
  },
  successTitle: {
    fontFamily: fonts.displayBold,
    fontSize: 17,
    lineHeight: 22,
    color: colors.ink,
    marginBottom: 12,
  },
  successSub: {
    fontFamily: fonts.body,
    fontSize: 14,
    lineHeight: 21,
    color: colors.textSecondary,
    textAlign: 'center',
  },
  doneBtn: {
    marginTop: 32,
    paddingHorizontal: 28,
    paddingVertical: 12,
    borderRadius: 9999,
    backgroundColor: colors.canvasElevated,
  },
  doneBtnText: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 14,
    color: colors.ink,
  },
  // Member picker sheet
  sheetOverlay: {
    flex: 1,
    backgroundColor: withAlpha(colors.shadow, 0.55),
  },
  sheetBox: {
    backgroundColor: colors.canvasElevated,
    borderTopLeftRadius: 32,
    borderTopRightRadius: 32,
    borderWidth: 1,
    borderColor: colors.border,
    borderBottomWidth: 0,
    paddingTop: 6,
    maxHeight: '75%',
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 24,
    paddingVertical: 14,
  },
  sheetClose: {
    fontSize: 15,
    fontWeight: '500',
    fontFamily: fonts.bodyMedium,
    color: colors.goldDeep,
    minWidth: 44,
  },
  sheetTitle: {
    fontSize: 16,
    fontWeight: '600',
    fontFamily: fonts.displayBold,
    color: colors.ink,
  },
  pickHandleGrabArea: {
    paddingTop: 8,
    paddingBottom: 4,
    alignItems: 'center',
  },
  pickHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    paddingHorizontal: 24,
    paddingTop: 10,
    paddingBottom: 16,
  },
  pickHeaderIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: colors.goldTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pickHeaderIconText: {
    fontSize: 16,
    color: colors.goldDeep,
  },
  pickHeaderSub: {
    fontFamily: fonts.body,
    fontSize: 12.5,
    lineHeight: 17,
    color: colors.textSecondary,
    marginTop: 3,
  },
  pickCloseBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.canvasElevated,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pickCloseIcon: {
    fontSize: 12,
    color: colors.textSecondary,
  },
  pickList: {
    paddingBottom: 8,
  },
  pickSeparator: {
    height: 1,
    backgroundColor: colors.border,
    marginLeft: 24 + 44 + 12,
  },
  pickEmpty: {
    padding: 40,
    alignItems: 'center',
  },
  pickEmptyIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.canvasElevated,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
  },
  pickEmptyIconText: {
    fontSize: 24,
  },
  pickEmptyTitle: {
    fontFamily: fonts.displayBold,
    fontSize: 15,
    color: colors.ink,
    marginBottom: 6,
  },
  pickEmptyText: {
    fontFamily: fonts.body,
    fontSize: 13,
    lineHeight: 19,
    color: colors.textSecondary,
    textAlign: 'center',
  },
  pickRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 24,
    gap: 12,
  },
  pickAvatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.goldTint,
    borderWidth: 1.5,
    borderColor: colors.gold,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pickInfo: {
    flex: 1,
    gap: 4,
  },
  pickName: {
    fontSize: 15,
    fontWeight: '600',
    fontFamily: fonts.bodySemiBold,
    color: colors.ink,
  },
  pickRolePill: {
    alignSelf: 'flex-start',
    backgroundColor: colors.canvasElevated,
    borderRadius: 8,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  pickRoleText: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 10.5,
    fontWeight: '600',
    color: colors.textSecondary,
    textTransform: 'capitalize',
  },
  pickPingBtn: {
    minWidth: 60,
    height: 32,
    borderRadius: 16,
    paddingHorizontal: 14,
    backgroundColor: colors.goldTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pickPingBtnBusy: {
    paddingHorizontal: 10,
  },
  pickPingBtnText: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 12.5,
    color: colors.goldDeep,
  },
  // Add/manage place sheet
  placeSheetBox: {
    backgroundColor: colors.canvasElevated,
    borderTopLeftRadius: 32,
    borderTopRightRadius: 32,
    borderWidth: 1,
    borderColor: colors.border,
    borderBottomWidth: 0,
    paddingTop: 6,
    maxHeight: '86%',
  },
  placeForm: {
    paddingHorizontal: 24,
    paddingBottom: 16,
    gap: 16,
  },
  miniMap: {
    height: 190,
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: colors.borderCool,
  },
  miniMapEmpty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  miniMapEmptyText: {
    fontFamily: fonts.body,
    fontSize: 12,
    color: colors.textMuted,
  },
  useCurrentBtn: {
    alignSelf: 'flex-start',
  },
  useCurrentText: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 13,
    color: colors.goldDeep,
  },
  fieldLabel: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 11,
    fontWeight: '600',
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
    marginBottom: 8,
  },
  fakeInput: {
    height: 46,
    borderRadius: radius.card,
    backgroundColor: colors.canvasElevated,
    borderWidth: 1.4,
    borderColor: colors.border,
    paddingHorizontal: 14,
    fontSize: 14,
    fontFamily: fonts.body,
    color: colors.ink,
  },
  iconPicker: {
    flexDirection: 'row',
    gap: 10,
  },
  iconOpt: {
    width: 46,
    height: 46,
    borderRadius: 23,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.4,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  iconOptSelected: {
    backgroundColor: colors.gold,
    borderColor: colors.gold,
  },
  iconOptText: {
    fontSize: 18,
    color: colors.textSecondary,
  },
  iconOptTextSelected: {
    color: colors.onAccent,
  },
  saveBtn: {
    height: 48,
    borderRadius: radius.card,
    backgroundColor: colors.gold,
    alignItems: 'center',
    justifyContent: 'center',
    ...goldButton.glow,
  },
  saveBtnDisabled: {
    opacity: 0.5,
  },
  saveBtnText: {
    fontFamily: fonts.displayBold,
    fontSize: 14,
    color: colors.onAccent,
  },
  savedList: {
    gap: 2,
  },
  savedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  savedIcon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.goldTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  savedIconText: {
    fontSize: 14,
    color: colors.goldDeep,
  },
  savedInfo: {
    flex: 1,
  },
  savedName: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 13,
    color: colors.ink,
  },
  savedAddr: {
    fontFamily: fonts.body,
    fontSize: 11,
    color: colors.textMuted,
    marginTop: 1,
  },
  savedAction: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 12,
    color: colors.goldDeep,
    marginLeft: 8,
  },
  savedActionDanger: {
    color: colors.danger,
  },
});
