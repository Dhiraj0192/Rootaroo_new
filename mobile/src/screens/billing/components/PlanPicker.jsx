import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { planAmount, formatCents, autoRenewDisclosureText } from '../../../shared/billing/pricing';
import { colors, fonts, withAlpha } from '../../../shared/theme';

// storePrices (App Store / Google Play only): the store's own localized price strings keyed "month:5"; they win over the server USD amounts.
export default function PlanPicker({ plans, interval, seats, range, onChange, storePrices }) {
  const cents = planAmount(plans, interval, Math.min(seats, plans.seatsMax));
  const priceText = storePrices?.[`${interval}:${Math.min(seats, plans.seatsMax)}`] ?? formatCents(cents);
  return (
    <View>
      <View style={styles.tabs}>
        {[['year', 'Yearly'], ['month', 'Monthly']].map(([value, label]) => (
          <TouchableOpacity
            key={value}
            style={[styles.tab, interval === value && styles.tabOn]}
            onPress={() => onChange({ interval: value, seats })}
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityState={{ selected: interval === value }}
          >
            <Text style={[styles.tabText, interval === value && styles.tabTextOn]}>{label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <View style={styles.row}>
        <Text style={styles.label}>Household size</Text>
        <View style={styles.stepper}>
          <TouchableOpacity
            style={[styles.step, seats <= range.min && styles.stepOff]}
            disabled={seats <= range.min}
            onPress={() => onChange({ interval, seats: Math.max(range.min, seats - 1) })}
            accessibilityRole="button"
            accessibilityLabel="Remove a member"
          >
            <Text style={styles.stepText}>−</Text>
          </TouchableOpacity>
          <Text style={styles.seats}>{seats}</Text>
          <TouchableOpacity
            style={[styles.step, seats >= range.max && styles.stepOff]}
            disabled={seats >= range.max}
            onPress={() => onChange({ interval, seats: Math.min(range.max, seats + 1) })}
            accessibilityRole="button"
            accessibilityLabel="Add a member"
          >
            <Text style={styles.stepText}>+</Text>
          </TouchableOpacity>
        </View>
      </View>

      <Text style={styles.total}>{priceText}</Text>
      <Text style={styles.per}>per {interval}</Text>
      <Text style={styles.disclosure}>{autoRenewDisclosureText(priceText, interval)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  tabs: { flexDirection: 'row', gap: 6, padding: 4, borderRadius: 99, backgroundColor: colors.canvasGray },
  tab: { flex: 1, paddingVertical: 10, borderRadius: 99, alignItems: 'center' },
  tabOn: { backgroundColor: colors.gold },
  tabText: { fontFamily: fonts.bodyBold, color: colors.textSecondary, fontWeight: '800' },
  tabTextOn: { color: colors.canvas },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 20 },
  label: { fontFamily: fonts.bodyBold, color: colors.ink, fontSize: 15 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  step: { width: 34, height: 34, borderRadius: 17, borderWidth: 1, borderColor: withAlpha(colors.white, 0.15), alignItems: 'center', justifyContent: 'center' },
  stepOff: { opacity: 0.35 },
  stepText: { color: colors.ink, fontSize: 18 },
  seats: { fontFamily: fonts.mono, color: colors.ink, fontSize: 18, minWidth: 26, textAlign: 'center' },
  total: { fontFamily: fonts.mono, color: colors.ink, fontSize: 40, fontWeight: '800', marginTop: 24 },
  per: { fontFamily: fonts.bodySemiBold, color: colors.textMuted },
  disclosure: { fontFamily: fonts.bodySemiBold, color: colors.textSecondary, fontSize: 12, marginTop: 12 },
});
