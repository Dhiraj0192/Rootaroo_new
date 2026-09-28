import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { showAlert } from '../shared/services/themedAlert';
import SignupWizardShell from '../shared/components/SignupWizardShell';
import { authApi } from '../shared/api/auth';
import { useAuthStore } from '../shared/store/authStore';
import { loadSignupProgress, updateSignupProgress } from '../shared/store/signupProgress';
import { colors, fonts, radius, withAlpha } from '../shared/theme';
const ITEM_H = 46;
const VISIBLE = 3; // previous / selected / next — selected centered
const WHEEL_H = ITEM_H * VISIBLE;
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
function makeDays() {
  return Array.from(
    {
      length: 31,
    },
    (_, i) => String(i + 1),
  );
}
function makeYears() {
  const maxYear = new Date().getFullYear() - 13;
  const years = [];
  for (let y = maxYear; y >= 1950; y--) years.push(String(y));
  return years;
}
function toIsoDate(year, month, day) {
  const m = String(month).padStart(2, '0');
  const d = String(day).padStart(2, '0');
  return `${year}-${m}-${d}`;
}

/* ── Single scrolling wheel column (modern cylindrical) ─── */

function WheelColumn({ data, selected, onSelect }) {
  const scrollRef = useRef(null);
  const selectedIndex = data.indexOf(selected);
  const idx = selectedIndex >= 0 ? selectedIndex : Math.floor(data.length / 2);
  const [offset, setOffset] = useState(idx * ITEM_H);
  useEffect(() => {
    scrollRef.current?.scrollTo({
      y: idx * ITEM_H,
      animated: false,
    });
    setOffset(idx * ITEM_H);
  }, [idx]);
  const handleScroll = (e) => {
    setOffset(e.nativeEvent.contentOffset.y);
  };
  const handleScrollEnd = (e) => {
    const raw = Math.round(e.nativeEvent.contentOffset.y / ITEM_H);
    const clamped = Math.max(0, Math.min(data.length - 1, raw));
    const value = data[clamped];
    if (value && value !== selected) {
      onSelect(value);
      scrollRef.current?.scrollTo({
        y: clamped * ITEM_H,
        animated: true,
      });
    }
  };

  // Selected item is centered in the MIDDLE slot (viewport rows: prev/sel/next)
  // offset = idx * ITEM_H puts item idx in the middle slot.
  const viewCenter = offset + WHEEL_H / 2;
  const selIdx = Math.max(0, Math.min(data.length - 1, Math.round(offset / ITEM_H)));
  return (
    <View style={styles.wheelViewport}>
      <ScrollView
        ref={scrollRef}
        showsVerticalScrollIndicator={false}
        snapToInterval={ITEM_H}
        decelerationRate="fast"
        scrollEventThrottle={16}
        onScroll={handleScroll}
        onMomentumScrollEnd={handleScrollEnd}
        contentContainerStyle={styles.wheelContent}
        style={styles.wheelScroll}
      >
        {data.map((item, i) => {
          const isSel = i === selIdx;
          const isPrev = i === selIdx - 1;
          const isNext = i === selIdx + 1;
          return (
            <View
              key={item}
              style={[
                styles.wheelItem,
                isSel && styles.wheelItemSel,
                {
                  opacity: isSel || isPrev || isNext ? 1 : 0,
                },
              ]}
            >
              <Text
                style={[
                  styles.wheelItemText,
                  isSel && styles.wheelItemTextSel,
                  (isPrev || isNext) && styles.wheelItemTextNeighbor,
                ]}
              >
                {item}
              </Text>
            </View>
          );
        })}
      </ScrollView>

      {/* Divider lines framing the center selection slot */}
      <View
        pointerEvents="none"
        style={[
          styles.divider,
          {
            top: ITEM_H,
          },
        ]}
      />
      <View
        pointerEvents="none"
        style={[
          styles.divider,
          {
            top: ITEM_H * 2,
          },
        ]}
      />
    </View>
  );
}

/* ── Screen ──────────────────────────────────────────────── */

export default function SignupStepBirthdayScreen({ navigation }) {
  const user = useAuthStore((s) => s.user);
  const [dob, setDob] = useState(null);
  const [loading, setLoading] = useState(false);

  // Mockup default: June 11, 1989 (center of the wheel preview)
  const DEFAULT = new Date(1989, 5, 11);
  useEffect(() => {
    loadSignupProgress().then((p) => {
      if (p?.draft.dateOfBirth) {
        const parsed = new Date(p.draft.dateOfBirth + 'T12:00:00');
        if (!Number.isNaN(parsed.getTime())) setDob(parsed);
      } else {
        setDob(DEFAULT);
      }
    });
  }, []);
  const month = dob ? dob.getMonth() : 5;
  const day = dob ? dob.getDate() : 11;
  const year = dob ? dob.getFullYear() : 1989;
  const handleSelect = (kind, value) => {
    const base = dob ?? DEFAULT;
    let next;
    if (kind === 'month') {
      const m = MONTHS.indexOf(value) + 1;
      const maxDay = new Date(base.getFullYear(), m, 0).getDate();
      next = new Date(base.getFullYear(), m - 1, Math.min(base.getDate(), maxDay));
    } else if (kind === 'day') {
      const d = Number(value);
      const maxDay = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
      next = new Date(base.getFullYear(), base.getMonth(), Math.min(d, maxDay));
    } else {
      const y = Number(value);
      const maxDay = new Date(y, base.getMonth() + 1, 0).getDate();
      next = new Date(y, base.getMonth(), Math.min(base.getDate(), maxDay));
    }
    setDob(next);
  };
  const handleContinue = async () => {
    if (!dob) return;
    setLoading(true);
    try {
      const iso = toIsoDate(dob.getFullYear(), dob.getMonth() + 1, dob.getDate());
      const method = (await loadSignupProgress())?.authMethod || 'email';
      if (method !== 'phone' && user) {
        await authApi.updateProfile({
          dateOfBirth: iso,
        });
      }
      if (method === 'phone') {
        await updateSignupProgress({
          step: 'phone',
          draft: {
            dateOfBirth: iso,
          },
        });
        navigation.navigate('SignupStepPhone');
      } else {
        await updateSignupProgress({
          step: 'avatar',
          draft: {
            dateOfBirth: iso,
          },
        });
        navigation.navigate('SignupStepAvatar');
      }
    } catch (e) {
      showAlert('Error', e?.response?.data?.error || e?.message || 'Could not save birthday');
    } finally {
      setLoading(false);
    }
  };
  return (
    <SignupWizardShell
      step={2}
      stepName="Birthday"
      title="When's your birthday?"
      subtitle="This helps us tailor reminders and family milestones."
      onBack={() => navigation.goBack()}
      onContinue={handleContinue}
      continueDisabled={!dob}
      loading={loading}
    >
      {/* 3 scrolling wheels — Month / Day / Year */}
      <View style={styles.wheelRow}>
        <View style={styles.wheelCol}>
          <Text style={styles.colLabel}>Month</Text>
          <WheelColumn
            data={MONTHS}
            selected={MONTHS[month]}
            onSelect={(v) => handleSelect('month', v)}
          />
        </View>
        <View style={styles.wheelCol}>
          <Text style={styles.colLabel}>Day</Text>
          <WheelColumn
            data={makeDays()}
            selected={String(day)}
            onSelect={(v) => handleSelect('day', v)}
          />
        </View>
        <View style={styles.wheelCol}>
          <Text style={styles.colLabel}>Year</Text>
          <WheelColumn
            data={makeYears()}
            selected={String(year)}
            onSelect={(v) => handleSelect('year', v)}
          />
        </View>
      </View>
    </SignupWizardShell>
  );
}
const styles = StyleSheet.create({
  wheelRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 30,
    marginBottom: 40,
  },
  wheelCol: {
    flex: 1,
    alignItems: 'center',
  },
  colLabel: {
    fontFamily: fonts.bodyBold,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.3,
    color: colors.labelWarm,
    marginBottom: 14,
  },
  wheelViewport: {
    height: WHEEL_H,
    width: '100%',
    overflow: 'hidden',
  },
  wheelScroll: {
    flex: 1,
  },
  wheelContent: {
    paddingVertical: ITEM_H, // lets first/last values reach the middle slot
  },
  wheelItem: {
    height: ITEM_H,
    alignItems: 'center',
    justifyContent: 'center',
  },
  wheelItemSel: {
    backgroundColor: colors.surface,
    borderWidth: 1.5,
    borderColor: colors.goldWarm,
    borderRadius: radius.card,
    marginHorizontal: 2,
    shadowOpacity: 0,
    shadowRadius: 0,
    elevation: 0,
  },
  wheelItemText: {
    fontFamily: fonts.body,
    fontSize: 15,
    color: colors.placeholderWarm,
  },
  wheelItemTextSel: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  wheelItemTextNeighbor: {
    fontSize: 14,
    color: colors.taupeMid,
  },
  divider: {
    position: 'absolute',
    left: 8,
    right: 8,
    height: StyleSheet.hairlineWidth,
    backgroundColor: withAlpha(colors.textPrimary, 0.12),
  },
});
