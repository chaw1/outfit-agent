import { Ionicons } from '@expo/vector-icons';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, layout, radius, space, type as typography } from '../theme';
import { previewUrl } from '../lib/previewUrl';
import { Badge, FadeImage } from './ui';

type VideoPlayerProps = {
  uri: string;
  posterUrl?: string;
  testID?: string;
};

export function VideoPlayer({ uri, posterUrl, testID = 'video-player' }: VideoPlayerProps) {
  let identity = uri;
  try {
    const resource = new URL(uri);
    resource.searchParams.delete('exp');
    resource.searchParams.delete('sig');
    identity = resource.toString();
  } catch { /* 本地媒体路径没有签名参数。 */ }
  return <VideoSurface key={identity} uri={uri} posterUrl={posterUrl} testID={testID} />;
}

function VideoSurface({ uri, posterUrl, testID }: VideoPlayerProps) {
  const [started, setStarted] = useState(false);
  const [initialUri] = useState(uri);
  const [playbackError, setPlaybackError] = useState(false);
  const [reloading, setReloading] = useState(false);
  const latestUri = useRef(uri);
  const loadedUri = useRef(uri);
  const player = useVideoPlayer(initialUri, (instance) => {
    instance.loop = false;
    instance.muted = true;
  });

  // 签名刷新不打断正在播放的同一条视频；加载失败时再用最新地址重试。
  useEffect(() => { latestUri.current = uri; }, [uri]);
  useEffect(() => {
    const subscription = player.addListener('statusChange', ({ status }) => {
      if (status === 'readyToPlay') setPlaybackError(false);
      if (status !== 'error') return;
      if (latestUri.current !== loadedUri.current) {
        loadedUri.current = latestUri.current;
        void player.replaceAsync(latestUri.current).then(() => {
          if (started) player.play();
        }).catch(() => setPlaybackError(true));
      } else setPlaybackError(true);
    });
    return () => subscription.remove();
  }, [player, started]);

  async function reload() {
    setReloading(true);
    setPlaybackError(false);
    loadedUri.current = latestUri.current;
    try {
      await player.replaceAsync(latestUri.current);
      setStarted(true);
      player.play();
    } catch { setPlaybackError(true); }
    finally { setReloading(false); }
  }

  return (
    <View style={styles.frame}>
      <VideoView
        player={player}
        style={styles.video}
        nativeControls
        contentFit="contain"
        testID={testID}
        accessibilityLabel="穿搭短视频，点击播放"
      />
      {posterUrl && !started && !playbackError ? <Pressable
        accessibilityRole="button"
        accessibilityLabel="播放穿搭短视频"
        testID="play-video"
        onPress={() => { setStarted(true); player.play(); }}
        style={({ pressed }) => [styles.poster, pressed && styles.posterPressed]}
      >
        <FadeImage source={{ uri: previewUrl(posterUrl, 1080) }} style={StyleSheet.absoluteFill} resizeMode="cover" />
        <View style={styles.posterShade} />
        <View style={styles.videoBadge}><Badge label="AI生成" tone="inverse" /></View>
        <View style={styles.play}><Ionicons name="play" size={25} color={colors.white} /></View>
        <Text style={styles.playLabel}>轻点播放穿搭短片</Text>
      </Pressable> : null}
      {playbackError || reloading ? <View style={styles.errorOverlay}>
        <Ionicons name="videocam-outline" size={32} color={colors.viewerMuted} />
        <Text style={styles.errorText}>视频暂时没加载出来</Text>
        <Pressable onPress={() => void reload()} disabled={reloading} accessibilityRole="button" accessibilityLabel="重新加载视频" testID="reload-video" style={({ pressed }) => [styles.reload, pressed && styles.posterPressed]}>
          {reloading ? <ActivityIndicator size="small" color={colors.white} /> : <Ionicons name="refresh" size={18} color={colors.white} />}
          <Text style={styles.reloadText}>{reloading ? '正在重试…' : '重新加载'}</Text>
        </Pressable>
      </View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { overflow: 'hidden', borderRadius: radius.md, backgroundColor: colors.viewerCanvas },
  video: { width: '100%', aspectRatio: layout.thumbnailRatio },
  poster: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, justifyContent: 'center', alignItems: 'center', gap: space.md },
  posterPressed: { opacity: .85, transform: [{ scale: .99 }] },
  posterShade: { ...StyleSheet.absoluteFill, backgroundColor: colors.overlay },
  videoBadge: { position: 'absolute', left: space.md, top: space.md },
  play: { width: 64, height: 64, borderRadius: radius.lg, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.viewerSurface, borderColor: colors.viewerMuted, borderWidth: 1, paddingLeft: space.xs },
  playLabel: { ...typography.label, color: colors.white },
  errorOverlay: { ...StyleSheet.absoluteFill, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.viewerCanvas, gap: space.md, padding: space.lg },
  errorText: { ...typography.body, color: colors.white, textAlign: 'center' },
  reload: { flexDirection: 'row', minHeight: layout.touch, alignItems: 'center', gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.md, borderRadius: radius.sm, backgroundColor: colors.viewerSurface },
  reloadText: { ...typography.label, color: colors.white },
});
