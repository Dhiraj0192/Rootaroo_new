import React, { useEffect, useState } from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { getFocusedRouteNameFromRoute } from '@react-navigation/native';
import { ActivityIndicator, Platform, View, TouchableOpacity, Text, StyleSheet } from 'react-native';
import { BlurView } from 'expo-blur';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as NavigationBar from 'expo-navigation-bar';
import { Ionicons } from '@expo/vector-icons';
import { useAuthStore } from '../shared/store/authStore';
import { useBillingStore, selectGate } from '../shared/store/billingStore';
import { useBillingLifecycle } from '../shared/hooks/useBillingLifecycle';
import { chooseRootView } from '../shared/billing/gate';
import PaywallScreen from '../screens/billing/PaywallScreen';
import PaywallMemberScreen from '../screens/billing/PaywallMemberScreen';
import SubscriptionScreen from '../screens/billing/SubscriptionScreen';
import GraceBanner from '../screens/billing/components/GraceBanner';
import { connectSocket, disconnectSocket } from '../shared/socket';
import { registerForPushNotificationsAsync } from '../shared/pushNotifications';
import SplashScreen from '../screens/SplashScreen';
import WelcomeScreen from '../screens/WelcomeScreen';
import ChooseMethodScreen from '../screens/ChooseMethodScreen';
import SignUpScreen from '../screens/SignUpScreen';
import SignInScreen from '../screens/SignInScreen';
import HouseholdSetupScreen from '../screens/HouseholdSetupScreen';
import InviteMembersScreen from '../screens/InviteMembersScreen';
import FeatureIntroScreen from '../screens/onboarding/FeatureIntroScreen';
import FeatureDayScreen from '../screens/onboarding/FeatureDayScreen';
import FeaturePrivacyScreen from '../screens/onboarding/FeaturePrivacyScreen';
import FeaturePricingScreen from '../screens/onboarding/FeaturePricingScreen';
import ForgotPasswordScreen from '../screens/ForgotPasswordScreen';
import EmailVerificationScreen from '../screens/EmailVerificationScreen';
import PhoneSignUpScreen from '../screens/PhoneSignUpScreen';
import PhoneVerificationScreen from '../screens/PhoneVerificationScreen';
import SignupStepNameScreen from '../screens/SignupStepNameScreen';
import SignupStepBirthdayScreen from '../screens/SignupStepBirthdayScreen';
import SignupStepPhoneScreen from '../screens/SignupStepPhoneScreen';
import SignupStepAddressScreen from '../screens/SignupStepAddressScreen';
import SignupStepAvatarScreen from '../screens/SignupStepAvatarScreen';
import AccountDeletionScreen from '../screens/AccountDeletionScreen';
import PostDetailScreen from '../screens/PostDetailScreen';
import HouseholdSettingsScreen from '../screens/HouseholdSettingsScreen';
import EditProfileScreen from '../screens/EditProfileScreen';
import PrivacyPolicyScreen from '../screens/PrivacyPolicyScreen';
import HelpCenterScreen from '../screens/HelpCenterScreen';
import CalendarScreen from '../screens/CalendarScreen';
import CheckInScreen from '../screens/CheckInScreen';
import CreateEventScreen from '../screens/CreateEventScreen';
import MoreScreen from '../screens/MoreScreen';
import CreatePostScreen from '../screens/CreatePostScreen';
import DashboardScreen from '../screens/DashboardScreen';
import FeedScreen from '../screens/FeedScreen';
import JournalScreen from '../screens/JournalScreen';
import JournalEntryEditorScreen from '../screens/JournalEntryEditorScreen';
import JournalEntryDetailScreen from '../screens/JournalEntryDetailScreen';
import JournalHistoryScreen from '../screens/JournalHistoryScreen';
import CommentsScreen from '../screens/CommentsScreen';
import PhotoGalleryScreen from '../screens/PhotoGalleryScreen';

import TaskListScreen from '../screens/TaskListScreen';
import TaskDetailScreen from '../screens/TaskDetailScreen';
import CreateTaskScreen from '../screens/CreateTaskScreen';

import GroceryListScreen from '../screens/GroceryListScreen';
import TodoListScreen from '../screens/TodoListScreen';
import NotificationScreen from '../screens/NotificationScreen';
import NotificationPreferencesScreen from '../screens/NotificationPreferencesScreen';
import ExpenseListScreen from '../screens/ExpenseListScreen';
import ExpenseDetailScreen from '../screens/ExpenseDetailScreen';
import ExpenseLedgerScreen from '../screens/ExpenseLedgerScreen';
import ExpenseSettlementScreen from '../screens/ExpenseSettlementScreen';
import CreateExpenseScreen from '../screens/CreateExpenseScreen';
import MemberBalanceDetailScreen from '../screens/MemberBalanceDetailScreen';

import VaultUploadScreen from '../screens/VaultUploadScreen';
import VaultSetupScreen from '../screens/VaultSetupScreen';
import VaultViewerScreen from '../screens/VaultViewerScreen';
import VaultListScreen from '../screens/VaultListScreen';
import ChatScreen from '../screens/ChatScreen';
import GroupMembersScreen from '../screens/GroupMembersScreen';
import ConversationsScreen from '../screens/ConversationsScreen';
import { colors, withAlpha } from '../shared/theme';

const RootStack = createNativeStackNavigator();
const AuthStack = createNativeStackNavigator();
const MainTab = createBottomTabNavigator();
const TasksNav = createNativeStackNavigator();
const ChatNav = createNativeStackNavigator();
const MoreNav = createNativeStackNavigator();
const PaywallStack = createNativeStackNavigator();

/* Vault screens are a fully immersive dark experience — no floating tab dock. */
const VAULT_ROUTES = ['Vault', 'VaultUpload', 'VaultSetup', 'VaultViewer'];
// Writing and reading one entry are full-screen tasks — the dock would only
// compete with the composer's own footer and the detail screen's actions.
const JOURNAL_FULLSCREEN_ROUTES = ['JournalEditor', 'JournalEntry'];


function AuthNavigator() {
  return (
    <AuthStack.Navigator
      initialRouteName="Welcome"
      screenOptions={{ headerShown: false }}
    >
      <AuthStack.Screen name="Welcome" component={WelcomeScreen} />
      <AuthStack.Screen name="ChooseMethod" component={ChooseMethodScreen} />
      <AuthStack.Screen name="SignUp" component={SignUpScreen} />
      <AuthStack.Screen name="SignIn" component={SignInScreen} />
      <AuthStack.Screen name="PhoneSignUp" component={PhoneSignUpScreen} />
      <AuthStack.Screen name="PhoneVerification" component={PhoneVerificationScreen} />
      <AuthStack.Screen name="SignupStepName" component={SignupStepNameScreen} />
      <AuthStack.Screen name="SignupStepBirthday" component={SignupStepBirthdayScreen} />
      <AuthStack.Screen name="SignupStepPhone" component={SignupStepPhoneScreen} />
      <AuthStack.Screen name="SignupStepAddress" component={SignupStepAddressScreen} />
      <AuthStack.Screen name="SignupStepAvatar" component={SignupStepAvatarScreen} />
      <AuthStack.Screen name="HouseholdSetup" component={HouseholdSetupScreen} />
      <AuthStack.Screen name="InviteMembers" component={InviteMembersScreen} />
      {/* Feature overview — the four-step tour a household CREATOR sees
          after InviteMembers, immediately before setup completes. Members
          who joined with a code skip straight past it (see
          InviteMembersScreen.finish). */}
      <AuthStack.Screen name="FeatureIntro" component={FeatureIntroScreen} />
      <AuthStack.Screen name="FeatureDay" component={FeatureDayScreen} />
      <AuthStack.Screen name="FeaturePrivacy" component={FeaturePrivacyScreen} />
      <AuthStack.Screen name="FeaturePricing" component={FeaturePricingScreen} />
      <AuthStack.Screen name="ForgotPassword" component={ForgotPasswordScreen} />
      <AuthStack.Screen name="EmailVerification" component={EmailVerificationScreen} />
    </AuthStack.Navigator>
  );
}

function PaywallNavigator() {
  const isAdmin = useBillingStore((s) => s.status?.isAdmin);
  return (
    <PaywallStack.Navigator screenOptions={{ headerShown: false }}>
      {isAdmin
        ? <PaywallStack.Screen name="Paywall" component={PaywallScreen} />
        : <PaywallStack.Screen name="PaywallMember" component={PaywallMemberScreen} />}
    </PaywallStack.Navigator>
  );
}

function ChatNavigator() {
  return (
    <ChatNav.Navigator screenOptions={{ headerShown: false }}>
      <ChatNav.Screen name="Conversations" component={ConversationsScreen} />
      <ChatNav.Screen name="ChatScreen" component={ChatScreen} />
      <ChatNav.Screen name="GroupMembers" component={GroupMembersScreen} />
    </ChatNav.Navigator>
  );
}

function TasksNavigator() {
  return (
    <TasksNav.Navigator screenOptions={{ headerShown: false }}>
      <TasksNav.Screen name="TaskList" component={TaskListScreen} />
      <TasksNav.Screen name="TaskDetail" component={TaskDetailScreen} />
      <TasksNav.Screen
        name="CreateTask"
        component={CreateTaskScreen}
        options={{ headerShown: false, presentation: 'transparentModal' }}
      />
    </TasksNav.Navigator>
  );
}

function MoreNavigator() {
  return (
    <MoreNav.Navigator screenOptions={{ headerShown: false }}>
      <MoreNav.Screen name="MoreIndex" component={MoreScreen} />
      <MoreNav.Screen name="HouseholdSettings" component={HouseholdSettingsScreen} />
      <MoreNav.Screen name="Subscription" component={SubscriptionScreen} />
      <MoreNav.Screen name="GroceryList" component={GroceryListScreen} />
      <MoreNav.Screen name="TodoList" component={TodoListScreen} />
      <MoreNav.Screen
        name="CreateExpense"
        component={CreateExpenseScreen}
        options={{ headerShown: false, presentation: 'transparentModal' }}
      />
      <MoreNav.Screen name="ExpenseList" component={ExpenseListScreen} />
      <MoreNav.Screen name="ExpenseDetail" component={ExpenseDetailScreen} />
      <MoreNav.Screen name="ExpenseLedger" component={ExpenseLedgerScreen} />
      <MoreNav.Screen name="ExpenseSettlements" component={ExpenseSettlementScreen} />
      <MoreNav.Screen name="MemberBalanceDetail" component={MemberBalanceDetailScreen} />
      <MoreNav.Screen name="NotificationPreferences" component={NotificationPreferencesScreen} />
      <MoreNav.Screen name="Vault" component={VaultListScreen} />
      <MoreNav.Screen
        name="VaultUpload"
        component={VaultUploadScreen}
        options={{ headerShown: false, presentation: 'transparentModal', animation: 'slide_from_bottom' }}
      />
      <MoreNav.Screen name="VaultSetup" component={VaultSetupScreen} />
      <MoreNav.Screen name="VaultViewer" component={VaultViewerScreen} />
      <MoreNav.Screen name="Journal" component={JournalScreen} />
      <MoreNav.Screen name="JournalHistory" component={JournalHistoryScreen} />
      <MoreNav.Screen name="JournalEntry" component={JournalEntryDetailScreen} />
      <MoreNav.Screen
        name="JournalEditor"
        component={JournalEntryEditorScreen}
        // The composer is a modal task, not a place in the More hierarchy:
        // it slides up, and swiping it away is the same as Cancel.
        options={{ presentation: 'modal', animation: 'slide_from_bottom' }}
      />
      <MoreNav.Screen name="Calendar" component={CalendarScreen} />
      <MoreNav.Screen name="CheckIn" component={CheckInScreen} />
      <MoreNav.Screen
        name="CreateEvent"
        component={CreateEventScreen}
        options={{ headerShown: false, presentation: 'transparentModal', animation: 'slide_from_bottom' }}
      />
      <MoreNav.Screen name="EditProfile" component={EditProfileScreen} />
      <MoreNav.Screen name="AccountDeletion" component={AccountDeletionScreen} />
      <MoreNav.Screen name="PrivacyPolicy" component={PrivacyPolicyScreen} />
      <MoreNav.Screen name="HelpCenter" component={HelpCenterScreen} />
      <MoreNav.Screen name="PostDetail" component={PostDetailScreen} />
    </MoreNav.Navigator>
  );
}

/* ── Design system tokens (mockup 03-Home-Feed) ── */
const INK = colors.ink;
const GOLD = colors.gold;
const INACTIVE = withAlpha(colors.ink, 0.45);

/* ── Tab icon components (View-based, no emoji) ── */

function TabDot({ color }) {
  return <View style={{ width: 4, height: 4, borderRadius: 2, backgroundColor: color, marginBottom: 3 }} />;
}

function TabHomeIcon({ color, focused }) {
  return (
    <View style={{ width: 24, height: 24, alignItems: 'center', justifyContent: 'center' }}>
      {focused && <TabDot color={color} />}
      <Ionicons name={focused ? 'home' : 'home-outline'} size={20} color={color} />
    </View>
  );
}

function TabFeedIcon({ color, focused }) {
  return (
    <View style={{ width: 24, height: 24, alignItems: 'center', justifyContent: 'center' }}>
      {focused && <TabDot color={color} />}
      <Ionicons name={focused ? 'images' : 'images-outline'} size={20} color={color} />
    </View>
  );
}

function TabChatIcon({ color, focused }) {
  return (
    <View style={{ width: 24, height: 24, alignItems: 'center', justifyContent: 'center' }}>
      {focused && <TabDot color={color} />}
      <Ionicons name={focused ? 'chatbubbles' : 'chatbubbles-outline'} size={20} color={color} />
    </View>
  );
}

function TabTasksIcon({ color, focused }) {
  return (
    <View style={{ width: 24, height: 24, alignItems: 'center', justifyContent: 'center' }}>
      {focused && <TabDot color={color} />}
      <Ionicons name={focused ? 'checkbox' : 'checkbox-outline'} size={20} color={color} />
    </View>
  );
}

function TabMoreIcon({ color, focused }) {
  return (
    <View style={{ width: 24, height: 24, alignItems: 'center', justifyContent: 'center' }}>
      {focused && <TabDot color={color} />}
      <Ionicons
        name={focused ? 'ellipsis-horizontal' : 'ellipsis-horizontal-outline'}
        size={20}
        color={color}
      />
    </View>
  );
}

/* ── Main tab navigator ── */

/* Modern floating glass dock tab bar (mockup-inspired, design-system tokens) */
function GlassTabBar({ state, descriptors, navigation }) {
  const insets = useSafeAreaInsets();

  // Hide the dock whenever the focused tab's own `options.tabBarStyle` opts
  // out (e.g. `{ display: 'none' }`, already set per-screen in MainNavigator
  // for full-screen chat, notification preferences, and Vault routes). Reading
  // this generically — rather than re-deriving per-stack route-name checks
  // here — is what makes new "hide the dock" screens work automatically:
  // set `tabBarStyle: { display: 'none' }` on the screen and the dock respects
  // it, with no changes needed in this component.
  const focusedRoute = state.routes[state.index];
  const focusedOptions = descriptors[focusedRoute.key].options;
  if (focusedOptions.tabBarStyle?.display === 'none') return null;

  return (
    <View
      style={[
        {
          // The dock sits in normal layout flow so the screen above it ends
          // where it begins — nothing scrolls behind it. The floating look is
          // the *pill inside*: a translucent, blurred glass bar inset from
          // the screen's edges, not an opaque strip.
          paddingBottom: (insets.bottom > 0 ? insets.bottom : 10) + 5,
          paddingHorizontal: 14,
          // No top padding: the pill's own top edge is where the screen ends,
          // so there is no canvas band above it reading as a seam.
          paddingTop: 0,
          backgroundColor: 'transparent',
        },
      ]}
    >
      <View
        style={{
          borderRadius: 28,
          // No `overflow: 'hidden'` here — on iOS it suppresses the shadow that
          // sells the floating look. The blur/background fill is clipped to the
          // radius by the inner wrapper below instead, so the shadow stays crisp.
          borderWidth: 1,
          borderColor: withAlpha(colors.white, 0.1),
          borderTopColor: withAlpha(colors.white, 0.16),
          shadowColor: colors.black,
          shadowOffset: { width: 0, height: 10 },
          shadowOpacity: 0.4,
          shadowRadius: 24,
          elevation: 14,
        }}
      >
        <View style={{ borderRadius: 28, overflow: 'hidden' }}>
          {/* Android's BlurView has nothing to blur here — the dock sits in
              normal document flow over a near-uniform dark-navy background,
              so even working blur reads as a flat tint. iOS home screens
              tend to have more varied content behind it, so keep it there;
              on Android, skip straight to the same white-tinted glass fill
              the rest of the app uses (see DashboardScreen's GLASS_FILL). */}
          {Platform.OS === 'ios' && (
            <BlurView intensity={40} tint="default" style={StyleSheet.absoluteFill} />
          )}
          <View
            style={{
              flexDirection: 'row',
              backgroundColor: Platform.OS === 'ios'
                ? withAlpha(colors.overlaySlate, 0.3)
                : withAlpha(colors.white, 0.08),
            }}
          >
            {state.routes.map((route, index) => {
              const { options } = descriptors[route.key];
              const label = options.tabBarLabel ?? options.title ?? route.name;
              const isFocused = state.index === index;

              const onPress = () => {
                const event = navigation.emit({
                  type: 'tabPress',
                  target: route.key,
                  canPreventDefault: true,
                });
                if (!isFocused && !event.defaultPrevented) {
                  navigation.navigate(route.name, route.params);
                }
              };

              const onLongPress = () => {
                navigation.emit({ type: 'tabLongPress', target: route.key });
              };

              const color = isFocused ? GOLD : INACTIVE;

              return (
                <TouchableOpacity
                  key={route.key}
                  accessibilityRole="button"
                  accessibilityState={isFocused ? { selected: true } : {}}
                  onPress={onPress}
                  onLongPress={onLongPress}
                  style={{
                    flex: 1,
                    alignItems: 'center',
                    justifyContent: 'center',
                    paddingVertical: 8,

                    gap: 3,
                  }}
                  activeOpacity={0.75}
                >
                  {/* Active gold pill behind icon */}
                  <View
                    style={{
                      width: 44,
                      height: 30,
                      borderRadius: 15,
                      alignItems: 'center',
                      justifyContent: 'center',
                      //

                    }}
                  >
                    {options.tabBarIcon ? options.tabBarIcon({ color, focused: isFocused, size: 22 }) : null}
                  </View>
                  <Text
                    style={{
                      fontSize: 10.5,
                      fontWeight: isFocused ? '700' : '600',
                      letterSpacing: 0.1,
                      color: isFocused ? INK : INACTIVE,
                      fontFamily: isFocused ? 'PlusJakartaSans_700Bold' : 'Inter_600SemiBold',
                    }}
                  >
                    {label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      </View>
    </View>
  );
}

function MainNavigator() {
  // GlassTabBar (a custom `tabBar` render prop, below) fully replaces
  // React Navigation's own default tab bar, so this object's cosmetic
  // properties (border/shadow/elevation) are never actually drawn — the
  // default bar they'd style is never rendered. Its only real job is
  // `display: 'none'`, merged in per-screen below to hide the dock on
  // full-screen routes (chat thread, notification preferences, Vault).
  //
  // It previously also carried `position: 'absolute'` + `height: 0`, left
  // over from an earlier floating-dock design. GlassTabBar has since moved
  // into normal document flow (see its own comment below) — the screen
  // above it already ends exactly where it begins — so a stray
  // `position: 'absolute'` here was actively misleading: it read as "the
  // dock floats over content," which is no longer true and is exactly the
  // kind of stale claim that leads a screen to reserve space it doesn't
  // need. `useTabBarDockHeight()` (src/shared/hooks/useTabBarDockHeight.js)
  // is the one place that documents and returns the real answer.
  const tabBarStyle = {
    backgroundColor: 'transparent',
  };

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    NavigationBar.setBackgroundColorAsync(colors.canvas);
    NavigationBar.setButtonStyleAsync('light');
  }, []);

  return (
    <MainTab.Navigator
      tabBar={(props) => <GlassTabBar {...props} />}
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: GOLD,
        tabBarInactiveTintColor: INACTIVE,
        tabBarStyle,
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: '600',
          letterSpacing: 0.2,
          textTransform: 'none',
        },
      }}
    >
      <MainTab.Screen
        name="KnowsDashboard"
        component={DashboardScreen}
        options={{
          tabBarLabel: 'Home',
          tabBarIcon: ({ color, focused }) => <TabHomeIcon color={color} focused={focused} />,
        }}
      />
      <MainTab.Screen
        name="FeedStack"
        component={FeedScreen}
        options={{
          tabBarLabel: 'Feed',
          tabBarIcon: ({ color, focused }) => <TabFeedIcon color={color} focused={focused} />,
        }}
      />
      <MainTab.Screen
        name="ChatStack"
        component={ChatNavigator}
        options={({ route }) => {
          const routeName = getFocusedRouteNameFromRoute(route);
          // Full-screen chat: hide the floating tab bar so it never covers the input
          const hideTab = routeName === 'ChatScreen';
          return {
            tabBarLabel: 'Chat',
            tabBarStyle: hideTab ? { display: 'none' } : tabBarStyle,
            tabBarIcon: ({ color, focused }) => <TabChatIcon color={color} focused={focused} />,
          };
        }}
        listeners={({ navigation: tabNav }) => ({
          // Nested stacks preserve their pushed screens by default when you
          // switch tabs and come back — reset to the tab's own root screen
          // every time it's pressed, whether it was already focused (tap
          // again while there) or you're returning from another tab.
          tabPress: (e) => {
            e.preventDefault();
            tabNav.navigate('ChatStack', { screen: 'Conversations' });
          },
        })}
      />
      <MainTab.Screen
        name="TasksStack"
        component={TasksNavigator}
        options={{
          tabBarLabel: 'Tasks',
          tabBarIcon: ({ color, focused }) => <TabTasksIcon color={color} focused={focused} />,
        }}
        listeners={({ navigation: tabNav }) => ({
          tabPress: (e) => {
            e.preventDefault();
            tabNav.navigate('TasksStack', { screen: 'TaskList' });
          },
        })}
      />
      <MainTab.Screen
        name="MoreStack"
        component={MoreNavigator}
        options={({ route }) => {
          const routeName = getFocusedRouteNameFromRoute(route);
          const hideTab =
            routeName === 'NotificationPreferences' ||
            (!!routeName &&
              (VAULT_ROUTES.includes(routeName) || JOURNAL_FULLSCREEN_ROUTES.includes(routeName)));
          return {
            tabBarLabel: 'More',
            tabBarStyle: hideTab ? { display: 'none' } : tabBarStyle,
            tabBarIcon: ({ color, focused }) => <TabMoreIcon color={color} focused={focused} />,
          };
        }}
        listeners={({ navigation: tabNav }) => ({
          tabPress: (e) => {
            e.preventDefault();
            tabNav.navigate('MoreStack', { screen: 'MoreIndex' });
          },
        })}
      />
    </MainTab.Navigator>
  );
}

function MainWithBanner(props) {
  return (
    <View style={{ flex: 1 }}>
      <MainNavigator {...props} />
      <GraceBanner />
    </View>
  );
}

export default function RootNavigator() {
  const isLoading = useAuthStore((s) => s.isLoading);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const accessToken = useAuthStore((s) => s.accessToken);
  const restoreSession = useAuthStore((s) => s.restoreSession);
  const userId = useAuthStore((s) => s.user?.id);
  useBillingLifecycle(isAuthenticated, userId);
  const gate = useBillingStore(selectGate);
  const [minSplashDone, setMinSplashDone] = useState(false);

  // Restore auth from SecureStore on boot
  useEffect(() => { restoreSession(); }, [restoreSession]);

  // Enforce minimum 3s splash display so the brand animation is seen
  useEffect(() => {
    const timer = setTimeout(() => setMinSplashDone(true), 3000);
    return () => clearTimeout(timer);
  }, []);

  // Socket lifecycle — reconnects with the new token on every refresh.
  useEffect(() => {
    if (isAuthenticated && accessToken) {
      connectSocket(accessToken);
    } else {
      disconnectSocket();
    }
  }, [isAuthenticated, accessToken]);

  // Push registration follows sign-in only, not token refreshes (it used to
  // re-register on every refresh). Unregistering happens in logout(), while
  // the session's token still exists.
  useEffect(() => {
    if (isAuthenticated) registerForPushNotificationsAsync();
  }, [isAuthenticated]);

  if (isLoading || !minSplashDone) {
    return <SplashScreen />;
  }

  const view = chooseRootView({ isAuthenticated, gate });
  if (view === 'auth') return <AuthNavigator />;
  if (view === 'paywall') return <PaywallNavigator />;

  return (
    <RootStack.Navigator screenOptions={{ presentation: 'modal', headerShown: false }}>
      {/* The tab shell is the app's persistent base screen, not an overlay —
          presenting it as a 'modal' (inherited from screenOptions above,
          meant for CreatePost/Notifications) changes how native-stack
          computes this screen's safe-area insets on some platforms, which is
          what left a gap below the docked tab bar. */}
      <RootStack.Screen name="MainTabs" component={MainWithBanner} options={{ presentation: 'card' }} />
      <RootStack.Screen
        name="CreatePost"
        component={CreatePostScreen}
        options={{ presentation: 'transparentModal', animation: 'fade' }}
      />
      <RootStack.Screen name="Comments" component={CommentsScreen} />
      <RootStack.Screen
        name="PhotoGallery"
        component={PhotoGalleryScreen}
        options={{ animation: 'slide_from_right' }}
      />
      <RootStack.Screen
        name="Notifications"
        component={NotificationScreen}
        options={{ presentation: 'modal', animation: 'slide_from_bottom' }}
      />
    </RootStack.Navigator>
  );
}
