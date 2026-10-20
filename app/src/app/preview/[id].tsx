import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import {
  Pressable,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { ApiError } from '../../api/client';
import type { Action, ProjectState } from '../../api/types';
import { ImageInteractions, useImageInteractions } from '../../components/ImageInteractions';
import { VideoPlayer } from '../../components/VideoPlayer';
import { FidelityBadge, ImageRevisionInfo, NoteDisclosure } from '../../components/GenerationInfo';
import { AnimatedEntry, Badge, Button, FadeImage, Header, LoadingSkeleton, Notice, Page, ProgressStrip, StatePanel, Toast, errorText } from '../../components/ui';
import { colors, radius, space, type } from '../../theme';
import { useSession } from '../../context/Session';
import { saveImages, saveVideo, shareNote } from '../../lib/media';
import { noteText, preparePublish, savedImagesAreInOrder, videoKey, type PublishProgress } from '../../lib/publish';
import { readPublishCheckpoint, writePublishCheckpoint } from '../../lib/publishCheckpoint';
import { observeGeneration } from '../../lib/notificationRuntime';

function PreviewImage({ id, url, index, onRefresh, disabled }: { id: string; url?: string; index: number; onRefresh: () => void; disabled?: boolean }) {
  const [failedUrl, setFailedUrl] = useState<string>();
  const interaction = useImageInteractions();
  if (!url) return <View style={styles.imagePlaceholder}><Ionicons name="image-outline" size={34} color={colors.muted} /><Text style={styles.placeholderText}>图片还在路上</Text><Button title="刷新图片" variant="secondary" onPress={onRefresh} /></View>;
  if (failedUrl === url) return <View style={styles.imagePlaceholder}>
    <Ionicons name="image-outline" size={34} color={colors.muted} />
    <Text style={styles.placeholderText}>图片暂时没能加载</Text>
    <Pressable accessibilityRole="button" accessibilityLabel={`重新加载第 ${index + 1} 张图片`} testID={`retry-preview-${id}`} onPress={() => { setFailedUrl(undefined); onRefresh(); }}><Text style={{ ...type.caption, color: colors.redText, padding: space.md, minHeight: 44 }}>重新加载</Text></Pressable>
  </View>;
  return <Pressable accessibilityRole="button" accessibilityLabel={`查看笔记第 ${index + 1} 张图片`} disabled={disabled} onPress={() => interaction.open(id)} onLongPress={() => interaction.menu(id)} style={({ pressed }) => [{ flex: 1, opacity: pressed ? 0.82 : 1 }]}><FadeImage source={{ uri: url }} style={styles.carouselImage} resizeMode="cover" testID={`preview-image-${id}`} accessibilityLabel={`笔记第 ${index + 1} 张图片${index === 0 ? '，封面' : ''}`} onError={() => setFailedUrl(url)} /></Pressable>;
}

export default function NotePreview() {
  const { id } = useLocalSearchParams<{ id: string | string[] }>();
  const { api, user } = useSession();
  const projectId = Array.isArray(id) ? id[0] : id;
  return <PreviewPage key={`${api.baseUrl}|${user?.id}|${projectId}`} projectId={projectId} />;
}

function PreviewPage({ projectId }: { projectId?: string }) {
  const { api, user } = useSession();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const [state, setState] = useState<ProjectState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notFound, setNotFound] = useState(false);
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
  const checkpointScope = `${api.baseUrl}|${user?.id ?? 'anonymous'}|${projectId ?? 'missing'}`;
  const [publishProgress, setPublishProgress] = useState(() => readPublishCheckpoint(checkpointScope));
  const publishRef = useRef(publishProgress);
  const [preparing, setPreparing] = useState(false);
  const [publishStep, setPublishStep] = useState('');
  const [publishFailed, setPublishFailed] = useState(false);
  const [aiConfirmed, setAiConfirmed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editActions, setEditActions] = useState<Extract<Action, { type: 'edit_image' }>[]>([]);
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
          setNotFound(false);
          observeGeneration(projectId, '合作项目', next);
          setEditActions(history.flatMap(message => message.action?.type === 'edit_image' ? [message.action] : []));
          hasActiveJobs = next.active_jobs.length > 0;
          setError('');
        }
      } catch (cause) {
        if (alive) {
          setError(errorText(cause));
          if (cause instanceof ApiError && cause.status === 404) { setState(null); setEditActions([]); setNotFound(true); hasActiveJobs = false; }
        }
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
  const images = note?.image_ids.map(imageId => {
    const source = state?.images.find(image => image.id === imageId);
    return { id: imageId, url: source?.url, status: source?.status, source };
  }) ?? [];
  const nickname = user?.nickname || user?.username || '我的穿搭日记';

  function backToStudio() {
    if (notFound) { router.replace('/'); return; }
    if (router.canGoBack()) router.back();
    else if (projectId) router.replace({ pathname: '/projects/[id]', params: { id: projectId } });
    else router.replace('/');
  }

  function updatePublish(next: PublishProgress, step?: string) {
    publishRef.current = next;
    setPublishProgress({ ...next, savedImageIds: [...next.savedImageIds], savedVideoKeys: [...next.savedVideoKeys] });
    writePublishCheckpoint(checkpointScope, next);
    if (step) setPublishStep(step);
  }

  async function copyNote() {
    if (!note) return;
    setActionError('');
    try {
      const text = noteText(note);
      await Clipboard.setStringAsync(text);
      updatePublish({ ...publishRef.current, copiedText: text });
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
      const firstMissing = images.findIndex(image => (!image.url || image.status !== 'succeeded') && !publishRef.current.savedImageIds.includes(image.id));
      const readyPrefix = firstMissing < 0 ? images : images.slice(0, firstMissing);
      const available = readyPrefix.flatMap((image) => image.url ? [{ id: image.id, url: image.url }] : []);
      if (!available.length && note.image_ids.some(imageId => !publishRef.current.savedImageIds.includes(imageId))) throw new Error('图片还没有准备好，稍后再试一次。');
      const result = await saveImages(available, new Set(publishRef.current.savedImageIds), (finished, total) => setProgress({ finished, total }));
      updatePublish({ ...publishRef.current, savedImageIds: [...new Set([...publishRef.current.savedImageIds, ...result.savedIds])] });
      const completed = note.image_ids.filter((imageId) => publishRef.current.savedImageIds.includes(imageId)).length;
      setSavedCount(completed);
      const missing = images.filter(image => (!image.url || image.status !== 'succeeded') && !publishRef.current.savedImageIds.includes(image.id)).length;
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

  async function prepareForPublish() {
    if (!note || !aiConfirmed || savingRef.current) return;
    savingRef.current = true;
    setPreparing(true); setPublishFailed(false); setActionError(''); setSaveFeedback('');
    try {
      await preparePublish(note, images, state?.video, publishRef.current, {
        copy: async text => { await Clipboard.setStringAsync(text); },
        saveImage: async image => {
          const result = await saveImages([image]);
          if (result.failed.length) throw new Error(result.failed[0].message);
        },
        saveVideo,
        share: shareNote,
        changed: (next, step) => { updatePublish(next, step); setCopied(next.copiedText === noteText(note)); },
      });
      setSaveFeedback(publishRef.current.share === 'unavailable'
        ? '当前浏览器不支持系统分享。文案已复制，媒体已下载，请手动打开发布平台。'
        : publishRef.current.share === 'dismissed'
          ? '已取消分享。媒体和文案已准备好，再点一次可重新打开分享。'
          : '发布素材已准备好，请在目标平台选择相册媒体、粘贴文案。');
    } catch (cause) {
      setPublishFailed(true);
      setActionError(`${errorText(cause)} 再点一次只会继续未完成的步骤。`);
    } finally {
      savingRef.current = false;
      setPreparing(false);
    }
  }

  async function editImage(action: Action) {
    if (!projectId || editing) return;
    setEditing(true); setActionError('');
    try {
      await api.sendMessage(projectId, { action }, { onEvent: () => {} });
      try { const next = await api.state(projectId); setState(next); observeGeneration(projectId, '合作项目', next); }
      catch (cause) { setActionError(`修改已提交，进度暂时没同步：${errorText(cause)}`); }
      setRetry(value => value + 1);
    } catch (cause) { setActionError(errorText(cause)); throw cause; }
    finally { setEditing(false); }
  }

  return <ImageInteractions images={state?.images ?? []} editActions={editActions} busy={editing} canEdit={['images', 'note', 'done'].includes(state?.stage ?? '')} onAction={editImage} onReference={image => { if (projectId) router.dismissTo({ pathname: '/projects/[id]', params: { id: projectId, refImage: image.id } }); }}><Page>
    <Header title="笔记预览" subtitle="把灵感，穿进日常" onBack={backToStudio} />
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
      {!!error && !!state && <View style={styles.notice}><Notice text={error} onRetry={() => setRetry((value) => value + 1)} /></View>}
      {loading && !state ? <LoadingSkeleton kind="note" /> : !note ? <StatePanel
        icon={notFound ? 'document-text-outline' : error ? 'cloud-offline-outline' : 'document-text-outline'}
        title={notFound ? '项目已删除或不存在' : error ? '连接暂时中断' : '笔记还在酝酿中'}
        description={notFound ? '这个项目已无法访问，返回列表查看其他合作。' : error || '先回工作台选好图片，我们就把这份穿搭灵感写成一篇笔记。'}
        actionLabel={notFound ? '返回项目列表' : error ? '重试' : '返回工作台'}
        onAction={error && !notFound ? () => setRetry(value => value + 1) : backToStudio}
      /> : <>
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
              <PreviewImage id={image.id} url={image.url} index={index} disabled={preparing || saving} onRefresh={() => setRetry(value => value + 1)} />
              {image.source ? <View pointerEvents="none" style={{ position: 'absolute', top: space.xl + space.lg, left: space.sm, right: space.sm, bottom: 0 }}><FidelityBadge image={image.source} /></View> : null}
            </View>)}
          </ScrollView>
          {images.length > 0 ? <View style={styles.pageBadge}><Badge label={`${Math.min(page + 1, images.length)} / ${images.length}`} tone="inverse" /></View> : null}
          {page === 0 && images.length > 0 ? <View style={styles.coverBadge}><Badge label="封面" /></View> : null}
        </View>
        {images.length > 1 ? <View style={styles.dots}>{images.map((image, index) => <View key={image.id} style={[styles.dot, page === index && styles.dotActive]} />)}</View> : null}
        <AnimatedEntry style={styles.noteContent}>
          {images[page]?.source ? <ImageRevisionInfo image={images[page].source} /> : null}
          <View style={styles.authorRow}>
            <View style={styles.avatar}><Text style={styles.avatarText}>{nickname.slice(0, 1).toUpperCase()}</Text></View>
            <View style={styles.authorInfo}><Text style={styles.authorName}>{nickname}</Text><Text style={styles.authorCaption}>我的穿搭日记</Text></View>
            <Badge label="准备发布" tone="success" />
          </View>
          <Text selectable testID="note-title" style={styles.noteTitle}>{note.title}</Text>
          <View testID="note-body" style={styles.paragraphs}>{note.body.split(/\n+/).filter(paragraph => paragraph.trim()).map((paragraph, index) => <Text selectable key={index} style={styles.noteBody}>{paragraph}</Text>)}</View>
          <View style={styles.tags}>{note.tags.map((tag) => <View key={tag} style={styles.tag}><Text selectable style={styles.tagText}>#{tag.replace(/^#/, '')}</Text></View>)}</View>
          <NoteDisclosure note={note} projectCost={state?.cost_cny} />
          <View style={styles.noteEnd}><View style={styles.endLine} /><Text style={styles.endLabel}>记录穿搭，也记录自己</Text><View style={styles.endLine} /></View>
          {state?.video?.url ? <View style={styles.videoSection}><View style={styles.videoHeading}><Ionicons name="videocam-outline" size={17} color={colors.red} /><Text style={styles.videoTitle}>你的 5 秒穿搭短片</Text></View><VideoPlayer uri={state.video.url} posterUrl={state.video.poster_url} testID="video-player" /></View> : state?.video && ['queued', 'running'].includes(state.video.status) ? <ProgressStrip title="短片正在制作" detail="好了会出现在这里，你可以继续查看笔记。" /> : state?.video?.status === 'failed' ? <View style={styles.videoSection}><Notice text="短片这次没能完成，图文笔记已经为你保留。" /><Button title="回工作台重试短片" variant="secondary" icon="refresh" onPress={backToStudio} testID="retry-video-in-studio" /></View> : null}
          <View style={styles.checklist} testID="publish-checklist">
            <View style={styles.videoHeading}><Ionicons name="checkbox-outline" size={18} color={colors.red} /><Text style={styles.videoTitle}>发布清单</Text></View>
            <Text style={styles.checklistHint}>{images.length} 张图片，按以下顺序保存{Platform.OS === 'web' ? '到下载目录' : '到相册'}。图片已有 AI 角标。</Text>
            {!savedImagesAreInOrder(note.image_ids, publishProgress.savedImageIds) ? <Text accessibilityRole="alert" testID="publish-order-changed" style={styles.actionError}>图片顺序已调整。已保存的图片不会重复下载，请在发布平台按这份清单重新排列。</Text> : null}
            <Text testID="publish-copy" style={styles.checklistItem}>{publishProgress.copiedText === noteText(note) ? '✓ 文案已复制' : '○ 文案待复制'}</Text>
            {images.map((image, index) => <Text key={image.id} testID={`publish-image-${image.id}`} style={styles.checklistItem}>{publishProgress.savedImageIds.includes(image.id) ? '✓' : '○'} 图片 {index + 1}{index === 0 ? ' · 封面' : ''} · {publishProgress.savedImageIds.includes(image.id) ? '已保存' : image.url && image.status === 'succeeded' ? '待保存' : '等待生成'}</Text>)}
            <Text testID="publish-video" style={styles.checklistItem}>{state?.video?.status === 'succeeded'
              ? `${publishProgress.savedVideoKeys.includes(videoKey(state.video) ?? '') ? '✓' : '○'} 视频 · ${publishProgress.savedVideoKeys.includes(videoKey(state.video) ?? '') ? '已保存' : '待保存'}`
              : state?.video && ['queued', 'running'].includes(state.video.status) ? '○ 视频 · 制作中，完成后继续' : state?.video?.status === 'failed' ? '— 视频未生成成功，本次仅发布图文' : '— 无视频，本次发布图文'}</Text>
            <Pressable accessibilityRole="checkbox" accessibilityLabel="发布时勾选平台 AI 内容声明" accessibilityState={{ checked: aiConfirmed, disabled: preparing || saving }} disabled={preparing || saving} aria-checked={aiConfirmed} testID="publish-ai-confirm" onPress={() => setAiConfirmed(value => !value)} style={styles.aiCheckbox}>
              <Ionicons name={aiConfirmed ? 'checkbox' : 'square-outline'} size={22} color={aiConfirmed ? colors.red : colors.muted} />
              <Text style={styles.aiCheckboxText}>{aiConfirmed ? '已确认：发布时勾选平台 AI 内容声明' : '我会在发布时勾选平台 AI 内容声明'}</Text>
            </Pressable>
            <Text style={styles.checklistHint}>这里的确认不会替你设置发布平台。请在发布页手动勾选 AI 内容声明，并按清单顺序选择图片和视频。</Text>
            <Text testID="publish-share" style={styles.checklistHint}>{publishProgress.share === 'unavailable' ? '当前浏览器不支持系统分享，可手动打开发布平台。' : publishProgress.share === 'dismissed' ? '分享已取消，可重新打开。' : publishProgress.share === 'shared' ? '系统分享面板已打开；是否发布由你在目标平台确认。' : '素材准备完成后会打开系统分享面板。'}</Text>
          </View>
          <Button title="返回工作台继续创作" variant="ghost" icon="arrow-back" onPress={backToStudio} />
        </AnimatedEntry>
      </>}
    </ScrollView>
    {note ? <View style={styles.bottomBar}>
      {!!actionError ? <Toast text={actionError} tone="danger" onDismiss={() => setActionError('')} /> : saveFeedback ? <Toast text={saveFeedback} tone="success" onDismiss={() => setSaveFeedback('')} /> : copied ? <Toast text="文案已复制，可以去发布啦。" tone="success" onDismiss={() => setCopied(false)} /> : null}
      {preparing && <ProgressStrip title={publishStep || '正在准备发布'} detail="文案与媒体会按发布清单依次准备" />}
      <Button title={preparing ? publishStep || '正在准备发布' : publishFailed ? '继续准备发布' : publishProgress.share ? '重新打开分享' : '准备发布'} icon="share-outline" loading={preparing} disabled={!aiConfirmed || saving || !images.length} onPress={() => void prepareForPublish()} testID="prepare-publish" />
      {!aiConfirmed ? <Text style={styles.checklistHint}>先在发布清单确认 AI 内容声明，即可准备发布。</Text> : null}
      <View style={styles.bottomButtons}>
        <View style={styles.bottomButton}><Button title={copied ? '已复制文案' : '复制文案'} icon={copied ? 'checkmark' : 'copy-outline'} disabled={saving || preparing} variant="secondary" onPress={() => void copyNote()} testID="copy-note" /></View>
        <View style={styles.bottomButton}><Button title={saving ? `保存中 ${progress.finished}/${progress.total}` : saveFailed ? savedCount ? '重试未保存' : '重试保存图片' : '保存图片'} variant="secondary" icon="download-outline" loading={saving} disabled={!images.length || preparing} onPress={() => void saveNoteImages()} testID="save-images" /></View>
      </View>
    </View> : null}
  </Page></ImageInteractions>;
}

const styles = StyleSheet.create({
  scrollContent: { paddingBottom: space.lg },
  notice: { margin: space.lg },
  carouselFrame: { alignSelf: 'center', width: '100%', backgroundColor: colors.imagePlaceholder, minHeight: 44, borderBottomLeftRadius: radius.lg, borderBottomRightRadius: radius.lg, overflow: 'hidden' },
  carouselImage: { width: '100%', height: '100%' },
  imagePlaceholder: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.md },
  placeholderText: { ...type.caption, color: colors.muted },
  pageBadge: { position: 'absolute', right: space.lg, top: space.lg },
  coverBadge: { position: 'absolute', left: space.lg, top: space.lg },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: space.sm, marginTop: space.lg },
  dot: { height: space.xs, width: space.xs, borderRadius: radius.sm, backgroundColor: colors.border },
  dotActive: { width: space.lg, backgroundColor: colors.red },
  noteContent: { paddingHorizontal: space.xl, paddingTop: space.xl, gap: space.xl },
  authorRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  avatar: { width: 44, height: 44, borderRadius: radius.md, backgroundColor: colors.blush, justifyContent: 'center', alignItems: 'center' },
  avatarText: { ...type.subtitle, color: colors.redText, fontWeight: '700' },
  authorInfo: { flex: 1, gap: space.xs },
  authorName: { ...type.caption, color: colors.ink, fontWeight: '600' },
  authorCaption: { ...type.badge, color: colors.muted },
  noteTitle: { ...type.heading, color: colors.ink, letterSpacing: -0.3 },
  paragraphs: { gap: space.lg },
  noteBody: { ...type.reading, color: colors.ink },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  tag: { backgroundColor: colors.blush, borderRadius: radius.sm, paddingHorizontal: space.md, paddingVertical: space.sm },
  tagText: { ...type.caption, color: colors.redText, fontWeight: '500' },
  noteEnd: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  endLine: { height: 1, backgroundColor: colors.border, flex: 1 },
  endLabel: { ...type.badge, color: colors.muted, letterSpacing: 1 },
  checklist: { padding: space.lg, backgroundColor: colors.paper, borderRadius: radius.md, gap: space.md, borderWidth: 1, borderColor: colors.border },
  checklistHint: { ...type.caption, color: colors.muted },
  checklistItem: { ...type.caption, color: colors.ink },
  aiCheckbox: { flexDirection: 'row', gap: space.md, alignItems: 'center', paddingVertical: space.sm, minHeight: 44 },
  aiCheckboxText: { ...type.caption, color: colors.ink, flex: 1 },
  videoSection: { gap: space.md },
  videoHeading: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  videoTitle: { ...type.body, color: colors.ink, fontWeight: '600' },
  bottomBar: { paddingHorizontal: space.lg, paddingVertical: space.md, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.surface, gap: space.sm },
  bottomButtons: { flexDirection: 'row', gap: space.md },
  bottomButton: { flex: 1 },
  actionError: { ...type.caption, color: colors.danger },
});
