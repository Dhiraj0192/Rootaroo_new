import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, StatusBar, ActivityIndicator } from 'react-native';
import { WebView } from 'react-native-webview';
import * as WebBrowser from 'expo-web-browser';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, fonts, radius } from '../shared/theme';
import { useTabBarDockHeight } from '../shared/hooks/useTabBarDockHeight';
import { PRIVACY_URL } from '../shared/billing/legalLinks';

/**
 * Shows the live policy from rootaroo.com/privacy, so the app never carries a
 * stale copy. Links that leave the policy page open in the browser.
 */
export default function PrivacyPolicyScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const dockHeight = useTabBarDockHeight();
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const keepInApp = (req) => {
    if (req.isTopFrame === false) return true;
    if (/^https:\/\/(www\.)?rootaroo\.com\/privacy(\/|\?|#|$)/.test(req.url)) return true;
    WebBrowser.openBrowserAsync(req.url).catch(() => {});
    return false;
  };

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <StatusBar barStyle="light-content" backgroundColor={colors.canvas} />
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => navigation.goBack()}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <Text style={styles.backIcon}>‹</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Privacy Policy</Text>
        <View style={styles.headerSpacer} />
      </View>

      {failed ? (
        <View style={styles.center}>
          <Text style={styles.errorTitle}>Couldn't load the privacy policy</Text>
          <Text style={styles.errorBody}>Check your connection, or read it in your browser.</Text>
          <TouchableOpacity
            style={styles.openBtn}
            onPress={() => WebBrowser.openBrowserAsync(PRIVACY_URL).catch(() => {})}
            accessibilityRole="link"
          >
            <Text style={styles.openBtnText}>Open rootaroo.com/privacy</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={[styles.webWrap, { marginBottom: dockHeight }]}>
          <WebView
            source={{ uri: PRIVACY_URL }}
            style={styles.web}
            onLoadEnd={() => setLoading(false)}
            onError={() => setFailed(true)}
            onHttpError={() => setFailed(true)}
            onShouldStartLoadWithRequest={keepInApp}
            setSupportMultipleWindows={false}
            javaScriptEnabled
            domStorageEnabled
          />
          {loading && (
            <View style={styles.loading} pointerEvents="none">
              <ActivityIndicator color={colors.gold} />
            </View>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.canvas,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: 56,
    paddingHorizontal: 24,
  },
  backBtn: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backIcon: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.ink,
    lineHeight: 26,
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: '700',
    fontFamily: fonts.displayBold,
    color: colors.ink,
  },
  headerSpacer: {
    width: 32,
  },
  webWrap: {
    flex: 1,
  },
  web: {
    flex: 1,
    backgroundColor: colors.canvas,
  },
  loading: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.canvas,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 10,
  },
  errorTitle: {
    fontSize: 16,
    fontFamily: fonts.displayBold,
    color: colors.ink,
    textAlign: 'center',
  },
  errorBody: {
    fontSize: 13.5,
    lineHeight: 20,
    fontFamily: fonts.body,
    color: colors.textSecondary,
    textAlign: 'center',
  },
  openBtn: {
    marginTop: 8,
    paddingHorizontal: 20,
    height: 48,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.gold,
  },
  openBtnText: {
    fontSize: 15,
    fontFamily: fonts.bodySemiBold,
    color: colors.canvas,
  },
});
