import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, StatusBar, ActivityIndicator, TextInput } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BottomTabBarHeightContext } from '@react-navigation/bottom-tabs';
import { colors, fonts, radius } from '../theme';
import { GoldFill } from './GoldButton';
import { KeyboardAvoider, keyboardScrollProps } from './KeyboardAware';

/** Header with a back button, then a scrolling body. Shared by the private-space screens. */
export function Shell({ title, onBack, children }) {
  // Inside the tabs the floating tab bar sits over the content; outside it the context is undefined.
  const tabBarHeight = React.useContext(BottomTabBarHeightContext) || 0;
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <StatusBar barStyle="light-content" backgroundColor={colors.canvas} />
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={onBack} accessibilityRole="button" accessibilityLabel="Back">
          <Text style={styles.backIcon}>‹</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{title}</Text>
      </View>
      <KeyboardAvoider>
        <ScrollView
          contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + tabBarHeight + 32 }]}
          {...keyboardScrollProps}
          showsVerticalScrollIndicator={false}
        >
          {children}
        </ScrollView>
      </KeyboardAvoider>
    </View>
  );
}

export function PrimaryButton({ label, onPress, disabled, loading }) {
  const off = disabled || loading;
  return (
    <TouchableOpacity
      style={[styles.primary, off && styles.off]}
      onPress={onPress}
      disabled={off}
      activeOpacity={0.85}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <GoldFill radius={radius.pill} disabled={off} />
      {loading ? <ActivityIndicator size="small" color={colors.onAccent} /> : <Text style={styles.primaryText}>{label}</Text>}
    </TouchableOpacity>
  );
}

export function SecondaryButton({ label, onPress, danger }) {
  return (
    <TouchableOpacity style={styles.secondary} onPress={onPress} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel={label}>
      <Text style={[styles.secondaryText, danger && { color: colors.danger }]}>{label}</Text>
    </TouchableOpacity>
  );
}

export function Field(props) {
  return <TextInput placeholderTextColor={colors.textMuted} autoCapitalize="none" autoCorrect={false} {...props} style={[styles.input, props.style]} />;
}

export const Title = ({ children }) => <Text style={styles.title}>{children}</Text>;
export const Body = ({ children, center }) => <Text style={[styles.body, center && styles.center]}>{children}</Text>;
export const ErrorText = ({ children }) => (children ? <Text style={styles.error}>{children}</Text> : null);

export const ui = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderCool,
    borderRadius: radius.xl,
    padding: 16,
    gap: 6,
  },
  cardSelected: { borderColor: colors.gold },
  cardTitle: { fontSize: 16, fontFamily: fonts.bodySemiBold, color: colors.ink },
  cardBody: { fontSize: 13, lineHeight: 19, fontFamily: fonts.body, color: colors.textMuted },
  stack: { gap: 12 },
  big: { fontSize: 40, letterSpacing: 6, fontFamily: fonts.displayBold, color: colors.gold, textAlign: 'center' },
});

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
  header: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 20, paddingVertical: 14 },
  backBtn: {
    width: 42,
    height: 42,
    borderRadius: radius.card,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backIcon: { fontSize: 26, fontWeight: '700', color: colors.ink, lineHeight: 28, marginLeft: -2 },
  headerTitle: { flex: 1, fontSize: 24, lineHeight: 30, fontFamily: fonts.display, color: colors.ink, letterSpacing: -0.4 },
  content: { paddingHorizontal: 20, paddingTop: 8, gap: 14 },
  title: { fontSize: 22, lineHeight: 28, fontFamily: fonts.displayBold, color: colors.ink },
  body: { fontSize: 14, lineHeight: 21, fontFamily: fonts.body, color: colors.textSecondary },
  center: { textAlign: 'center' },
  error: { fontSize: 14, fontFamily: fonts.bodySemiBold, color: colors.danger },
  input: {
    height: 52,
    borderRadius: radius.card,
    backgroundColor: colors.surface,
    borderWidth: 1.5,
    borderColor: colors.border,
    paddingHorizontal: 16,
    fontSize: 15,
    fontFamily: fonts.body,
    color: colors.ink,
  },
  primary: { height: 54, borderRadius: radius.pill, backgroundColor: colors.gold, alignItems: 'center', justifyContent: 'center' },
  primaryText: { fontSize: 15, fontFamily: fonts.displayBold, color: colors.onAccent },
  off: { opacity: 0.5 },
  secondary: { height: 48, alignItems: 'center', justifyContent: 'center' },
  secondaryText: { fontSize: 15, fontFamily: fonts.bodySemiBold, color: colors.gold },
});
