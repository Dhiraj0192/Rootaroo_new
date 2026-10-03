import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as WebBrowser from 'expo-web-browser';
import { useBillingStore } from '../../shared/store/billingStore';
import { billingApi } from '../../shared/api/billing';
import { openBillingPortal, describeCheckoutError, restorePurchases } from '../../shared/billing/purchase';
import { manageStoreSubscription } from '../../shared/billing/iap';
import { formatCents, seatRange } from '../../shared/billing/pricing';
import PlanPicker from './components/PlanPicker';
import { colors, fonts } from '../../shared/theme';

const PROVIDER_LABEL = { stripe: 'Paid with card (Stripe)', apple: 'Paid through the App Store', google: 'Paid through Google Play' };

export default function SubscriptionScreen() {
  const insets = useSafeAreaInsets();
  const status = useBillingStore((s) => s.status);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const sub = status?.subscription;
  const plans = status?.plans;
  const range = plans ? seatRange(plans, status.memberCount) : null;
  const [choice, setChoice] = useState(sub ? { interval: sub.interval, seats: sub.seats } : { interval: 'year', seats: 5 });

  if (!status) return <ActivityIndicator style={{ marginTop: 80 }} color={colors.gold} />;

  const manage = () => {
    if (!sub || sub.provider === 'stripe') {
      return openBillingPortal().catch(() => setMessage('Could not open the billing portal. Please try again.'));
    }
    return manageStoreSubscription(sub.provider, { seats: sub.seats, interval: sub.interval });
  };

  const restore = async () => {
    const r = await restorePurchases({ method: status.purchaseMethod });
    if (r.outcome === 'nothing_to_restore') setMessage('No purchases to restore for this household.');
    else if (r.outcome === 'error') setMessage(r.error.message);
  };

  const confirmChange = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const r = await billingApi.changePlan(choice);
      if (r.pendingUpdate && r.hostedInvoiceUrl) {
        setMessage('Confirm the payment to finish your plan change.');
        await WebBrowser.openBrowserAsync(r.hostedInvoiceUrl);
      } else {
        setMessage(r.changed ? 'Your plan was updated.' : 'That is already your plan.');
      }
      setEditing(false);
      await useBillingStore.getState().refresh();
    } catch (err) {
      setMessage(describeCheckoutError(err).message);
    } finally {
      setBusy(false);
    }
  };

  const date = sub?.currentPeriodEnd ? new Date(sub.currentPeriodEnd).toLocaleDateString() : null;
  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ paddingTop: insets.top + 16, paddingBottom: insets.bottom + 32, paddingHorizontal: 20 }}>
      <Text style={styles.title}>Subscription</Text>
      {sub ? (
        <View style={styles.card}>
          <Text style={styles.big}>{`${sub.seats} members · ${sub.interval === 'year' ? 'yearly' : 'monthly'}`}</Text>
          {sub.unitAmount !== null ? <Text style={styles.line}>{`${formatCents(sub.unitAmount)} per ${sub.interval}`}</Text> : null}
          {date ? <Text style={styles.line}>{sub.cancelAtPeriodEnd ? `Ends on ${date}` : `Renews on ${date}`}</Text> : null}
          <Text style={styles.line}>{`${status.memberCount} of ${status.entitlement.seatsAllowed} seats used`}</Text>
          <Text style={styles.muted}>{PROVIDER_LABEL[sub.provider] ?? sub.provider}</Text>
          {sub.pendingUpdate ? <Text style={styles.warn}>A plan change is waiting for payment.</Text> : null}
        </View>
      ) : (
        <Text style={styles.line}>{status.entitlement.reason === 'test_cohort' ? 'Test household: no subscription needed.' : 'No subscription yet.'}</Text>
      )}

      {status.isAdmin ? (
        <View style={{ marginTop: 20 }}>
          {sub ? <Action label="Manage subscription" onPress={manage} /> : null}
          {sub?.provider === 'stripe' && plans && !editing ? <Action label="Change plan" onPress={() => setEditing(true)} /> : null}
          {editing && plans ? (
            <View style={styles.card}>
              <PlanPicker plans={plans} interval={choice.interval} seats={choice.seats} range={range} onChange={setChoice} />
              <Action label={busy ? 'Saving…' : 'Confirm change'} onPress={confirmChange} disabled={busy} />
              <Action label="Cancel" onPress={() => setEditing(false)} />
            </View>
          ) : null}
          <Action label="Restore purchases" onPress={restore} />
        </View>
      ) : null}
      {message ? <Text style={styles.line}>{message}</Text> : null}
    </ScrollView>
  );
}

function Action({ label, onPress, disabled }) {
  return (
    <TouchableOpacity style={styles.action} onPress={onPress} disabled={disabled} accessibilityRole="button">
      <Text style={styles.actionText}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.canvas },
  title: { fontFamily: fonts.display, color: colors.ink, fontSize: 26, fontWeight: '800', marginBottom: 16 },
  card: { backgroundColor: colors.canvasGray, borderRadius: 18, padding: 18, marginTop: 8 },
  big: { fontFamily: fonts.bodyBold, color: colors.ink, fontSize: 18, fontWeight: '800' },
  line: { fontFamily: fonts.bodySemiBold, color: colors.textSecondary, marginTop: 8 },
  muted: { fontFamily: fonts.bodySemiBold, color: colors.textMuted, marginTop: 8, fontSize: 12 },
  warn: { fontFamily: fonts.bodySemiBold, color: colors.danger, marginTop: 8 },
  action: { paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.canvasGray },
  actionText: { fontFamily: fonts.bodyBold, color: colors.gold, fontSize: 15 },
});
