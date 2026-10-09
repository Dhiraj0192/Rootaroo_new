/** ApproveMoveScreen — old phone: scan the new phone's QR, compare the code, approve with biometrics. */
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { CameraView } from 'expo-camera';
import { ensureCamera } from '../shared/permissions';
import { usePrivateSpaceStore } from '../shared/store/privateSpaceStore';
import { colors, radius } from '../shared/theme';
import { Shell, PrimaryButton, SecondaryButton, Title, Body, ErrorText, ui } from '../shared/components/PrivateSpaceUi';

export default function ApproveMoveScreen({ navigation }) {
  const [step, setStep] = useState('permission'); // permission | denied | scan | working | compare | sending | done
  const [error, setError] = useState('');
  const [code, setCode] = useState('');
  const confirmRef = useRef(null);
  const scannedRef = useRef(false);

  useEffect(() => {
    let live = true;
    ensureCamera().then((ok) => live && setStep(ok ? 'scan' : 'denied'));
    return () => { live = false; };
  }, []);

  const onScanned = async ({ data }) => {
    if (scannedRef.current) return;
    scannedRef.current = true;
    setStep('working');
    try {
      const { code: sas, confirm } = await usePrivateSpaceStore.getState().approveMove(data);
      confirmRef.current = confirm;
      setCode(sas);
      setError('');
      setStep('compare');
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || "Couldn't read that code");
      setStep('scan');
      scannedRef.current = false;
    }
  };

  const approve = async () => {
    setStep('sending');
    setError('');
    try {
      await confirmRef.current();
      setStep('done');
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || "Couldn't send your private space");
      setStep('compare');
    }
  };

  const leave = () => navigation.goBack();

  return (
    <Shell title="Move to a new phone" onBack={leave}>
      {step === 'denied' && (
        <>
          <Body>Allow camera access to scan the code on your new phone.</Body>
          <SecondaryButton label="Try again" onPress={() => ensureCamera().then((ok) => ok && setStep('scan'))} />
        </>
      )}

      {step === 'scan' && (
        <>
          <Body>On your new phone choose "Move it here", then point this camera at its code.</Body>
          <View style={styles.camera}>
            <CameraView
              style={StyleSheet.absoluteFill}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={onScanned}
            />
          </View>
          <ErrorText>{error}</ErrorText>
        </>
      )}

      {(step === 'permission' || step === 'working' || step === 'sending') && <ActivityIndicator color={colors.gold} />}

      {step === 'compare' && (
        <>
          <Title>Do the codes match?</Title>
          <Body>Your new phone shows the same code once you approve. Only approve a phone that is yours and in your hand.</Body>
          <View style={ui.card}><Text style={ui.big}>{code}</Text></View>
          <ErrorText>{error}</ErrorText>
          <PrimaryButton label="Approve" onPress={approve} />
          <SecondaryButton label="Cancel" onPress={leave} />
        </>
      )}

      {step === 'done' && (
        <>
          <Title>Sent to your new phone</Title>
          <Body>Once the new phone confirms, this phone is signed out and forgets your private space.</Body>
          <PrimaryButton label="Done" onPress={leave} />
        </>
      )}
    </Shell>
  );
}

const styles = StyleSheet.create({
  camera: { height: 320, borderRadius: radius.xl, overflow: 'hidden', backgroundColor: colors.black },
});
