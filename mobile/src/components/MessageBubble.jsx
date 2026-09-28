import React, { useRef, useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Pressable,
  PanResponder,
} from 'react-native';
import { Image } from 'expo-image';
import { Audio } from 'expo-av';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { colors, fonts, radius } from '../shared/theme';
import { chatTheme } from '../shared/theme/chat';
import { useVoiceAudioStore } from '../shared/store/voiceAudioStore';
import Avatar from './Avatar';

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(seconds || 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// Decorative reference waveform; voice clips do not include amplitude data.
const WAVEFORM_HEIGHTS = [4, 6, 10, 16, 20, 24, 16, 12, 20, 24, 12, 8, 14, 20, 22, 16, 8, 6, 12, 18, 22, 14, 8, 12, 18, 10, 6];

function VoiceBubble({ messageId, mediaUrl, durationSeconds, isOwn, isSelected, onLongPress, onTapDeselect }) {
  const [playing, setPlaying] = useState(false);
  const [positionMillis, setPositionMillis] = useState(0);
  const [durationMillis, setDurationMillis] = useState((durationSeconds || 0) * 1000);
  const soundRef = useRef(null);
  const loadingRef = useRef(null);
  const waveWidthRef = useRef(1);

  const activeMessageId = useVoiceAudioStore((s) => s.activeMessageId);
  const setActive = useVoiceAudioStore((s) => s.setActive);
  const clearActive = useVoiceAudioStore((s) => s.clearActive);

  useEffect(() => {
    return () => {
      soundRef.current?.unloadAsync?.();
    };
  }, []);

  // Only one voice note plays at a time — when a different bubble becomes
  // active while this one is still playing, pause here too. `pauseAsync`
  // triggers `onStatusUpdate` with the real `isPlaying:false`, so `playing`
  // stays driven by actual playback state rather than a second flag.
  useEffect(() => {
    if (activeMessageId !== messageId && playing) {
      soundRef.current?.pauseAsync?.();
    }
  }, [activeMessageId, messageId, playing]);

  const onStatusUpdate = (status) => {
    if (!status.isLoaded) return;
    setPlaying(status.isPlaying);
    setPositionMillis(status.positionMillis || 0);
    if (status.durationMillis) setDurationMillis(status.durationMillis);
    if (status.didJustFinish) {
      setPlaying(false);
      setPositionMillis(0);
      soundRef.current?.setPositionAsync(0);
      clearActive(messageId);
    }
  };

  const ensureLoaded = async () => {
    if (soundRef.current) return soundRef.current;
    if (loadingRef.current) return loadingRef.current;
    loadingRef.current = (async () => {
      const { sound } = await Audio.Sound.createAsync(
        { uri: mediaUrl },
        { shouldPlay: false },
        onStatusUpdate,
      );
      soundRef.current = sound;
      await sound.setProgressUpdateIntervalAsync(100);
      return sound;
    })();
    try {
      return await loadingRef.current;
    } finally {
      loadingRef.current = null;
    }
  };

  const handleTogglePlay = async () => {
    try {
      const sound = await ensureLoaded();
      const status = await sound.getStatusAsync();
      if (status.isLoaded && status.isPlaying) {
        await sound.pauseAsync();
        clearActive(messageId);
      } else {
        setActive(messageId);
        await sound.playAsync();
      }
    } catch {
      setPlaying(false);
    }
  };

  const fractionFromTouch = (x) =>
    Math.min(1, Math.max(0, x / (waveWidthRef.current || 1)));

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (evt) => {
        setPositionMillis(fractionFromTouch(evt.nativeEvent.locationX) * durationMillis);
      },
      onPanResponderMove: (evt) => {
        setPositionMillis(fractionFromTouch(evt.nativeEvent.locationX) * durationMillis);
      },
      onPanResponderRelease: async (evt) => {
        const frac = fractionFromTouch(evt.nativeEvent.locationX);
        setPositionMillis(frac * durationMillis);
        const sound = await ensureLoaded();
        try {
          await sound.setPositionAsync(frac * durationMillis);
        } catch {
          // ignore — visual position already updated
        }
      },
    }),
  ).current;

  const handleRowPress = () => {
    if (isSelected) onTapDeselect?.();
  };

  const progressFrac = durationMillis > 0 ? positionMillis / durationMillis : 0;
  const showElapsed = playing || (positionMillis > 0 && positionMillis < durationMillis);
  const displaySeconds = (showElapsed ? positionMillis : durationMillis) / 1000;

  const playedColor = isOwn ? styles.barPlayedOwn : styles.barPlayedOther;
  const unplayedColor = isOwn ? styles.barUnplayedOwn : styles.barUnplayedOther;

  return (
    <Pressable
      onPress={handleRowPress}
      onLongPress={onLongPress}
      style={styles.voiceWrap}
    >
      <View style={styles.voiceMainRow}>
        <TouchableOpacity
          onPress={handleTogglePlay}
          accessibilityRole="button"
          accessibilityLabel={playing ? 'Pause voice message' : 'Play voice message'}
          style={[styles.voicePlayBtn, isOwn ? styles.voicePlayBtnOwn : styles.voicePlayBtnOther]}
        >
          <Ionicons
            name={playing ? 'pause' : 'play'}
            size={16}
            style={!playing && { marginLeft: 2 }}
            color={isOwn ? '#f6d98f' : colors.onAccent}
          />
        </TouchableOpacity>
        <View
          style={styles.waveform}
          onLayout={(e) => { waveWidthRef.current = e.nativeEvent.layout.width; }}
          {...panResponder.panHandlers}
        >
          {WAVEFORM_HEIGHTS.map((height, i) => (
            <View
              key={i}
              style={[
                styles.bar,
                { height },
                i / WAVEFORM_HEIGHTS.length < progressFrac ? playedColor : unplayedColor,
              ]}
            />
          ))}
        </View>
        <Text style={[styles.voiceDuration, isOwn ? styles.voiceDurationOwn : styles.textOther]}>
          {formatDuration(displaySeconds)}
        </Text>
      </View>
    </Pressable>
  );
}

export default function MessageBubble({
  message,
  isOwn,
  isSelected,
  onToggleReaction,
  onPressReply,
  onSelectMessage,
  onMediaPress,
  showAvatar,
}) {
  const containerRef = useRef(null);
  const withAvatar = !isOwn && showAvatar;

  const format12HourTime = (iso) => {
    const d = new Date(iso);
    let hours = d.getHours();
    const mins = d.getMinutes().toString().padStart(2, '0');
    const ampm = hours >= 12 ? 'pm' : 'am';
    hours = hours % 12;
    hours = hours ? hours : 12;
    return `${hours}:${mins}${ampm}`;
  };

  const isDeleted = !!message.deletedAt;
  const isEdited = !!message.editedAt;
  const isVoice = message.type === 'voice' && !!message.mediaUrl;

  if (isDeleted) {
    return (
      <View style={[styles.container, isOwn && styles.containerOwn]}>
        <View style={[styles.bubble, styles.deletedBubble]}>
          <Text style={styles.deletedText}>Message deleted</Text>
        </View>
      </View>
    );
  }

  // Only reactions with count > 0 should be displayed in the main stream
  const activeReactions = (message.reactions || []).filter((r) => r.count > 0);

  const handleLongPressSelect = () => {
    containerRef.current?.measureInWindow((x, y, width, height) => {
      onSelectMessage?.(message, { x, y, width, height });
    });
  };
  const handleTapDeselect = () => {
    if (isSelected) {
      onSelectMessage?.(message);
    }
  };

  const bubbleContent = (
    <>
      {/* Sender name — only in a group/household row, above the bubble */}
      {withAvatar && (
        <Text style={styles.senderName} numberOfLines={1}>
          {message.sender.displayName}
        </Text>
      )}

      {/* Reply preview */}
      {message.replyPreview && (
        <TouchableOpacity
          style={styles.replyPreview}
          onPress={() => onPressReply(message.replyToId)}
        >
          <View style={styles.replyBar} />
          <View style={styles.replyContent}>
            <Text style={styles.replyName}>{message.replyPreview.senderName}</Text>
            <Text style={styles.replyText} numberOfLines={1}>
              {message.replyPreview.content || '[Image]'}
            </Text>
          </View>
        </TouchableOpacity>
      )}

      {/* Message content */}
      <TouchableOpacity
        onLongPress={handleLongPressSelect}
        onPress={handleTapDeselect}
        activeOpacity={0.9}
        style={[
          styles.bubble,
          isOwn ? styles.bubbleOwn : styles.bubbleOther,
          isVoice && styles.voiceBubble,
          isVoice && isOwn && styles.voiceBubbleOwn,
          isSelected && styles.bubbleSelected,
        ]}
      >
        {isOwn && (
          <LinearGradient
            colors={isVoice ? ['#f6d98f', '#dfb354'] : chatTheme.bubbleOwnGradient}
            start={{ x: 0, y: 0 }}
            end={{ x: isVoice ? 1 : 0, y: 1 }}
            style={[StyleSheet.absoluteFill, styles.bubbleOwnGradientFill, isVoice && styles.voiceGradientFill]}
            pointerEvents="none"
          />
        )}
        {message.content && (
          <Text style={[styles.text, isOwn ? styles.textOwn : styles.textOther]}>
            {message.content}
          </Text>
        )}
        {message.mediaUrl && message.type === 'voice' ? (
          <VoiceBubble
            messageId={message.id}
            mediaUrl={message.mediaUrl}
            durationSeconds={message.durationSeconds}
            isOwn={isOwn}
            isSelected={isSelected}
            onLongPress={handleLongPressSelect}
            onTapDeselect={handleTapDeselect}
          />
        ) : (
          message.mediaUrl && (
            <TouchableOpacity
              onPress={() => onMediaPress?.(message.mediaUrl)}
              activeOpacity={0.8}
            >
              <Image
                // mediaUrl is a presigned S3 link that changes on every
                // fetch — key the cache by the stable message id instead.
                source={{ uri: message.mediaUrl, cacheKey: message.id }}
                style={styles.media}
                contentFit="cover"
                cachePolicy="disk"
              />
            </TouchableOpacity>
          )
        )}
      </TouchableOpacity>

      {/* Reaction Pill Badges */}
      {activeReactions.length > 0 && (
        <View style={[styles.reactionBadgeRow, isOwn ? styles.reactionBadgeOwn : styles.reactionBadgeOther]}>
          {activeReactions.map((r) => (
            <TouchableOpacity
              key={r.emoji}
              style={[styles.reactionPill, r.userReacted && styles.reactionPillActive]}
              onPress={() => onToggleReaction(message.id, r.emoji)}
              activeOpacity={0.7}
            >
              <Text style={styles.reactionEmoji}>{r.emoji}</Text>
              <Text style={[styles.reactionCountText, r.userReacted && styles.reactionCountActive]}>
                {r.count}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* Footer metadata below bubble */}
      <View style={[styles.metaRow, isOwn && styles.metaRowOwn]}>
        <Text style={styles.metaText}>{format12HourTime(message.createdAt)}</Text>
        {isEdited && <Text style={styles.editedText}> (edited)</Text>}
        {isOwn && (
          <Ionicons
            name="checkmark"
            size={13}
            color={chatTheme.checkColor}
            style={styles.sentTick}
          />
        )}
      </View>
    </>
  );

  if (withAvatar) {
    return (
      <View ref={containerRef} style={styles.rowWithAvatar}>
        <Avatar
          url={message.sender.avatarUrl}
          emoji={message.sender.avatarEmoji}
          name={message.sender.displayName}
          id={message.sender.id}
          size={28}
          style={styles.senderAvatar}
        />
        <View style={styles.bubbleColumn}>{bubbleContent}</View>
      </View>
    );
  }

  return (
    <View ref={containerRef} style={[styles.container, isOwn && styles.containerOwn]}>
      {bubbleContent}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginBottom: 14,
    paddingHorizontal: 16,
    alignItems: 'flex-start',
  },
  containerOwn: {
    alignItems: 'flex-end',
  },
  rowWithAvatar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    marginBottom: 14,
    paddingHorizontal: 16,
  },
  senderAvatar: {
    marginBottom: 2,
  },
  bubbleColumn: {
    flex: 1,
    alignItems: 'flex-start',
  },
  bubble: {
    maxWidth: '82%',
    paddingHorizontal: 15,
    paddingVertical: 12,
    borderRadius: 20,
  },
  bubbleOwn: {
    // Filled by the LinearGradient sibling below, not a flat backgroundColor
    // — overflow:hidden clips that gradient to this radius.
    overflow: 'hidden',
    borderBottomRightRadius: 6,
    shadowColor: '#E3BB68',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.16,
    shadowRadius: 9,
    elevation: 3,
  },
  bubbleOwnGradientFill: {
    borderRadius: 20,
    borderBottomRightRadius: 6,
  },
  bubbleOther: {
    backgroundColor: chatTheme.bubbleOtherBg,
    borderWidth: 1,
    borderColor: chatTheme.bubbleOtherBorder,
    borderBottomLeftRadius: 6,
  },
  bubbleSelected: {
    borderWidth: 2,
    borderColor: colors.gold,
    shadowOpacity: 0,
    shadowRadius: 0,
    elevation: 0,
  },
  focusedBubble: {
    marginBottom: 12,
    shadowColor: colors.shadow,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 10,
    elevation: 8,
  },
  deletedBubble: {
    backgroundColor: colors.surfaceDark,
    borderWidth: 1,
    borderColor: colors.border,
  },
  deletedText: {
    fontSize: 13,
    fontStyle: 'italic',
    fontFamily: fonts.body,
    color: colors.textSecondary,
  },
  text: {
    fontSize: 15,
    lineHeight: 21,
    fontFamily: fonts.body,
  },
  textOwn: {
    color: chatTheme.bubbleOwnText,
  },
  textOther: {
    color: chatTheme.bubbleOtherText,
  },
  media: {
    width: 200,
    height: 150,
    borderRadius: 12,
    marginTop: 6,
  },
  voiceBubble: {
    width: 295,
    maxWidth: '100%',
    paddingVertical: 9,
    paddingLeft: 9,
    paddingRight: 14,
    borderRadius: 24,
    borderBottomLeftRadius: 24,
    borderBottomRightRadius: 6,
  },
  voiceBubbleOwn: {
    overflow: 'visible',
    shadowColor: '#e3bb68',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.22,
    shadowRadius: 12,
  },
  voiceGradientFill: {
    borderRadius: 24,
    borderBottomRightRadius: 6,
    borderWidth: 1,
    borderColor: 'rgba(255,235,177,0.25)',
  },
  voiceWrap: { width: '100%' },
  voiceMainRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 36,
  },
  voicePlayBtn: {
    width: 36,
    height: 36,
    flexShrink: 0,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#1a1408',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 3,
    elevation: 2,
  },
  voicePlayBtnOwn: { backgroundColor: '#1a1408' },
  voicePlayBtnOther: { backgroundColor: colors.gold },
  waveform: {
    flex: 1,
    minWidth: 0,
    height: 36,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  bar: { width: 5, flexShrink: 1, borderRadius: 2.5 },
  barUnplayedOwn: { backgroundColor: 'rgba(112,79,17,0.38)' },
  barPlayedOwn: { backgroundColor: '#1a1408' },
  barUnplayedOther: { backgroundColor: chatTheme.metaText },
  barPlayedOther: { backgroundColor: chatTheme.checkColor },
  voiceDuration: {
    fontSize: 12,
    fontFamily: fonts.bodyBold,
    fontVariant: ['tabular-nums'],
    minWidth: 27,
    textAlign: 'right',
  },
  voiceDurationOwn: { color: '#70531d' },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 5,
    marginLeft: 4,
  },
  metaRowOwn: {
    marginRight: 4,
    marginLeft: 0,
  },
  metaText: {
    fontSize: 11,
    fontFamily: fonts.bodySemiBold,
    color: chatTheme.metaText,
  },
  sentTick: {
    marginLeft: -1,
  },
  senderName: {
    fontSize: 11.5,
    fontFamily: fonts.bodyBold,
    color: chatTheme.senderName,
    marginBottom: 5,
    marginLeft: 3,
  },
  editedText: {
    fontSize: 11,
    color: colors.textMuted,
    fontStyle: 'italic',
    fontFamily: fonts.body,
  },
  metaReaction: {
    fontSize: 12,
    color: colors.ink,
    fontFamily: fonts.bodySemiBold,
  },
  replyPreview: {
    flexDirection: 'row',
    marginBottom: 4,
    maxWidth: '80%',
  },
  replyBar: {
    width: 3,
    backgroundColor: colors.gold,
    borderRadius: 2,
    marginRight: 8,
  },
  replyContent: {
    flex: 1,
  },
  replyName: {
    fontSize: 11,
    fontFamily: fonts.bodyBold,
    color: colors.gold,
  },
  replyText: {
    fontSize: 12,
    fontFamily: fonts.body,
    color: colors.textSecondary,
  },
  reactionBadgeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    marginTop: -6,
    marginBottom: 4,
    zIndex: 2,
  },
  reactionBadgeOwn: {
    alignSelf: 'flex-end',
    marginRight: 12,
  },
  reactionBadgeOther: {
    alignSelf: 'flex-start',
    marginLeft: 12,
  },
  reactionPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingHorizontal: 7,
    paddingVertical: 2,
    gap: 3,
    shadowColor: colors.shadow,
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 2,
    elevation: 2,
  },
  reactionPillActive: {
    backgroundColor: colors.goldLight,
    borderColor: colors.gold,
  },
  reactionEmoji: { fontSize: 12 },
  reactionCountText: { fontSize: 11, color: colors.textSecondary, fontFamily: fonts.bodySemiBold },
  reactionCountActive: { color: colors.goldDeep },
});
