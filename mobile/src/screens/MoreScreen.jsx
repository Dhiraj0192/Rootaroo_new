import React, { useEffect, useMemo, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  StatusBar,
  Image,
} from 'react-native';
import { showAlert } from '../shared/services/themedAlert';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuthStore } from '../shared/store/authStore';
import apiClient from '../shared/api/client';
import { colors, fonts } from '../shared/theme';
import { useTabBarDockHeight } from '../shared/hooks/useTabBarDockHeight';
import { SpotlightTourProvider, AttachStep } from 'react-native-spotlight-tour';
import TourTooltip from '../shared/components/TourTooltip';
import { scrollToStep } from '../shared/utils/scrollToStep';

// Order here is the tour's step order — index into this array is the
// AttachStep index for that row, matched by its menu label.
const TOUR_ROWS = [
  { label: 'Document vault', title: 'Document Vault', body: 'Store family documents and photos, encrypted and private.' },
  { label: 'Ping', title: 'Ping', body: 'Check in or ask where everyone is with one tap.' },
  { label: 'Grocery List', title: 'Grocery List', body: 'Keep a shared shopping list the whole household can add to.' },
  { label: 'Bills & Splits', title: 'Bills & Splits', body: 'Track shared expenses and split costs fairly.' },
  { label: 'Calendar', title: 'Calendar', body: 'See upcoming family events in one place.' },
];
function getInitials(name) {
  return name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}
function getServerBase() {
  const base = apiClient.defaults.baseURL || '';
  return base.replace(/\/api\/v1\/?$/, '');
}
export default function MoreScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const dockHeight = useTabBarDockHeight();
  const user = useAuthStore((s) => s.user);
  const showMoreTour = useAuthStore((s) => s.showMoreTour);
  const dismissMoreTour = useAuthStore((s) => s.dismissMoreTour);
  const scrollRef = useRef(null);
  const scrollOffsetY = useRef(0);
  const tourRef = useRef(null);
  const rowRefs = useRef({});
  const getRowRef = (label) => {
    if (!rowRefs.current[label]) rowRefs.current[label] = React.createRef();
    return rowRefs.current[label];
  };
  const tourSteps = useMemo(() => {
    return TOUR_ROWS.map(({ label, title, body }) => ({
      before: () => scrollToStep(scrollRef, scrollOffsetY, getRowRef(label)),
      render: (props) => <TourTooltip {...props} title={title} body={body} total={TOUR_ROWS.length} />,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!showMoreTour) return;
    let cancelled = false;
    const tryStart = () => {
      if (cancelled) return;
      if (tourRef.current) {
        tourRef.current.start();
        dismissMoreTour();
      } else {
        requestAnimationFrame(tryStart);
      }
    };
    tryStart();
    return () => {
      cancelled = true;
    };
  }, [showMoreTour, dismissMoreTour]);
  const displayName = user?.name || user?.email || 'You';
  const initials = getInitials(displayName);
  const email = user?.email || '';
  const avatarSrc = user?.avatarUrl
    ? {
        uri: user.avatarUrl.startsWith('http')
          ? user.avatarUrl
          : `${getServerBase()}${user.avatarUrl}`,
      }
    : null;
  const handleLogout = () => {
    showAlert('Logout', 'Are you sure you want to logout?', [
      {
        text: 'Cancel',
        style: 'cancel',
      },
      {
        text: 'Logout',
        style: 'destructive',
        onPress: () => useAuthStore.getState().logout(),
      },
    ]);
  };
  const go = (screen) => () => navigation.navigate(screen);
  const sections = [
    {
      title: 'Household',
      rows: [
        {
          label: 'Household settings',
          onPress: go('HouseholdSettings'),
        },
        {
          label: 'Subscription',
          onPress: go('Subscription'),
        },
        {
          label: 'Notification preferences',
          onPress: go('NotificationPreferences'),
        },
        {
          label: 'Document vault',
          onPress: go('Vault'),
        },
      ],
    },
    {
      title: 'Features',
      rows: [
        {
          label: 'Journal',
          onPress: go('Journal'),
        },
        {
          label: 'Ping',
          onPress: go('CheckIn'),
        },
        {
          label: 'Grocery List',
          onPress: go('GroceryList'),
        },
        {
          label: 'To-do List',
          onPress: go('TodoList'),
        },
        {
          label: 'Bills & Splits',
          onPress: go('ExpenseList'),
        },
        {
          label: 'Calendar',
          onPress: go('Calendar'),
        },
      ],
    },
    {
      title: 'Support',
      rows: [
        {
          label: 'Help center',
          onPress: go('HelpCenter'),
        },
        {
          label: 'Privacy policy',
          onPress: go('PrivacyPolicy'),
        },
      ],
    },
  ];
  return (
    <SpotlightTourProvider
      ref={tourRef}
      steps={tourSteps}
      shape="rectangle"
      motion="slide"
      overlayColor={colors.shadow}
      overlayOpacity={0.82}
    >
    <View
      style={[
        styles.root,
        {
          paddingTop: insets.top,
        },
      ]}
    >
      <StatusBar barStyle="light-content" backgroundColor={colors.canvas} />

      <ScrollView
        ref={scrollRef}
        onScroll={(e) => { scrollOffsetY.current = e.nativeEvent.contentOffset.y; }}
        scrollEventThrottle={16}
        style={styles.scroll}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[
          styles.scrollContent,
          {
            paddingBottom: dockHeight + 16,
          },
        ]}
      >
        {/* ── Profile row (SCREEN 39) ── */}
        <TouchableOpacity
          style={styles.profileRow}
          onPress={() => navigation.navigate('EditProfile')}
          activeOpacity={0.7}
        >
          {avatarSrc ? (
            <Image source={avatarSrc} style={styles.avatarImage} />
          ) : (
            <View style={styles.avatarCircle}>
              <Text style={styles.avatarInitials}>{initials}</Text>
            </View>
          )}

          <View style={styles.profileInfo}>
            <Text style={styles.profileName} numberOfLines={1}>
              {displayName}
            </Text>
            <Text style={styles.profileEmail} numberOfLines={1}>
              {email}
            </Text>
          </View>

          <Text style={styles.editLink}>Edit</Text>
        </TouchableOpacity>

        {/* ── Menu sections ── */}
        {sections.map((section, si) => (
          <View key={section.title}>
            <Text style={[styles.sectionLabel, si > 0 && styles.sectionLabelSpaced]}>
              {section.title}
            </Text>
            {section.rows.map((row) => {
              const tourIndex = TOUR_ROWS.findIndex((t) => t.label === row.label);
              if (tourIndex === -1) {
                return (
                  <TouchableOpacity
                    key={row.label}
                    style={styles.menuRow}
                    onPress={row.onPress}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.menuRowLabel}>{row.label}</Text>
                    <Text style={styles.menuRowChevron}>›</Text>
                  </TouchableOpacity>
                );
              }
              return (
                <AttachStep key={row.label} index={tourIndex} fill>
                  <TouchableOpacity
                    ref={getRowRef(row.label)}
                    style={styles.menuRow}
                    onPress={row.onPress}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.menuRowLabel}>{row.label}</Text>
                    <Text style={styles.menuRowChevron}>›</Text>
                  </TouchableOpacity>
                </AttachStep>
              );
            })}
          </View>
        ))}

        {/* ── Sign out (SCREEN 39) ── */}
        <TouchableOpacity style={styles.signOut} onPress={handleLogout} activeOpacity={0.7}>
          <Text style={styles.signOutText}>Sign out</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
    </SpotlightTourProvider>
  );
}
const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.canvas,
    paddingHorizontal: 8,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 24,
    paddingTop: 16,
  },
  // Profile row (SCREEN 39)
  profileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    marginBottom: 32,
  },
  avatarCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.borderCool,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarImage: {
    width: 56,
    height: 56,
    borderRadius: 28,
  },
  avatarInitials: {
    fontSize: 18,
    fontWeight: '600',
    fontFamily: fonts.bodySemiBold,
    color: colors.inkMuted,
  },
  profileInfo: {
    flex: 1,
  },
  profileName: {
    fontSize: 17,
    lineHeight: 22,
    fontWeight: '700',
    fontFamily: fonts.displayBold,
    color: colors.ink,
  },
  profileEmail: {
    fontSize: 13,
    fontFamily: fonts.body,
    color: colors.textMuted,
    marginTop: 2,
  },
  editLink: {
    fontSize: 13,
    fontWeight: '500',
    fontFamily: fonts.bodyMedium,
    color: colors.goldDeep,
  },
  // Sections (SCREEN 39)
  sectionLabel: {
    fontSize: 11,
    fontWeight: '600',
    fontFamily: fonts.bodySemiBold,
    letterSpacing: 0.4,
    color: colors.textMuted,
    marginBottom: 10,
  },
  sectionLabelSpaced: {
    marginTop: 26,
  },
  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  menuRowLabel: {
    fontSize: 14,
    fontFamily: fonts.body,
    color: colors.ink,
  },
  menuRowChevron: {
    fontSize: 18,
    color: colors.textMuted,
  },
  // Sign out (SCREEN 39)
  signOut: {
    paddingVertical: 18,
    marginTop: 4,
  },
  signOutText: {
    fontSize: 14,
    fontFamily: fonts.body,
    color: colors.danger,
  },
});
