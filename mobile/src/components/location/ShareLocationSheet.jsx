import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, ActivityIndicator } from 'react-native';
import { colors, fonts, radius, withAlpha } from '../../shared/theme';
import { GoldFill } from '../../shared/components/GoldButton';
import { SHARE_PRESETS } from '../../shared/location/sharePresets';

/**
 * Sheet content for starting a timed location share. Wrap in a Modal at the
 * call site. `initialViewerIds` preselects the audience (answering a ping);
 * `lockAudience` hides the audience choice when the server fixes it.
 */
export default function ShareLocationSheet({
  members = [],
  initialViewerIds = null,
  lockAudience = false,
  title = 'Share my location',
  subtitle = 'Pick how long, and who can see where you are.',
  loading = false,
  onStart,
  onCancel,
}) {
  const [minutes, setMinutes] = useState(SHARE_PRESETS[0].minutes);
  const [choosing, setChoosing] = useState(!!initialViewerIds);
  const [selected, setSelected] = useState(() => new Set(initialViewerIds || []));

  const canStart = !loading && (lockAudience || !choosing || selected.size > 0);

  const toggle = (id) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const start = () => {
    if (!canStart) return;
    const known = members.filter((m) => selected.has(m.id)).map((m) => m.id);
    const extra = [...selected].filter((id) => !known.includes(id));
    onStart({ durationMinutes: minutes, viewerIds: choosing ? [...known, ...extra] : null });
  };

  return (
    <View style={styles.sheet}>
      <View style={styles.handle} />
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.subtitle}>{subtitle}</Text>
        </View>
        <TouchableOpacity onPress={onCancel} accessibilityLabel="Cancel" hitSlop={8}>
          <Text style={styles.cancel}>Cancel</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.label}>For how long</Text>
      <View style={styles.row}>
        {SHARE_PRESETS.map((p) => {
          const on = p.minutes === minutes;
          return (
            <TouchableOpacity
              key={p.minutes}
              style={[styles.chip, on && styles.chipOn]}
              onPress={() => setMinutes(p.minutes)}
              accessibilityLabel={`Share for ${p.label}`}
              accessibilityState={{ selected: on }}
              activeOpacity={0.85}
            >
              <Text style={[styles.chipText, on && styles.chipTextOn]}>{p.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {!lockAudience && (
        <>
          <Text style={styles.label}>Who can see</Text>
          <View style={styles.row}>
            <TouchableOpacity
              style={[styles.chip, !choosing && styles.chipOn]}
              onPress={() => setChoosing(false)}
              accessibilityLabel="Everyone"
              accessibilityState={{ selected: !choosing }}
              activeOpacity={0.85}
            >
              <Text style={[styles.chipText, !choosing && styles.chipTextOn]}>Everyone</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.chip, choosing && styles.chipOn]}
              onPress={() => setChoosing(true)}
              accessibilityLabel="Choose people"
              accessibilityState={{ selected: choosing }}
              activeOpacity={0.85}
            >
              <Text style={[styles.chipText, choosing && styles.chipTextOn]}>Choose people</Text>
            </TouchableOpacity>
          </View>
          {choosing && (
            <ScrollView style={styles.memberList}>
              {members.map((m) => {
                const on = selected.has(m.id);
                return (
                  <TouchableOpacity
                    key={m.id}
                    style={styles.member}
                    onPress={() => toggle(m.id)}
                    accessibilityLabel={`Share with ${m.displayName}`}
                    accessibilityState={{ checked: on }}
                    activeOpacity={0.85}
                  >
                    <Text style={styles.memberName}>{m.displayName}</Text>
                    <View style={[styles.box, on && styles.boxOn]}>
                      {on && <Text style={styles.tick}>✓</Text>}
                    </View>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          )}
        </>
      )}

      <TouchableOpacity
        style={styles.startBtn}
        onPress={start}
        disabled={!canStart}
        accessibilityLabel="Start sharing"
        accessibilityState={{ disabled: !canStart }}
        activeOpacity={0.85}
      >
        <GoldFill radius={radius.pill} disabled={!canStart} />
        {loading ? (
          <ActivityIndicator size="small" color={colors.onAccent} />
        ) : (
          <Text style={styles.startText}>Start sharing</Text>
        )}
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    backgroundColor: colors.canvasElevated,
    borderTopLeftRadius: 32,
    borderTopRightRadius: 32,
    borderWidth: 1,
    borderBottomWidth: 0,
    borderColor: colors.border,
    paddingHorizontal: 24,
    paddingTop: 10,
    paddingBottom: 28,
  },
  handle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
    marginBottom: 14,
  },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginBottom: 12 },
  title: { fontFamily: fonts.displayBold, fontSize: 18, color: colors.ink },
  subtitle: { fontFamily: fonts.body, fontSize: 12.5, lineHeight: 17, color: colors.textSecondary, marginTop: 2 },
  cancel: { fontFamily: fonts.bodyMedium, fontSize: 14, color: colors.goldDeep },
  label: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 12,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    color: colors.textMuted,
    marginTop: 14,
    marginBottom: 8,
  },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  chip: {
    paddingHorizontal: 16,
    height: 42,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipOn: { borderColor: colors.gold, backgroundColor: colors.goldTint },
  chipText: { fontFamily: fonts.bodySemiBold, fontSize: 14, color: colors.textSecondary },
  chipTextOn: { color: colors.ink },
  memberList: { maxHeight: 180, marginTop: 10 },
  member: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: withAlpha(colors.border, 0.6),
  },
  memberName: { fontFamily: fonts.bodyMedium, fontSize: 15, color: colors.ink },
  box: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxOn: { borderColor: colors.gold, backgroundColor: colors.gold },
  tick: { fontSize: 13, color: colors.onAccent },
  startBtn: {
    marginTop: 22,
    height: 52,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  startText: { fontFamily: fonts.bodySemiBold, fontSize: 16, color: colors.onAccent },
});
