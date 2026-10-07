import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useJournalLockStore } from '../store/journalLockStore';
import { colors, fonts, radius, spacing } from '../theme';

export default function JournalLockGate({ children }) {
  const enabled = useJournalLockStore((s) => s.enabled);
  const locked = useJournalLockStore((s) => s.locked);
  const load = useJournalLockStore((s) => s.load);
  const unlock = useJournalLockStore((s) => s.unlock);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (enabled === null) load();
  }, [enabled, load]);

  const attempt = () => {
    unlock().then((ok) => setFailed(!ok));
  };

  // Prompt once each time the gate becomes locked.
  const wasLocked = useRef(false);
  useEffect(() => {
    if (locked && !wasLocked.current) attempt();
    wasLocked.current = locked;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locked]);

  if (enabled === null) {
    return (
      <View style={styles.root}>
        <ActivityIndicator color={colors.gold} />
      </View>
    );
  }

  if (locked) {
    return (
      <View style={styles.root}>
        <Ionicons name="lock-closed" size={44} color={colors.gold} />
        <Text style={styles.title}>Your journal is locked</Text>
        {failed && <Text style={styles.error}>Couldn't unlock. Try again.</Text>}
        <TouchableOpacity style={styles.button} onPress={attempt} accessibilityRole="button" accessibilityLabel="Unlock journal">
          <Text style={styles.buttonText}>Unlock</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return children;
}

export function withJournalLock(Component) {
  function Wrapped(props) {
    return (
      <JournalLockGate>
        <Component {...props} />
      </JournalLockGate>
    );
  }
  Wrapped.displayName = `withJournalLock(${Component.displayName || Component.name || 'Screen'})`;
  return Wrapped;
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.canvas,
    paddingHorizontal: 16,
    gap: spacing.md,
  },
  title: {
    fontSize: 20,
    fontFamily: fonts.display,
    color: colors.ink,
    marginTop: 8,
  },
  error: {
    fontSize: 14,
    fontFamily: fonts.body,
    color: colors.danger,
  },
  button: {
    marginTop: 8,
    paddingVertical: 12,
    paddingHorizontal: 28,
    borderRadius: radius.card,
    backgroundColor: colors.gold,
  },
  buttonText: {
    fontSize: 16,
    fontFamily: fonts.body,
    color: colors.canvas,
    fontWeight: '700',
  },
});
