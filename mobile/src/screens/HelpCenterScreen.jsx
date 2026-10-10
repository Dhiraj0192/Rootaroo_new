import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  StatusBar,
  Linking,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, fonts, radius } from '../shared/theme';
import { useTabBarDockHeight } from '../shared/hooks/useTabBarDockHeight';
// Same address as the privacy policy and terms on rootaroo.com.
const SUPPORT_EMAIL = 'contact@rootaroo.com';
const FAQS = [
  {
    question: 'How do I create or join a household?',
    answer:
      'From onboarding, choose "Create a household" to start a new one, or "Join" and enter the invite code someone in your household sent you. You can only belong to one household at a time.',
  },
  {
    question: 'What happens to my journal and vault if I lose my phone?',
    answer:
      'Your journal and vault are encrypted on your phone with your private-space key, which we never see. To open them on a new phone, move the key with the QR code from your old phone, or restore it from your backup password or recovery code in Privacy & security. Without the old phone or a backup, neither you nor we can open them again (Household vault files stay with your family). So set up a backup when Rootaroo asks.',
  },
  {
    question: 'How does location sharing work?',
    answer:
      'Location is only shared when you choose to. A check-in shares where you are once. A live share sends your location to the people you pick until the timer ends (8 hours at most) or you stop it. If you allow location "all the time", a live share keeps updating in the background, even when the app is closed, and only while that share runs. "Request location" asks someone to share theirs; they decide whether to accept.',
  },
  {
    question: 'Can I remove someone from my household?',
    answer:
      'Admins can remove members from Household Settings. This revokes their access to future content, chat, and Vault documents, but doesn’t undo anything they already saw or saved before removal.',
  },
  {
    question: 'How do I delete my account or household?',
    answer:
      'Go to Household Settings (for the household) or your profile (for your account) and choose Delete. You can schedule deletion 30 days out and cancel anytime in that window, or delete immediately.',
  },
  {
    question: 'Why didn’t I get a push notification?',
    answer:
      'Check that notifications are enabled for Rootaroo in your phone’s system settings, and that the specific notification type is turned on in Notification Preferences.',
  },
];
export default function HelpCenterScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const dockHeight = useTabBarDockHeight();
  const [openIndex, setOpenIndex] = useState(null);
  return (
    <View
      style={[
        styles.root,
        {
          paddingTop: insets.top,
        },
      ]}
    >
      <StatusBar barStyle="light-content" backgroundColor={colors.canvas} />
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => navigation.goBack()}
          hitSlop={{
            top: 8,
            bottom: 8,
            left: 8,
            right: 8,
          }}
        >
          <Text style={styles.backIcon}>‹</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Help Center</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.scrollContent,
          {
            paddingBottom: dockHeight + 16,
          },
        ]}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.sectionLabel}>Frequently asked</Text>
        {FAQS.map((faq, i) => {
          const open = openIndex === i;
          return (
            <TouchableOpacity
              key={faq.question}
              style={styles.faqRow}
              onPress={() => setOpenIndex(open ? null : i)}
              activeOpacity={0.7}
            >
              <View style={styles.faqQuestionRow}>
                <Text style={styles.faqQuestion}>{faq.question}</Text>
                <Text style={styles.faqChevron}>{open ? '−' : '+'}</Text>
              </View>
              {open && <Text style={styles.faqAnswer}>{faq.answer}</Text>}
            </TouchableOpacity>
          );
        })}

        <Text style={styles.sectionLabel}>Still stuck?</Text>
        <TouchableOpacity
          style={styles.contactCard}
          onPress={() => Linking.openURL(`mailto:${SUPPORT_EMAIL}`)}
          activeOpacity={0.8}
        >
          <Text style={styles.contactTitle}>Contact support</Text>
          <Text style={styles.contactEmail}>{SUPPORT_EMAIL}</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}
const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.canvas,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: 56,
    paddingHorizontal: 24,
  },
  backBtn: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backIcon: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.ink,
    lineHeight: 26,
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: '700',
    fontFamily: fonts.displayBold,
    color: colors.ink,
  },
  headerSpacer: {
    width: 32,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 24,
    paddingTop: 8,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: '600',
    fontFamily: fonts.bodySemiBold,
    letterSpacing: 0.4,
    color: colors.textMuted,
    textTransform: 'uppercase',
    marginTop: 20,
    marginBottom: 10,
  },
  faqRow: {
    backgroundColor: colors.surface,
    borderRadius: radius.card,
    padding: 16,
    marginBottom: 8,
  },
  faqQuestionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  faqQuestion: {
    flex: 1,
    fontSize: 14,
    fontFamily: fonts.bodySemiBold,
    color: colors.ink,
  },
  faqChevron: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.goldDeep,
  },
  faqAnswer: {
    fontSize: 13,
    lineHeight: 19,
    fontFamily: fonts.body,
    color: colors.textSecondary,
    marginTop: 10,
  },
  contactCard: {
    backgroundColor: colors.goldTint,
    borderRadius: radius.card,
    padding: 16,
  },
  contactTitle: {
    fontSize: 14,
    fontFamily: fonts.bodySemiBold,
    color: colors.ink,
    marginBottom: 3,
  },
  contactEmail: {
    fontSize: 13,
    fontFamily: fonts.body,
    color: colors.goldDeep,
  },
});
