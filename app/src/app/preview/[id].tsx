import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import type { Action, ProjectState } from '../../api/types';
import { ImageInteractions, useImageInteractions } from '../../components/ImageInteractions';
import { VideoPlayer } from '../../components/VideoPlayer';
import { FidelityBadge, ImageRevisionInfo, NoteDisclosure } from '../../components/GenerationInfo';
import { Button, Header, Loading, Notice, Page, colors, errorText } from '../../components/ui';
import { useSession } from '../../context/Session';
import { saveImages } from '../../lib/media';

function PreviewImage({ id, url, index, onRefresh }: { id: string; url?: string; index: number; onRefresh: () => void }) {
  const [failedUrl, setFailedUrl] = useState<string>();
  const interaction = useImageInteractions();
  if (!url) return <View style={styles.imagePlaceholder}><Ionicons name="image-outline" size={34} color="#C0B3A6" /><Text style={styles.placeholderText}>图片还在路上</Text></View>;
  if (failedUrl === url) return <View style={styles.imagePlaceholder}>
    <Ionicons name="image-outline" size={34} color="#C0B3A6" />
    <Text style={styles.placeholderText}>图片暂时没能加载</Text>
    <Pressable accessibilityRole="button" accessibilityLabel={`重新加载第 ${index + 1} 张图片`} testID={`retry-preview-${id}`} onPress={() => { setFailedUrl(undefined); onRefresh(); }}><Text style={{ color: colors.red, fontSize: 12, padding: 12 }}>重新加载</Text></Pressable>
  </View>;
  return <Pressable accessibilityRole="button" accessibilityLabel={`查看笔记第 ${index + 1} 张图片`} onPress={() => interaction.open(id)} onLongPress={() => interaction.menu(id)} style={{ flex: 1 }}><Image source={{ uri: url }} style={styles.carouselImage} resizeMode="cover" testID={`preview-image-${id}`} accessibilityLabel={`笔记第 ${index + 1} 张图片${index === 0 ? '，封面' : ''}`} onError={() => setFailedUrl(url)} /><Text style={{ position: 'absolute', bottom: 12, right: 12, fontSize: 10, color: 'white', backgroundColor: '#25252288', borderRadius: 4, padding: 5 }}>AI生成</Text></Pressable>;
}

export default function NotePreview() {
  const { id } = useLocalSearchParams<{ id: string | string[] }>();
  const projectId = Array.isArray(id) ? id[0] : id;
  return <PreviewPage key={projectId ?? 'missing'} projectId={projectId} />;
}

function PreviewPage({ projectId }: { projectId?: string }) {
  const { api, user } = useSession();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const [state, setState] = useState<ProjectState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [carouselWidth, setCarouselWidth] = useState(Math.min(width, 520));
  const [page, setPage] = useState(0);
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState({ finished: 0, total: 0 });
  const [saveFeedback, setSaveFeedback] = useState('');
  const [actionError, setActionError] = useState('');
  const [savedCount, setSavedCount] = useState(0);
  const [saveFailed, setSaveFailed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editActions, setEditActions] = useState<Extract<Action, { type: 'edit_image' }>[]>([]);
  const savedIds = useRef(new Set<string>());
  const savingRef = useRef(false);

  useFocusEffect(useCallback(() => {
    let alive = true;
    let inFlight = false;
    let hasActiveJobs = false;
    setLoading(true);
    if (retry > 0) setError('');

    async function refresh() {
      if (inFlight || !projectId) {
        if (!projectId && alive) { setError('找不到这份项目，请返回工作台重新打开。'); setLoading(false); }
        return;
      }
      inFlight = true;
      try {
        const [next, history] = await Promise.all([api.state(projectId), api.messages(projectId)]);
        if (alive) {
          setState(next);
          setEditActions(history.flatMap(message => message.action?.type === 'edit_image' ? [message.action] : []));
          hasActiveJobs = next.active_jobs.length > 0;
          setError('');
        }
      } catch (cause) {
        if (alive) setError(errorText(cause));
      } finally {
        inFlight = false;
        if (alive) setLoading(false);
      }
    }

    void refresh();
    const timer = setInterval(() => { if (hasActiveJobs) void refresh(); }, 3000);
    return () => { alive = false; clearInterval(timer); };
  }, [api, projectId, retry]));

  const note = state?.note;
  const images = note?.image_ids.map((imageId) => ({
    id: imageId,
    url: state?.images.find((image) => image.id === imageId)?.url,
    source: state?.images.find((image) => image.id === imageId),
  })) ?? [];
  const nickname = user?.nickname || user?.username || '我的穿搭日记';

  function backToStudio() {
    if (router.canGoBack()) router.back();
    else if (projectId) router.replace({ pathname: '/projects/[id]', params: { id: projectId } });
    else router.replace('/');
  }

  async function copyNote() {
    if (!note) return;
    setActionError('');
    try {
      const tags = note.tags.map((tag) => `#${tag.replace(/^#/, '')}`).join(' ');
      await Clipboard.setStringAsync([note.title, note.body, tags].filter(Boolean).join('\n\n'));
      setCopied(true);
    } catch (cause) {
      setActionError(`文案没能复制：${errorText(cause)}`);
    }
  }

  async function saveNoteImages() {
    if (savingRef.current || !note) return;
    savingRef.current = true;
    setSaving(true);
    setSaveFailed(false);
    setSaveFeedback('');
    setActionError('');
    try {
      const available = images.flatMap((image) => image.url ? [{ id: image.id, url: image.url }] : []);
      if (!available.length) throw new Error('图片还没有准备好，稍后再试一次。');
      const result = await saveImages(available, savedIds.current, (finished, total) => setProgress({ finished, total }));
      for (const imageId of result.savedIds) savedIds.current.add(imageId);
      const completed = note.image_ids.filter((imageId) => savedIds.current.has(imageId)).length;
      setSavedCount(completed);
      const missing = images.length - available.length;
      if (result.failed.length || missing) {
        setSaveFailed(true);
        setActionError(`已保存 ${completed}/${images.length} 张，剩下的图片没能保存。再点一次只会重试未完成的图片。`);
      } else {
        setSaveFeedback(result.savedIds.length ? `已保存 ${completed} 张图片，发布时就用这个顺序。` : '这些图片已经保存过啦，无需重复保存。');
      }
    } catch (cause) {
      setSaveFailed(true);
      setActionError(errorText(cause));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  async function editImage(action: Action) {
    if (!projectId || editing) return;
    setEditing(true); setActionError('');
    try {
      await api.sendMessage(projectId, { action }, { onEvent: () => {} });
      try { setState(await api.state(projectId)); }
      catch (cause) { setActionError(`修改已提交，进度暂时没同步：${errorText(cause)}`); }
      setRetry(value => value + 1);
    } catch (cause) { setActionError(errorText(cause)); throw cause; }
    finally { setEditing(false); }
  }

  return <ImageInteractions images={state?.images ?? []} editActions={editActions} busy={editing} canEdit={['images', 'note', 'done'].includes(state?.stage ?? '')} onAction={editImage} onReference={image => { if (projectId) router.dismissTo({ pathname: '/projects/[id]', params: { id: projectId, refImage: image.id } }); }}><Page>
    <Header title="笔记预览" subtitle="把灵感，穿进日常" onBack={backToStudio} />
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
      {!!error && <View style={styles.notice}><Notice text={error} onRetry={() => setRetry((value) => value + 1)} /></View>}
      {loading && !state ? <Loading text="正在整理这份穿搭笔记…" /> : !note ? <View style={styles.empty}>
        <View style={styles.emptyIcon}><Ionicons name="document-text-outline" size={30} color={colors.red} /></View>
        <Text style={styles.emptyTitle}>笔记还在酝酿中</Text>
        <Text style={styles.emptyBody}>先回工作台选好图片，我们就把这份穿搭灵感写成一篇笔记。</Text>
        <Button title="返回工作台" variant="secondary" onPress={backToStudio} />
      </View> : <>
        <View onLayout={(event) => setCarouselWidth(event.nativeEvent.layout.width)} style={styles.carouselFrame}>
          <ScrollView
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            testID="preview-carousel"
            accessibilityLabel="笔记图片轮播，左右滑动查看"
            scrollEventThrottle={100}
            onScroll={(event) => setPage(Math.round(event.nativeEvent.contentOffset.x / carouselWidth))}
          >
            {images.map((image, index) => <View key={image.id} style={{ width: carouselWidth, aspectRatio: 3 / 4 }}>
              <PreviewImage id={image.id} url={image.url} index={index} onRefresh={() => setRetry(value => value + 1)} />
              {image.source ? <View pointerEvents="none" style={{ position: 'absolute', top: 37, left: 8, right: 8, bottom: 0 }}><FidelityBadge image={image.source} /></View> : null}
            </View>)}
          </ScrollView>
          {images.length > 0 ? <View style={styles.pageBadge}><Text style={styles.pageBadgeText}>{Math.min(page + 1, images.length)} / {images.length}</Text></View> : null}
          {page === 0 && images.length > 0 ? <View style={styles.coverBadge}><Text style={styles.coverBadgeText}>封面</Text></View> : null}
        </View>
        {images.length > 1 ? <View style={styles.dots}>{images.map((image, index) => <View key={image.id} style={[styles.dot, page === index && styles.dotActive]} />)}</View> : null}
        <View style={styles.noteContent}>
          {images[page]?.source ? <ImageRevisionInfo image={images[page].source} /> : null}
          <View style={styles.authorRow}>
            <View style={styles.avatar}><Text style={styles.avatarText}>{nickname.slice(0, 1).toUpperCase()}</Text></View>
            <View style={styles.authorInfo}><Text style={styles.authorName}>{nickname}</Text><Text style={styles.authorCaption}>我的穿搭日记</Text></View>
            <View style={styles.readyBadge}><Ionicons name="checkmark-circle" size={12} color={colors.green} /><Text style={styles.readyBadgeText}>准备发布</Text></View>
          </View>
          <Text selectable testID="note-title" style={styles.noteTitle}>{note.title}</Text>
          <Text selectable testID="note-body" style={styles.noteBody}>{note.body}</Text>
          <View style={styles.tags}>{note.tags.map((tag) => <Text selectable key={tag} style={styles.tag}>#{tag.replace(/^#/, '')}</Text>)}</View>
          <NoteDisclosure note={note} projectCost={state?.cost_cny} />
          <View style={styles.noteEnd}><View style={styles.endLine} /><Text style={styles.endLabel}>记录穿搭，也记录自己</Text><View style={styles.endLine} /></View>
          {state?.video?.url ? <View style={styles.videoSection}><View style={styles.videoHeading}><Ionicons name="videocam-outline" size={17} color={colors.red} /><Text style={styles.videoTitle}>你的 5 秒穿搭短片</Text></View><VideoPlayer uri={state.video.url} posterUrl={state.video.poster_url} testID="video-player" /></View> : state?.video && ['queued', 'running'].includes(state.video.status) ? <View style={styles.videoPending}><ActivityIndicator color={colors.red} size="small" /><Text style={styles.videoPendingText}>短片正在制作，好了会出现在这里。</Text></View> : state?.video?.status === 'failed' ? <View style={styles.videoSection}><Notice text="短片这次没能完成，图文笔记已经为你保留。" /><Button title="回工作台重试短片" variant="secondary" icon="refresh" onPress={backToStudio} testID="retry-video-in-studio" /></View> : null}
          <Button title="返回工作台继续创作" variant="ghost" icon="arrow-back" onPress={backToStudio} />
        </View>
      </>}
    </ScrollView>
    {note ? <View style={styles.bottomBar}>
      {copied && !actionError ? <Text accessibilityRole="status" style={styles.successText}>文案已复制，可以去发布啦。</Text> : null}
      {!!saveFeedback && <Text accessibilityRole="status" style={styles.successText}>{saveFeedback}</Text>}
      {!!actionError && <Text accessibilityRole="alert" style={styles.actionError}>{actionError}</Text>}
      <View style={styles.bottomButtons}>
        <View style={styles.bottomButton}><Button title={copied ? '已复制文案' : '复制文案'} icon={copied ? 'checkmark' : 'copy-outline'} onPress={() => void copyNote()} testID="copy-note" /></View>
        <View style={styles.bottomButton}><Button title={saving ? `保存中 ${progress.finished}/${progress.total}` : saveFailed ? savedCount ? '重试未保存' : '重试保存图片' : '保存图片'} variant="secondary" icon="download-outline" loading={saving} disabled={!images.length} onPress={() => void saveNoteImages()} testID="save-images" /></View>
      </View>
    </View> : null}
  </Page></ImageInteractions>;
}

const styles = StyleSheet.create({
  scrollContent: { paddingBottom: 15 },
  notice: { margin: 16 },
  carouselFrame: { width: '100%', backgroundColor: '#F6F2EC', minHeight: 40 },
  carouselImage: { width: '100%', height: '100%' },
  imagePlaceholder: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  placeholderText: { color: '#A4988C', fontSize: 12 },
  pageBadge: { position: 'absolute', right: 16, top: 16, backgroundColor: '#26211C66', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 12 },
  pageBadgeText: { color: '#FFFFFF', fontSize: 10, fontWeight: '600' },
  coverBadge: { position: 'absolute', left: 16, top: 16, backgroundColor: '#FFFFFFE8', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 5 },
  coverBadgeText: { color: '#877563', fontSize: 10 },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: 5, marginTop: 13 },
  dot: { height: 4, width: 4, borderRadius: 2, backgroundColor: '#E4DFD8' },
  dotActive: { width: 12, backgroundColor: colors.red },
  noteContent: { paddingHorizontal: 23, paddingTop: 21, gap: 18 },
  authorRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  avatar: { width: 38, height: 38, borderRadius: 19, backgroundColor: colors.blush, justifyContent: 'center', alignItems: 'center' },
  avatarText: { color: colors.red, fontSize: 18, fontWeight: '700' },
  authorInfo: { flex: 1, gap: 3 },
  authorName: { color: colors.ink, fontSize: 13, fontWeight: '600' },
  authorCaption: { color: '#ABA196', fontSize: 9 },
  readyBadge: { flexDirection: 'row', gap: 4, alignItems: 'center', backgroundColor: '#F1F6F1', paddingHorizontal: 8, paddingVertical: 5, borderRadius: 12 },
  readyBadgeText: { color: colors.green, fontSize: 9 },
  noteTitle: { color: colors.ink, fontSize: 20, lineHeight: 30, fontWeight: '700', letterSpacing: -0.3 },
  noteBody: { color: '#514B45', fontSize: 14, lineHeight: 26 },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  tag: { color: '#B08B6B', fontSize: 13, lineHeight: 23 },
  noteEnd: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 2, marginBottom: 2 },
  endLine: { height: 1, backgroundColor: '#F0EAE3', flex: 1 },
  endLabel: { color: '#B8AA9B', fontSize: 9, letterSpacing: 1 },
  videoSection: { gap: 12 },
  videoHeading: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  videoTitle: { color: colors.ink, fontSize: 13, fontWeight: '600' },
  videoPending: { flexDirection: 'row', alignItems: 'center', gap: 9, padding: 14, backgroundColor: colors.paper, borderRadius: 12 },
  videoPendingText: { fontSize: 11, color: colors.muted, flex: 1, lineHeight: 18 },
  bottomBar: { paddingHorizontal: 20, paddingVertical: 14, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: '#FFFFFF', gap: 9 },
  bottomButtons: { flexDirection: 'row', gap: 10 },
  bottomButton: { flex: 1 },
  successText: { color: colors.green, fontSize: 11, lineHeight: 17 },
  actionError: { color: '#B23B4A', fontSize: 11, lineHeight: 17 },
  empty: { padding: 35, paddingTop: 80, alignItems: 'center', gap: 18 },
  emptyIcon: { width: 72, height: 72, borderRadius: 22, backgroundColor: colors.blush, justifyContent: 'center', alignItems: 'center' },
  emptyTitle: { fontSize: 19, color: colors.ink, fontWeight: '700' },
  emptyBody: { fontSize: 13, lineHeight: 22, color: colors.muted, textAlign: 'center', marginBottom: 5 },
});
