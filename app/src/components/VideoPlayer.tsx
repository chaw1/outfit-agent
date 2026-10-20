import { Ionicons } from '@expo/vector-icons';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from 'react-native';

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
        style={styles.poster}
      >
        <Image source={{ uri: posterUrl }} style={StyleSheet.absoluteFill} resizeMode="cover" />
        <View style={styles.play}><Ionicons name="play" size={25} color="#FFFFFF" /></View>
      </Pressable> : null}
      {playbackError || reloading ? <View style={styles.errorOverlay}>
        <Text style={styles.errorText}>视频暂时没加载出来</Text>
        <Pressable onPress={() => void reload()} disabled={reloading} accessibilityRole="button" accessibilityLabel="重新加载视频" testID="reload-video" style={styles.reload}>
          {reloading ? <ActivityIndicator size="small" color="#FFFFFF" /> : <Ionicons name="refresh" size={16} color="#FFFFFF" />}
          <Text style={styles.reloadText}>{reloading ? '正在重试…' : '重新加载'}</Text>
        </Pressable>
      </View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { overflow: 'hidden', borderRadius: 12, backgroundColor: '#1F2225' },
  video: { width: '100%', aspectRatio: 3 / 4 },
  poster: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, justifyContent: 'center', alignItems: 'center' },
  play: { width: 58, height: 58, borderRadius: 29, alignItems: 'center', justifyContent: 'center', backgroundColor: '#241F2280', borderColor: '#FFFFFF77', borderWidth: 1, paddingLeft: 3 },
  errorOverlay: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, justifyContent: 'center', alignItems: 'center', backgroundColor: '#252128C9', gap: 14 },
  errorText: { color: '#FFFFFF', fontSize: 13 },
  reload: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 15, paddingVertical: 10, borderRadius: 9, backgroundColor: '#FFFFFF25' },
  reloadText: { color: '#FFFFFF', fontSize: 12 },
});
