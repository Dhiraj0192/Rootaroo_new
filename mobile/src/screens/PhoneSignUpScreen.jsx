import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  StatusBar,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  ActivityIndicator,
  FlatList,
  Modal,
  SafeAreaView,
} from 'react-native';
import { showAlert } from '../shared/services/themedAlert';
import Svg, { Path } from 'react-native-svg';
import { authApi } from '../shared/api/auth';
import { colors, fonts, goldButton, radius, withAlpha } from '../shared/theme';
import { GoldFill } from '../shared/components/GoldButton';
import { KEYBOARD_BEHAVIOR } from '../shared/components/KeyboardAware';
const COUNTRY_CODES = [
  {
    code: '+91',
    flag: '🇮🇳',
    name: 'India',
  },
  {
    code: '+1',
    flag: '🇺🇸',
    name: 'United States',
  },
  {
    code: '+44',
    flag: '🇬🇧',
    name: 'United Kingdom',
  },
  {
    code: '+61',
    flag: '🇦🇺',
    name: 'Australia',
  },
  {
    code: '+1',
    flag: '🇨🇦',
    name: 'Canada',
  },
  {
    code: '+64',
    flag: '🇳🇿',
    name: 'New Zealand',
  },
  {
    code: '+65',
    flag: '🇸🇬',
    name: 'Singapore',
  },
  {
    code: '+971',
    flag: '🇦🇪',
    name: 'UAE',
  },
  {
    code: '+974',
    flag: '🇶🇦',
    name: 'Qatar',
  },
  {
    code: '+966',
    flag: '🇸🇦',
    name: 'Saudi Arabia',
  },
  {
    code: '+49',
    flag: '🇩🇪',
    name: 'Germany',
  },
  {
    code: '+33',
    flag: '🇫🇷',
    name: 'France',
  },
  {
    code: '+81',
    flag: '🇯🇵',
    name: 'Japan',
  },
  {
    code: '+86',
    flag: '🇨🇳',
    name: 'China',
  },
  {
    code: '+55',
    flag: '🇧🇷',
    name: 'Brazil',
  },
  {
    code: '+27',
    flag: '🇿🇦',
    name: 'South Africa',
  },
  {
    code: '+977',
    flag: '🇳🇵',
    name: 'Nepal',
  },
  {
    code: '+234',
    flag: '🇳🇬',
    name: 'Nigeria',
  },
  {
    code: '+254',
    flag: '🇰🇪',
    name: 'Kenya',
  },
];
export default function PhoneSignUpScreen({ navigation }) {
  const [selectedCountry, setSelectedCountry] = useState(
    COUNTRY_CODES.find((c) => c.code === '+1' && c.name === 'United States') ?? COUNTRY_CODES[0],
  );
  const [phone, setPhone] = useState('');
  const [pickerVisible, setPickerVisible] = useState(false);
  const [search, setSearch] = useState('');
  const [focused, setFocused] = useState(false);
  const [loading, setLoading] = useState(false);
  const filteredCountries = COUNTRY_CODES.filter(
    (c) => c.name.toLowerCase().includes(search.toLowerCase()) || c.code.includes(search),
  );
  const fullNumber = `${selectedCountry.code}${phone.trim()}`;
  const handleSendOtp = async () => {
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 7) {
      showAlert('Invalid number', 'Please enter a valid phone number.');
      return;
    }
    setLoading(true);
    try {
      await authApi.sendPhoneOtp(fullNumber);
      navigation.navigate('PhoneVerification', {
        phone: fullNumber,
      });
    } catch (e) {
      const msg = e?.response?.data?.error || 'Could not send the code. Please try again.';
      showAlert('Error', msg);
    } finally {
      setLoading(false);
    }
  };
  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor={colors.bgApp} />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={KEYBOARD_BEHAVIOR}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Top bar: back chevron + 7-segment progress */}
          <View style={styles.topbar}>
            <TouchableOpacity
              style={styles.backBtn}
              onPress={() => {
                if (navigation.canGoBack?.()) {
                  navigation.goBack();
                } else {
                  navigation.navigate('SignIn');
                }
              }}
              hitSlop={{
                top: 10,
                bottom: 10,
                left: 10,
                right: 10,
              }}
            >
              <Svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                <Path
                  d="M15 5l-7 7 7 7"
                  stroke={colors.textPrimary}
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </Svg>
            </TouchableOpacity>
            {/* Phone flow = 2 steps: number → verify */}
            <View style={styles.progress}>
              {Array.from({
                length: 2,
              }).map((_, i) => (
                <View key={i} style={[styles.seg, i < 1 && styles.segOn]} />
              ))}
            </View>
          </View>

          <Text style={styles.heading}>What's your number?</Text>
          <Text style={styles.subtitle}>We'll send a one-time code to verify it's you.</Text>

          {/* Phone input */}
          <View style={styles.fieldGroup}>
            <Text style={styles.label}>Phone number</Text>
            <View style={[styles.phoneRow, focused && styles.phoneRowFocused]}>
              {/* Country picker trigger */}
              <TouchableOpacity
                style={styles.countryTrigger}
                onPress={() => setPickerVisible(true)}
                activeOpacity={0.7}
              >
                <Text style={styles.countryFlag}>{selectedCountry.flag}</Text>
                <Text style={styles.countryCode}>{selectedCountry.code}</Text>
                <Text style={styles.chevron}>▾</Text>
              </TouchableOpacity>

              <View style={styles.phoneDivider} />

              <TextInput
                style={styles.phoneInput}
                value={phone}
                onChangeText={(v) => setPhone(v.replace(/[^\d\s\-()]/g, ''))}
                placeholder="98765 43210"
                placeholderTextColor={colors.placeholderWarm}
                keyboardType="phone-pad"
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                autoCorrect={false}
              />
            </View>

            {/* Full number preview */}
            {phone.trim().length > 0 && (
              <Text style={styles.preview}>Sending OTP to {fullNumber}</Text>
            )}
          </View>

          {/* CTA + links pinned to bottom */}
          <View style={styles.footer}>
            <TouchableOpacity
              style={[styles.primaryBtn, loading && styles.primaryBtnDisabled]}
              onPress={handleSendOtp}
              activeOpacity={0.85}
              disabled={loading}
            >
              <GoldFill radius={27} disabled={loading} />
              {loading ? (
                <ActivityIndicator color={colors.onAccent} />
              ) : (
                <Text style={styles.primaryText}>Send OTP</Text>
              )}
            </TouchableOpacity>

            <Text style={styles.note}>Standard SMS rates may apply.</Text>

            <View style={styles.bottomLink}>
              <Text style={styles.linkMuted}>Already a member? </Text>
              <TouchableOpacity
                onPress={() => navigation.navigate('SignIn')}
                hitSlop={{
                  top: 8,
                  bottom: 8,
                  left: 4,
                  right: 4,
                }}
              >
                <Text style={styles.linkBold}>Sign in</Text>
              </TouchableOpacity>
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>

      {/* Country picker — bottom sheet modal */}
      <Modal
        visible={pickerVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => {
          setPickerVisible(false);
          setSearch('');
        }}
        statusBarTranslucent
        navigationBarTranslucent
      >
        <SafeAreaView style={styles.modalContainer}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Select country</Text>
            <TouchableOpacity
              onPress={() => {
                setPickerVisible(false);
                setSearch('');
              }}
              hitSlop={{
                top: 8,
                bottom: 8,
                left: 8,
                right: 8,
              }}
            >
              <Text style={styles.modalClose}>Done</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.searchWrap}>
            <TextInput
              style={styles.searchInput}
              value={search}
              onChangeText={setSearch}
              placeholder="Search country or dialling code"
              placeholderTextColor={colors.placeholderWarm}
              autoCorrect={false}
              clearButtonMode="while-editing"
            />
          </View>

          <FlatList
            data={filteredCountries}
            keyExtractor={(item, index) => `${item.code}-${item.name}-${index}`}
            renderItem={({ item }) => (
              <TouchableOpacity
                style={[
                  styles.countryRow,
                  item.name === selectedCountry.name && styles.countryRowSelected,
                ]}
                onPress={() => {
                  setSelectedCountry(item);
                  setPickerVisible(false);
                  setSearch('');
                }}
                activeOpacity={0.7}
              >
                <Text style={styles.rowFlag}>{item.flag}</Text>
                <Text style={styles.rowName}>{item.name}</Text>
                <Text style={styles.rowCode}>{item.code}</Text>
                {item.name === selectedCountry.name && <Text style={styles.rowCheck}>✓</Text>}
              </TouchableOpacity>
            )}
            ItemSeparatorComponent={() => <View style={styles.rowSeparator} />}
            keyboardShouldPersistTaps="handled"
          />
        </SafeAreaView>
      </Modal>
    </View>
  );
}
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgApp,
  },
  flex: {
    flex: 1,
  },
  scroll: {
    flexGrow: 1,
    paddingTop: Platform.OS === 'ios' ? 52 : 36,
    paddingHorizontal: 24,
    paddingBottom: 36,
  },
  footer: {
    marginTop: 'auto',
    paddingTop: 24,
  },
  // Top bar — back chevron + 7-segment progress (wizard style)
  topbar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 22,
  },
  backBtn: {
    width: 32,
    height: 32,
    minWidth: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  progress: {
    flex: 1,
    flexDirection: 'row',
    gap: 6,
  },
  seg: {
    flex: 1,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.surfaceDark,
  },
  segOn: {
    backgroundColor: colors.surfaceRaised,
  },
  // Heading — shared auth typography
  heading: {
    fontFamily: fonts.displayBold,
    fontSize: 25,
    lineHeight: 32,
    fontWeight: '700',
    letterSpacing: -0.4,
    color: colors.textPrimary,
    marginTop: 4,
    marginBottom: 10,
  },
  subtitle: {
    fontFamily: fonts.body,
    fontSize: 14.5,
    lineHeight: 21,
    color: colors.textSecondaryWarm,
    marginBottom: 28,
    maxWidth: 310,
  },
  // Field
  fieldGroup: {
    gap: 8,
  },
  label: {
    fontFamily: fonts.bodyBold,
    fontSize: 12.5,
    lineHeight: 12.5,
    fontWeight: '700',
    letterSpacing: 0.3,
    color: colors.labelWarm,
    marginBottom: 8,
  },
  // Phone row — country trigger + text input, standard 52px r14 input
  phoneRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radius.card,
    borderWidth: 1.5,
    borderColor: colors.fieldBorder,
    overflow: 'hidden',
  },
  phoneRowFocused: {
    borderColor: colors.goldWarm,
    borderWidth: 2,
  },
  countryTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 16,
    paddingRight: 10,
    gap: 5,
    height: 52,
  },
  countryFlag: {
    fontSize: 16,
  },
  countryCode: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 13,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  chevron: {
    fontSize: 10,
    color: colors.textSecondaryWarm,
    marginTop: 1,
  },
  phoneDivider: {
    width: 1,
    height: 22,
    backgroundColor: colors.fieldBorder,
  },
  phoneInput: {
    flex: 1,
    height: 52,
    paddingHorizontal: 14,
    fontSize: 16,
    color: colors.textPrimary,
  },
  preview: {
    fontFamily: fonts.body,
    fontSize: 12,
    color: colors.textSecondaryWarm,
    marginTop: 6,
    marginLeft: 4,
  },
  // CTA — gold pill
  primaryBtn: {
    height: 54,
    backgroundColor: colors.gold,
    borderRadius: 27,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
    ...goldButton.glow,
  },
  primaryBtnDisabled: {
    opacity: 0.7,
  },
  primaryText: {
    fontFamily: fonts.bodyBold,
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 0.2,
    color: colors.onAccent,
  },
  note: {
    fontFamily: fonts.body,
    fontSize: 11,
    color: colors.textSecondaryWarm,
    textAlign: 'center',
    marginBottom: 24,
  },
  bottomLink: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  linkMuted: {
    fontFamily: fonts.body,
    fontSize: 13,
    color: colors.textSecondaryWarm,
  },
  linkBold: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 13,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  // ── Country picker modal ──────────────────────────────
  modalContainer: {
    flex: 1,
    backgroundColor: colors.bgApp,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: withAlpha(colors.textPrimary, 0.08),
  },
  modalTitle: {
    fontFamily: fonts.bodyBold,
    fontSize: 16,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  modalClose: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 14,
    fontWeight: '600',
    color: colors.goldWarm,
  },
  searchWrap: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: withAlpha(colors.textPrimary, 0.06),
  },
  searchInput: {
    height: 40,
    backgroundColor: colors.surface,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: colors.fieldBorder,
    paddingHorizontal: 14,
    fontSize: 14,
    color: colors.textPrimary,
  },
  countryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 14,
    gap: 12,
  },
  countryRowSelected: {
    backgroundColor: colors.goldTint,
  },
  rowFlag: {
    fontSize: 22,
  },
  rowName: {
    fontFamily: fonts.body,
    flex: 1,
    fontSize: 14,
    color: colors.textPrimary,
    fontWeight: '400',
  },
  rowCode: {
    fontFamily: fonts.bodyMedium,
    fontSize: 13,
    color: colors.textSecondaryWarm,
    fontWeight: '500',
  },
  rowCheck: {
    fontSize: 14,
    color: colors.goldWarm,
    fontWeight: '700',
    marginLeft: 6,
  },
  rowSeparator: {
    height: 1,
    backgroundColor: withAlpha(colors.textPrimary, 0.05),
    marginLeft: 54,
  },
});
