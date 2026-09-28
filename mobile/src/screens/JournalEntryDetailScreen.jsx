import React, { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  StatusBar,
} from "react-native";
import { Image } from "expo-image";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect } from "@react-navigation/native";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { format, parseISO } from "date-fns";
import { colors, fonts, goldButton, radius, spacing } from '../shared/theme';
import { GoldFill } from '../shared/components/GoldButton';
import { journalApi } from "../shared/api/journal";
import { moodById, moodIcon } from "../shared/constants/journalMoods";
import ConfirmSheet from "../components/ConfirmSheet";
import ErrorState from "../components/ErrorState";
import { showAlert } from "../shared/services/themedAlert";

export default function JournalEntryDetailScreen({ navigation, route }) {
  const insets = useSafeAreaInsets();
  const { entryId } = route.params;

  const [entry, setEntry] = useState(null);
  const [onThisDay, setOnThisDay] = useState([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await journalApi.getById(entryId);
      setEntry(result);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [entryId]);

  // Re-read on focus so returning from the editor shows the edited text.
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  // "On this day" is anchored to the entry's own date, and only needs
  // re-fetching when that date changes — editing the text cannot move it.
  const entryDayKey = entry
    ? format(parseISO(entry.createdAt), "yyyy-MM-dd")
    : null;
  useEffect(() => {
    if (!entryDayKey) return;
    journalApi
      .onThisDay(entryDayKey)
      .then(setOnThisDay)
      .catch(() => setOnThisDay([]));
  }, [entryDayKey]);

  const handleDelete = useCallback(async () => {
    setDeleting(true);
    try {
      await journalApi.delete(entryId);
      setConfirmingDelete(false);
      navigation.goBack();
    } catch (e) {
      setDeleting(false);
      setConfirmingDelete(false);
      showAlert(
        "Could not delete",
        e?.response?.data?.message || "Try again in a moment.",
        [{ text: "OK" }],
      );
    }
  }, [entryId, navigation]);

  if (loading) {
    return (
      <View
        style={[styles.screen, styles.centered, { paddingTop: insets.top }]}
      >
        <StatusBar barStyle="light-content" backgroundColor={colors.canvas} />
        <ActivityIndicator color={colors.gold} />
      </View>
    );
  }

  if (failed || !entry) {
    return (
      <View style={[styles.screen, { paddingTop: insets.top }]}>
        <StatusBar barStyle="light-content" backgroundColor={colors.canvas} />
        <ErrorState
          dark
          title="Entry unavailable"
          subtitle="We couldn't open this entry. It may have been deleted."
          onRetry={load}
          onGoHome={() => navigation.goBack()}
        />
      </View>
    );
  }

  const date = parseISO(entry.createdAt);
  const mood = moodById(entry.mood);
  const anniversary = onThisDay[0];

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <StatusBar barStyle="light-content" backgroundColor={colors.canvas} />

      <View style={styles.topBar}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          hitSlop={12}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <Ionicons name="chevron-back" size={22} color={colors.ink} />
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() =>
            showAlert("Entry options", null, [
              {
                text: "Edit entry",
                onPress: () => navigation.navigate("JournalEditor", { entry }),
              },
              {
                text: "Delete entry",
                style: "destructive",
                onPress: () => setConfirmingDelete(true),
              },
              { text: "Cancel", style: "cancel" },
            ])
          }
          hitSlop={12}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Entry options"
        >
          <Ionicons
            name="ellipsis-horizontal"
            size={20}
            color={colors.textSecondary}
          />
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.headline}>
          <View style={styles.moodCircle}>
            <MaterialCommunityIcons
              name={moodIcon(entry.mood)}
              size={18}
              color={mood ? colors.goldGlowSoft : colors.textMuted}
            />
          </View>
          <View style={styles.headlineText}>
            <Text style={styles.date}>{format(date, "EEEE, MMMM d")}</Text>
            <Text style={styles.meta}>
              {format(date, "h:mmaaa")} · {entry.wordCount}{" "}
              {entry.wordCount === 1 ? "word" : "words"}
            </Text>
          </View>
        </View>

        {entry.content ? (
          <Text style={styles.body}>{entry.content}</Text>
        ) : null}

        {entry?.media?.length > 0 ? (
          <View style={styles.mediaGrid}>
            {entry.media.map((item) => (
              <Image
                key={item.id}
                source={{ uri: item.thumbnailUrl || item.mediaUrl, cacheKey: item.id }}
                style={styles.mediaItem}
                cachePolicy="disk"
              />
            ))}
          </View>
        ) : null}

        {entry?.tags?.length > 0 ? (
          <View style={styles.tagRow}>
            {entry.tags.map((tag) => (
              <View key={tag} style={styles.tagChip}>
                <Text style={styles.tagChipText}>{tag}</Text>
              </View>
            ))}
          </View>
        ) : null}

        {anniversary ? (
          <TouchableOpacity
            style={styles.anniversaryCard}
            activeOpacity={0.8}
            onPress={() =>
              navigation.push("JournalEntry", { entryId: anniversary.id })
            }
          >
            <View style={styles.anniversaryText}>
              <Text style={styles.anniversaryLabel}>ON THIS DAY</Text>
              <Text style={styles.anniversaryBody} numberOfLines={1}>
                {anniversary.yearsAgo === 1
                  ? "Last year"
                  : `${anniversary.yearsAgo} years ago`}
                : {anniversary.snippet || "You wrote an entry"}
              </Text>
            </View>
            <Ionicons
              name="chevron-forward"
              size={16}
              color={colors.textMuted}
            />
          </TouchableOpacity>
        ) : null}
      </ScrollView>

      <View
        style={[styles.actions, { paddingBottom: insets.bottom + spacing.lg }]}
      >
        <TouchableOpacity
          style={styles.editBtn}
          onPress={() => navigation.navigate("JournalEditor", { entry })}
          activeOpacity={0.85}
        >
          <GoldFill radius={radius.md} />
          <Text style={styles.editBtnText}>Edit entry</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.deleteBtn}
          onPress={() => setConfirmingDelete(true)}
          activeOpacity={0.7}
        >
          <Text style={styles.deleteBtnText}>Delete entry</Text>
        </TouchableOpacity>
      </View>

      <ConfirmSheet
        visible={confirmingDelete}
        title="Delete this entry?"
        subtitle="This entry will be removed from your journal. This cannot be undone."
        confirmLabel="Delete entry"
        loading={deleting}
        onConfirm={handleDelete}
        onCancel={() => setConfirmingDelete(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.canvas },
  centered: { alignItems: "center", justifyContent: "center" },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
  },
  scroll: { paddingHorizontal: spacing.xl, paddingBottom: spacing.xxl },

  headline: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  moodCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderCool,
  },
  headlineText: { flex: 1 },
  date: { fontFamily: fonts.displayBold, fontSize: 17, color: colors.ink },
  meta: {
    fontFamily: fonts.body,
    fontSize: 11.5,
    color: colors.textMuted,
    marginTop: 2,
  },

  body: {
    fontFamily: fonts.body,
    fontSize: 14,
    lineHeight: 23,
    color: colors.inkDeep,
    marginTop: spacing.xl,
  },

  mediaGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
    marginTop: spacing.lg,
  },
  mediaItem: {
    width: 88,
    height: 88,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceDark,
  },

  tagRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
    marginTop: spacing.xl,
  },
  tagChip: {
    paddingHorizontal: spacing.md,
    height: 24,
    justifyContent: "center",
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
  },
  tagChipText: {
    fontFamily: fonts.body,
    fontSize: 11.5,
    color: colors.inkDeep,
  },

  anniversaryCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    marginTop: spacing.xl,
    padding: spacing.lg,
    borderRadius: radius.card,
    backgroundColor: colors.surfaceDark,
    borderWidth: 1,
    borderColor: colors.borderCool,
  },
  anniversaryText: { flex: 1 },
  anniversaryLabel: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 9.5,
    letterSpacing: 1.1,
    color: colors.textMuted,
  },
  anniversaryBody: {
    fontFamily: fonts.body,
    fontSize: 13,
    color: colors.inkDeep,
    marginTop: 5,
  },

  actions: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.md,
  },
  editBtn: {
    height: 46,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.gold,
    ...goldButton.glow,
  },
  editBtnText: {
    fontFamily: fonts.bodyBold,
    fontSize: 14,
    color: colors.canvas,
  },
  deleteBtn: { alignItems: "center", paddingVertical: spacing.md },
  deleteBtnText: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 13,
    color: colors.danger,
  },
});
