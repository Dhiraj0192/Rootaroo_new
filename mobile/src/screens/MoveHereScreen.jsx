/** MoveHereScreen — new phone: show a QR, compare the code, take over the private space. */
import React, { useEffect } from 'react';
import { View, Text, ActivityIndicator } from 'react-native';
import QRCodeSvg from 'react-native-qrcode-svg';
import { usePrivateSpaceStore } from '../shared/store/privateSpaceStore';
import { colors } from '../shared/theme';
import { Shell, PrimaryButton, SecondaryButton, Title, Body, ErrorText, ui } from '../shared/components/PrivateSpaceUi';

export default function MoveHereScreen({ navigation }) {
  const moving = usePrivateSpaceStore((s) => s.moving);
  const step = moving?.step ?? 'starting';

  useEffect(() => {
    usePrivateSpaceStore.getState().startMoveHere();
    return () => usePrivateSpaceStore.getState().cancelMove();
  }, []);

  const leave = () => navigation.goBack();
  const store = usePrivateSpaceStore.getState();

  return (
    <Shell title="Move it here" onBack={leave}>
      {step === 'starting' && <ActivityIndicator color={colors.gold} />}

      {step === 'qr' && (
        <>
          <Body>Open Rootaroo on your old phone → Privacy & security → Move to a new phone, then scan this code.</Body>
          <View style={{ alignSelf: 'center', padding: 14, borderRadius: 16, backgroundColor: colors.white }}>
            <QRCodeSvg value={moving.qr} size={220} color={colors.black} backgroundColor={colors.white} />
          </View>
          <Body center>This code works for 5 minutes. Waiting for your old phone…</Body>
        </>
      )}

      {step === 'compare' && (
        <>
          <Title>Do the codes match?</Title>
          <Body>Your old phone should show this same code.</Body>
          <View style={ui.card}><Text style={ui.big}>{moving.code}</Text></View>
          <PrimaryButton label="They match" onPress={() => store.confirmMove()} />
          <SecondaryButton label="They're different" danger onPress={() => { store.cancelMove(); leave(); }} />
        </>
      )}

      {step === 'done' && (
        <>
          <Title>Your private space is here</Title>
          <Body>Your journal and vault now open on this phone. Your old phone has been signed out.</Body>
          <PrimaryButton label="Done" onPress={leave} />
        </>
      )}

      {step === 'failed' && (
        <>
          <Title>That didn't work</Title>
          <ErrorText>{moving.error}</ErrorText>
          <PrimaryButton label="Try again" onPress={() => store.startMoveHere()} />
        </>
      )}
    </Shell>
  );
}
