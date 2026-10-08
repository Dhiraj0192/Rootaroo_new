import React, { useEffect } from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import Svg, { Rect, Path } from 'react-native-svg';
import { usePrivateSpaceStore } from '../store/privateSpaceStore';
import { colors, fonts, spacing } from '../theme';
import { PrimaryButton, SecondaryButton } from './PrivateSpaceUi';

const COPY = {
  none: { title: 'Set up your private space', body: 'Your journal and vault are locked with a key that stays on your phone.' },
  elsewhere: { title: 'Your private space is on another phone', body: 'Move it here from that phone, or restore it from your backup.' },
};

export default function PrivateSpaceGate({ navigation, children }) {
  const status = usePrivateSpaceStore((s) => s.status);
  const hasBackup = usePrivateSpaceStore((s) => s.hasBackup);
  const error = usePrivateSpaceStore((s) => s.error);
  const refresh = usePrivateSpaceStore((s) => s.refresh);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (status === 'here') return children;

  const back = navigation?.canGoBack?.() ? <SecondaryButton label="Back" onPress={() => navigation.goBack()} /> : null;

  if (status === 'unknown') {
    return (
      <View style={styles.root}>
        {error ? (
          <>
            <Text style={styles.body}>{error}</Text>
            <PrimaryButton label="Try again" onPress={refresh} />
            {back}
          </>
        ) : (
          <ActivityIndicator color={colors.gold} />
        )}
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <Svg width={64} height={64} viewBox="0 0 130 130" style={styles.icon}>
        <Rect x="30" y="55" width="70" height="55" rx="10" stroke={colors.gold} strokeWidth="4" fill="none" />
        <Path d="M45 55 V38 a20 20 0 0 1 40 0 V55" stroke={colors.gold} strokeWidth="4" fill="none" />
      </Svg>
      <Text style={styles.title}>{COPY[status].title}</Text>
      <Text style={styles.body}>{COPY[status].body}</Text>
      {status === 'none' ? (
        <PrimaryButton label="Set up" onPress={() => navigation.navigate('PrivateSpaceSetup')} />
      ) : (
        <>
          <PrimaryButton label="Move it here" onPress={() => navigation.navigate('MoveHere')} />
          {hasBackup
            ? <SecondaryButton label="Restore from backup" onPress={() => navigation.navigate('Restore')} />
            : <Text style={styles.body}>There is no backup, so it can only be moved from the other phone.</Text>}
        </>
      )}
      {back}
    </View>
  );
}

export function withPrivateSpace(Component) {
  function Wrapped(props) {
    return (
      <PrivateSpaceGate navigation={props.navigation}>
        <Component {...props} />
      </PrivateSpaceGate>
    );
  }
  Wrapped.displayName = `withPrivateSpace(${Component.displayName || Component.name || 'Screen'})`;
  return Wrapped;
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: 'center',
    backgroundColor: colors.canvas,
    paddingHorizontal: 24,
    gap: spacing.md,
  },
  icon: { alignSelf: 'center' },
  title: { fontSize: 20, fontFamily: fonts.display, color: colors.ink, textAlign: 'center' },
  body: { fontSize: 14, lineHeight: 21, fontFamily: fonts.body, color: colors.textSecondary, textAlign: 'center' },
});
