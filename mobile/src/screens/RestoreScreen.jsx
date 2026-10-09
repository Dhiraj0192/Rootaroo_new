/** RestoreScreen — new phone: emailed code, then the backup password or recovery code. */
import React, { useEffect, useState } from 'react';
import { usePrivateSpaceStore } from '../shared/store/privateSpaceStore';
import { Shell, PrimaryButton, SecondaryButton, Field, Title, Body, ErrorText } from '../shared/components/PrivateSpaceUi';

export default function RestoreScreen({ navigation }) {
  const restore = usePrivateSpaceStore((s) => s.restore);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    usePrivateSpaceStore.getState().startRestore();
    return () => usePrivateSpaceStore.getState().closeRestore();
  }, []);

  const store = usePrivateSpaceStore.getState();
  const leave = () => navigation.goBack();
  const step = restore?.step ?? 'email';
  const recovery = restore?.kind === 'recovery_code';

  const run = async (fn) => {
    setBusy(true);
    try { await fn(); } finally { setBusy(false); setValue(''); }
  };

  return (
    <Shell title="Restore from backup" onBack={leave}>
      {step === 'email' && (
        <>
          <Title>Check your email</Title>
          <Body>We sent a 6-digit code to the email on your account.</Body>
          <Field placeholder="6-digit code" keyboardType="number-pad" maxLength={6} value={value} onChangeText={setValue} accessibilityLabel="Email code" />
          <ErrorText>{restore?.error}</ErrorText>
          <PrimaryButton label="Continue" disabled={value.length !== 6} loading={busy} onPress={() => run(() => store.submitEmailCode(value))} />
          <SecondaryButton label="Send a new code" onPress={() => store.startRestore()} />
        </>
      )}

      {step === 'secret' && (
        <>
          <Title>{recovery ? 'Enter your recovery code' : 'Enter your backup password'}</Title>
          <Field
            placeholder={recovery ? 'XXXX-XXXX-XXXX-XXXX-XXXX-XXXX' : 'Backup password'}
            secureTextEntry={!recovery}
            autoCapitalize={recovery ? 'characters' : 'none'}
            value={value}
            onChangeText={setValue}
            accessibilityLabel={recovery ? 'Recovery code' : 'Backup password'}
          />
          <ErrorText>{restore.error}</ErrorText>
          {restore.error && restore.attemptsLeft != null && (
            <Body>{`${restore.attemptsLeft} ${restore.attemptsLeft === 1 ? 'try' : 'tries'} left. After that the backup is erased for good.`}</Body>
          )}
          <PrimaryButton label="Restore" disabled={!value} loading={busy} onPress={() => run(() => store.submitSecret(value))} />
        </>
      )}

      {step === 'erased' && (
        <>
          <Title>This backup was erased</Title>
          <Body>After 10 wrong guesses the backup is deleted for good. Rootaroo cannot recover your journal and vault. If your old phone still works, you can move your private space from it instead.</Body>
          <PrimaryButton label="OK" onPress={leave} />
        </>
      )}

      {step === 'done' && (
        <>
          <Title>Your private space is back</Title>
          <Body>Your journal and vault now open on this phone. Your old phone has been signed out.</Body>
          <PrimaryButton label="Done" onPress={leave} />
        </>
      )}
    </Shell>
  );
}
