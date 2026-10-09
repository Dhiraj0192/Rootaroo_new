/**
 * PrivateSpaceSetupScreen — first-time setup of the account key, or (with
 * route.params.mode === 'backup') changing how it is backed up.
 */
import React, { useState } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { showAlert } from '../shared/services/themedAlert';
import { usePrivateSpaceStore } from '../shared/store/privateSpaceStore';
import { MIN_PASSWORD_LENGTH } from '../shared/crypto/keyBackup';
import { colors } from '../shared/theme';
import { Shell, PrimaryButton, SecondaryButton, Field, Body, ErrorText, ui } from '../shared/components/PrivateSpaceUi';

const OPTIONS = [
  { key: 'password', title: 'Backup password', body: `At least ${MIN_PASSWORD_LENGTH} characters. A pet's name is fine, because guesses are capped at 10.` },
  { key: 'recovery_code', title: 'Use a recovery code instead', body: 'We show you a code once. Keep it somewhere safe.' },
  { key: 'none', title: 'No backup', body: 'If you lose this phone, your journal and vault are gone for good.' },
];

export default function PrivateSpaceSetupScreen({ navigation, route }) {
  const changing = route?.params?.mode === 'backup';
  const [choice, setChoice] = useState('password');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [recoveryCode, setRecoveryCode] = useState(null);
  const [saved, setSaved] = useState(false);

  const options = changing ? OPTIONS.map((o) => (o.key === 'none' ? { ...o, title: 'Remove backup' } : o)) : OPTIONS;
  const leave = () => navigation.goBack();

  const run = async () => {
    setBusy(true);
    setError('');
    const store = usePrivateSpaceStore.getState();
    try {
      const args = { backup: choice, secret: password };
      const { recoveryCode: code } = changing ? await store.changeBackup(args) : await store.setUp(args);
      if (code) setRecoveryCode(code);
      else leave();
    } catch (e) {
      if (!changing && usePrivateSpaceStore.getState().status === 'here') {
        showAlert('Backup not saved', 'Your private space is ready, but the backup could not be saved. You can add one in Privacy & security.', [{ text: 'OK', onPress: leave }]);
      } else if (e?.response?.status === 409) {
        await store.refresh();
        leave();
      } else {
        setError(e?.response?.data?.message || e?.message || 'Something went wrong. Try again.');
      }
    } finally {
      setBusy(false);
    }
  };

  const submit = () => {
    if (choice === 'password') {
      if (password.length < MIN_PASSWORD_LENGTH) return setError(`Use at least ${MIN_PASSWORD_LENGTH} characters`);
      if (password !== confirm) return setError('The two passwords do not match');
    }
    if (choice === 'none') {
      return showAlert(
        changing ? 'Remove your backup?' : 'Continue without a backup?',
        'If you lose this phone, your journal and vault cannot be recovered. Rootaroo cannot get them back for you.',
        [
          { text: 'Go back', style: 'cancel' },
          { text: 'No backup', style: 'destructive', onPress: run },
        ],
      );
    }
    return run();
  };

  if (recoveryCode) {
    return (
      <Shell title="Your recovery code" onBack={leave}>
        <Body>Write this down or store it in a password manager. It is shown only once, and without it or your phone your data cannot be recovered.</Body>
        <View style={ui.card}>
          <Text selectable style={[ui.cardTitle, { fontSize: 20, textAlign: 'center', letterSpacing: 1 }]}>{recoveryCode}</Text>
        </View>
        <SecondaryButton label="Copy code" onPress={() => Clipboard.setStringAsync(recoveryCode)} />
        <TouchableOpacity
          style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}
          onPress={() => setSaved((v) => !v)}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: saved }}
          accessibilityLabel="I saved it"
        >
          <View style={{ width: 24, height: 24, borderRadius: 6, borderWidth: 2, borderColor: colors.gold, backgroundColor: saved ? colors.gold : 'transparent' }} />
          <Text style={ui.cardTitle}>I saved it</Text>
        </TouchableOpacity>
        <PrimaryButton label="Done" disabled={!saved} onPress={leave} />
      </Shell>
    );
  }

  return (
    <Shell title={changing ? 'Backup' : 'Set up your private space'} onBack={leave}>
      <Body>Rootaroo can't read your journal or vault, and can't reset this password.</Body>
      <View style={ui.stack}>
        {options.map((o) => (
          <TouchableOpacity
            key={o.key}
            style={[ui.card, choice === o.key && ui.cardSelected]}
            onPress={() => { setChoice(o.key); setError(''); }}
            accessibilityRole="radio"
            accessibilityState={{ selected: choice === o.key }}
            accessibilityLabel={o.title}
          >
            <Text style={ui.cardTitle}>{o.title}</Text>
            <Text style={ui.cardBody}>{o.body}</Text>
          </TouchableOpacity>
        ))}
        {choice === 'password' && (
          <>
            <Field placeholder="Backup password" secureTextEntry value={password} onChangeText={setPassword} accessibilityLabel="Enter backup password" />
            <Field placeholder="Confirm password" secureTextEntry value={confirm} onChangeText={setConfirm} accessibilityLabel="Confirm password" />
          </>
        )}
      </View>
      <ErrorText>{error}</ErrorText>
      <PrimaryButton label={changing ? 'Save backup' : 'Create my private space'} onPress={submit} loading={busy} />
    </Shell>
  );
}
