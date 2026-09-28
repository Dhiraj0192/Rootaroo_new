import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  Dimensions,
  Modal,
  Pressable,
  RefreshControl,
  ActivityIndicator,
} from 'react-native';
import { Image } from 'expo-image';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { useFeedPhotos } from '../shared/hooks/useFeedPhotos';
import { useFeedStore } from '../shared/store/feedStore';
import { useAuthStore } from '../shared/store/authStore';
import { householdApi } from '../shared/api/household';
import EmptyState from '../components/EmptyState';
import { colors, fonts, withAlpha } from '../shared/theme';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const COLUMNS = 3;
const EDGE = 16;
const GAP = 6;
const TILE = Math.floor((SCREEN_WIDTH - EDGE * 2 - GAP * (COLUMNS - 1)) / COLUMNS);

// "abc" → "abc's", "Jones" → "Jones'"
function possessive(name) {
  const trimmed = name.trim();
  return /s$/i.test(trimmed) ? `${trimmed}'` : `${trimmed}'s`;
}

export default function PhotoGalleryScreen() {
  const nav = useNavigation();
  const insets = useSafeAreaInsets();
  const photos = useFeedPhotos();
  const refresh = useFeedStore((s) => s.refresh);
  const refreshing = useFeedStore((s) => s.refreshing);
  const hasMore = useFeedStore((s) => s.hasMore);
  const fetchMore = useFeedStore((s) => s.fetchMore);
  const [viewerIndex, setViewerIndex] = useState(null);
  const householdId = useAuthStore((s) => s.householdId);
  const [householdName, setHouseholdName] = useState('');

  // Dashboard kicks off its own feed refresh on every focus, right before
  // the user can tap through here — if that fetch is still in flight when
  // this screen mounts, wait for it instead of rendering the stale post
  // list with (possibly near-expired) signed image URLs that would hang
  // for several seconds until the in-flight fetch resolves and re-renders
  // this screen anyway. Only gates the initial mount, never later
  // pagination (`fetchMore`) loading toggles.
  const [waitingOnFreshFetch, setWaitingOnFreshFetch] = useState(
    () => useFeedStore.getState().loading,
  );
  useEffect(() => {
    if (!waitingOnFreshFetch) return undefined;
    const unsubscribe = useFeedStore.subscribe((state) => {
      if (!state.loading) {
        setWaitingOnFreshFetch(false);
        unsubscribe();
      }
    });
    return unsubscribe;
  }, [waitingOnFreshFetch]);

  useEffect(() => {
    if (!householdId) return undefined;
    let cancelled = false;
    householdApi
      .getHousehold(householdId)
      .then((hh) => {
        if (!cancelled) setHouseholdName(hh?.name || '');
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [householdId]);

  const renderItem = useCallback(
    ({ item, index }) => (
      <TouchableOpacity
        style={[
          styles.tile,
          { marginRight: (index + 1) % COLUMNS === 0 ? 0 : GAP },
        ]}
        activeOpacity={0.85}
        onPress={() => setViewerIndex(index)}
      >
        <Image
          source={{ uri: item.uri, cacheKey: item.id }}
          style={styles.tileImage}
          contentFit="cover"
          cachePolicy="disk"
        />
      </TouchableOpacity>
    ),
    [],
  );

  return (
    <View style={styles.container}>
      <StatusBar style="light" />
      <View style={[styles.header, { paddingTop: insets.top }]}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => nav.goBack()}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Text style={styles.backIcon}>‹</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {householdName ? `${possessive(householdName)} Household` : 'Photos'}
        </Text>
        <View style={styles.backBtn} />
      </View>

      {waitingOnFreshFetch ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator size="large" color={colors.goldDeep} />
        </View>
      ) : (
        <FlatList
          data={photos}
          keyExtractor={(item) => String(item.id)}
          renderItem={renderItem}
          numColumns={COLUMNS}
          contentContainerStyle={[
            styles.grid,
            { paddingBottom: insets.bottom + 24 },
            photos.length === 0 && styles.gridEmpty,
          ]}
          showsVerticalScrollIndicator={false}
          onEndReachedThreshold={0.5}
          onEndReached={() => {
            if (hasMore) fetchMore();
          }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={refresh}
              tintColor={colors.goldDeep}
            />
          }
          ListEmptyComponent={
            <EmptyState
              icon={<Text style={styles.emptyEmoji}>📸</Text>}
              title="No photos yet"
              subtitle="Photos shared to the Feed show up here."
              dark
            />
          }
        />
      )}

      <Modal
        visible={viewerIndex !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setViewerIndex(null)}
      >
        <Pressable style={styles.viewer} onPress={() => setViewerIndex(null)}>
          {viewerIndex !== null && photos[viewerIndex] ? (
            <Image
              source={{
                uri: photos[viewerIndex].fullUri || photos[viewerIndex].uri,
                cacheKey: photos[viewerIndex].id,
              }}
              style={styles.viewerImage}
              contentFit="contain"
              cachePolicy="disk"
            />
          ) : null}
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.canvas,
  },
  loadingWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: EDGE,
    paddingBottom: 10,
  },
  backBtn: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backIcon: {
    fontSize: 26,
    fontWeight: '700',
    color: colors.ink,
    lineHeight: 28,
  },
  headerTitle: {
    flex: 1,
    textAlign: 'center',
    marginHorizontal: 8,
    fontSize: 17,
    fontWeight: '700',
    fontFamily: fonts.displayBold,
    color: colors.ink,
  },
  grid: {
    paddingHorizontal: EDGE,
    paddingTop: 4,
  },
  gridEmpty: {
    flexGrow: 1,
  },
  tile: {
    width: TILE,
    height: TILE,
    marginBottom: GAP,
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: colors.surfaceRaised,
  },
  tileImage: {
    width: '100%',
    height: '100%',
  },
  emptyEmoji: {
    fontSize: 28,
  },
  viewer: {
    flex: 1,
    backgroundColor: withAlpha(colors.canvas, 0.96),
    alignItems: 'center',
    justifyContent: 'center',
  },
  viewerImage: {
    width: '100%',
    height: '80%',
  },
});
