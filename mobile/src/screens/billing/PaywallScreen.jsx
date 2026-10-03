import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as WebBrowser from 'expo-web-browser';
import { useBillingStore } from '../../shared/store/billingStore';
import { useAuthStore } from '../../shared/store/authStore';
import { seatRange } from '../../shared/billing/pricing';
import { startPurchase, restorePurchases, canStartPurchase, STORE_METHODS, openBillingPortal } from '../../shared/billing/purchase';
import { fetchStorePrices } from '../../shared/billing/iap';
import { TERMS_URL, PRIVACY_URL } from '../../shared/billing/legalLinks';
import PlanPicker from './components/PlanPicker';
import { colors, fonts } from '../../shared/theme';

export default function PaywallScreen() {
  const insets = useSafeAreaInsets();
  const status = useBillingStore((s) => s.status);
  const plans = status?.plans;
  const range = plans ? seatRange(plans, status.memberCount) : { min: 5, max: 10, overCap: false };
  const [choice, setChoice] = useState({ interval: 'year', seats: Math.min(range.min, range.max) });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  const method = status?.purchaseMethod;
  const supported = canStartPurchase(method);
  const [storePrices, setStorePrices] = useState(null);

  // App Store / Google Play show the store's own localized prices, not the server's USD matrix.
  useEffect(() => {
    if (!STORE_METHODS.includes(method)) return;
    let live = true;
    fetchStorePrices().then((p) => { if (live) setStorePrices(p); });
    return () => { live = false; };
  }, [method]);
  const canBuy = Boolean(supported && plans && !range.overCap && !busy);
  const seats = Math.max(choice.seats, range.min);

  const subscribe = async () => {
    setBusy(true);
    setMessage(null);
    const r = await startPurchase({ method, interval: choice.interval, seats });
    setBusy(false);
    if (r.outcome === 'confirming') setMessage({ text: 'Confirming your payment…' });
    else if (r.outcome === 'pending') setMessage({ text: 'Your purchase is pending approval. You will get access as soon as it completes.' });
    else if (r.outcome === 'not_completed') setMessage({ text: STORE_METHODS.includes(method) ? 'The purchase was not completed.' : 'Checkout was not completed.' });
    else if (r.outcome === 'error') setMessage({ text: r.error.message, portalUrl: r.error.portalUrl });
    // 'unlocked': the store flips the gate and RootNavigator shows MainTabs.
  };

  const restore = async () => {
    setBusy(true);
    setMessage(null);
    const r = await restorePurchases({ method });
    setBusy(false);
    if (r.outcome === 'nothing_to_restore') setMessage({ text: 'No purchases to restore for this household.' });
    else if (r.outcome === 'confirming') setMessage({ text: 'Confirming your purchase…' });
    else if (r.outcome === 'error') setMessage({ text: r.error.message });
  };

  const fixPayment = () => {
    openBillingPortal().catch(() => setMessage({ text: 'Could not open the billing portal. Please try again.' }));
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24, paddingHorizontal: 22 }}>
      <Text style={styles.title}>Keep your household together</Text>
      <Text style={styles.sub}>Rootaroo needs an active subscription. Your data is safe and waiting.</Text>

      {!plans ? <ActivityIndicator color={colors.gold} style={{ marginTop: 40 }} /> : (
        <View style={{ marginTop: 24 }}>
          {range.overCap ? (
            <Text style={styles.warn}>{`Your household has ${status.memberCount} members, and the largest plan is ${plans.seatsMax}. Remove members in Household settings to subscribe.`}</Text>
          ) : (
            <PlanPicker plans={plans} interval={choice.interval} seats={seats} range={range} onChange={setChoice} storePrices={storePrices} />
          )}
        </View>
      )}

      {!supported && status ? <Text style={styles.warn}>Purchasing isn't available here yet</Text> : null}

      <TouchableOpacity
        style={[styles.cta, !canBuy && styles.ctaOff]}
        disabled={!canBuy}
        onPress={subscribe}
        accessibilityRole="button"
        accessibilityLabel="Subscribe"
        accessibilityState={{ disabled: !canBuy }}
      >
        {busy ? <ActivityIndicator color={colors.canvas} /> : <Text style={styles.ctaText}>Subscribe</Text>}
      </TouchableOpacity>

      {message ? <Text style={styles.message}>{message.text}</Text> : null}
      {message?.portalUrl ? (
        <TouchableOpacity onPress={fixPayment}><Text style={styles.link}>Update payment method</Text></TouchableOpacity>
      ) : null}

      <TouchableOpacity onPress={restore} accessibilityRole="button" accessibilityLabel="Restore purchases"><Text style={styles.link}>Restore purchases</Text></TouchableOpacity>
      <View style={styles.legal}>
        <TouchableOpacity onPress={() => WebBrowser.openBrowserAsync(TERMS_URL)}><Text style={styles.small}>Terms</Text></TouchableOpacity>
        <TouchableOpacity onPress={() => WebBrowser.openBrowserAsync(PRIVACY_URL)}><Text style={styles.small}>Privacy</Text></TouchableOpacity>
        <TouchableOpacity onPress={() => useAuthStore.getState().logout()}><Text style={styles.small}>Sign out</Text></TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.canvas },
  title: { fontFamily: fonts.display, color: colors.ink, fontSize: 26, fontWeight: '800' },
  sub: { fontFamily: fonts.bodySemiBold, color: colors.textSecondary, marginTop: 8 },
  warn: { fontFamily: fonts.bodySemiBold, color: colors.danger, marginTop: 16 },
  cta: { marginTop: 24, backgroundColor: colors.gold, borderRadius: 99, paddingVertical: 15, alignItems: 'center' },
  ctaOff: { opacity: 0.4 },
  ctaText: { fontFamily: fonts.bodyBold, color: colors.canvas, fontSize: 16, fontWeight: '800' },
  message: { fontFamily: fonts.bodySemiBold, color: colors.ink, marginTop: 14, textAlign: 'center' },
  link: { fontFamily: fonts.bodyBold, color: colors.gold, marginTop: 16, textAlign: 'center' },
  legal: { flexDirection: 'row', justifyContent: 'center', gap: 20, marginTop: 24 },
  small: { fontFamily: fonts.bodySemiBold, color: colors.textMuted, fontSize: 12 },
});
