import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useRef, useState, type ComponentRef } from 'react';
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
import { AnimatedEntry, Badge, Button, FadeImage, Field, Header, LoadingSkeleton, Notice, Page, ProgressStrip, StatePanel, Toast, errorText } from '../../components/ui';
import { colors, radius, space, type } from '../../theme';
import { useSession } from '../../context/Session';
import { saveImages, saveVideo, shareNote } from '../../lib/media';
import { noteText, preparePublish, savedImagesAreInOrder, videoKey, type PublishProgress } from '../../lib/publish';
import { readPublishCheckpoint, writePublishCheckpoint } from '../../lib/publishCheckpoint';
import { observeGeneration } from '../../lib/notificationRuntime';
import { applyNoteDraft, changeNoteDraft, cleanTag, draftFromNote, hasNoteDraftConflict, keepNoteDraft, limitTitle, moveDraftImage, NOTE_TITLE_LIMIT, readNoteDraft, readPreviousNoteDraft, reconcileNoteDraft, titleLength, writeNoteDraft, writePreviousNoteDraft, type NoteDraft } from '../../lib/noteDraft';
import { localDraftStorage } from '../../lib/noteDraftStorage';
import { coverFirstImageIds, isCoverImage } from '../../lib/images';
import { previewUrl } from '../../lib/previewUrl';

function PreviewImage({ id, url, index, onRefresh, disabled }: { id: string; url?: string; index: number; onRefresh: () => void; disabled?: boolean }) {
  const [failedUrl, setFailedUrl] = useState<string>();
  const interaction = useImageInteractions();
  if (!url) return <View style={styles.imagePlaceholder}><Ionicons name="image-outline" size={34} color={colors.muted} /><Text style={styles.placeholderText}>图片还在路上</Text><Button title="刷新图片" variant="secondary" onPress={onRefresh} /></View>;
  if (failedUrl === url) return <View style={styles.imagePlaceholder}>
    <Ionicons name="image-outline" size={34} color={colors.muted} />
    <Text style={styles.placeholderText}>图片暂时没能加载</Text>
    <Pressable accessibilityRole="button" accessibilityLabel={`重新加载第 ${index + 1} 张图片`} testID={`retry-preview-${id}`} onPress={() => { setFailedUrl(undefined); onRefresh(); }}><Text style={{ ...type.caption, color: colors.redText, padding: space.md, minHeight: 44 }}>重新加载</Text></Pressable>
  </View>;
  return <Pressable accessibilityRole="button" accessibilityLabel={`查看笔记第 ${index + 1} 张图片`} disabled={disabled} onPress={() => interaction.open(id)} onLongPress={() => interaction.menu(id)} style={({ pressed }) => [{ flex: 1, opacity: pressed ? 0.82 : 1 }]}><FadeImage source={{ uri: previewUrl(url, 1080) }} style={styles.carouselImage} resizeMode="cover" testID={`preview-image-${id}`} accessibilityLabel={`笔记第 ${index + 1} 张图片${index === 0 ? '，封面' : ''}`} onError={() => setFailedUrl(url)} /></Pressable>;
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
  const { width, height: windowHeight } = useWindowDimensions();
  // 笔记像小红书一样：图片占屏幕上半，标题和正文不用往下滑就能看到。
  const carouselMaxWidth = Math.round(windowHeight * 0.52 * 3 / 4);
  const [state, setState] = useState<ProjectState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notFound, setNotFound] = useState(false);
  const [retry, setRetry] = useState(0);
  const [carouselWidth, setCarouselWidth] = useState(Math.min(width, 520, carouselMaxWidth));
  const [page, setPage] = useState(0);
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState({ finished: 0, total: 0 });
  const [saveFeedback, setSaveFeedback] = useState('');
  const [actionError, setActionError] = useState('');
  const [savedCount, setSavedCount] = useState(0);
  const [saveFailed, setSaveFailed] = useState(false);
  const checkpointScope = `${api.baseUrl}|${user?.id ?? 'anonymous'}|${projectId ?? 'missing'}`;
  const [draft, setDraft] = useState<NoteDraft | null>(() => readNoteDraft(checkpointScope, localDraftStorage));
  const [previousDraft, setPreviousDraft] = useState<NoteDraft | null>(() => readPreviousNoteDraft(checkpointScope, localDraftStorage));
  const [draftStatus, setDraftStatus] = useState(() => draft ? '已恢复本地草稿' : '');
  const [tagInput, setTagInput] = useState('');
  const carouselRef = useRef<ComponentRef<typeof ScrollView>>(null);
  const [publishProgress, setPublishProgress] = useState(() => readPublishCheckpoint(checkpointScope));
  const publishRef = useRef(publishProgress);
  const [preparing, setPreparing] = useState(false);
  const [publishStep, setPublishStep] = useState('');
  const [publishFailed, setPublishFailed] = useState(false);
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
        if (!projectId && alive) { setError('找不到这份项目，请返回编导间重新打开。'); setLoading(false); }
        return;
      }
      inFlight = true;
      try {
        const [next, history] = await Promise.all([api.state(projectId), api.messages(projectId)]);
        if (alive) {
          setState(next);
          if (next.note) setDraft(current => reconcileNoteDraft(next.note!, current));
          setNotFound(false);
          observeGeneration(projectId, '这组片', next);
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

  const editableNote = state?.note ? applyNoteDraft(state.note, draft) : undefined;
  const note = editableNote ? { ...editableNote, image_ids: coverFirstImageIds(editableNote.image_ids, state?.images ?? [], state?.script) } : undefined;
  const coverLocked = Boolean(note?.image_ids[0] && state?.images.some(image => image.id === note.image_ids[0] && isCoverImage(image, state.images, state.script, note.image_ids)));
  const draftConflict = state?.note ? hasNoteDraftConflict(state.note, draft) : false;
  const aiConfirmed = draft?.aiConfirmed ?? true;
  const titleCount = titleLength(note?.title ?? '');
  const titleValid = !!note?.title.trim() && titleCount <= NOTE_TITLE_LIMIT;
  const images = note?.image_ids.map(imageId => {
    const source = state?.images.find(image => image.id === imageId);
    return { id: imageId, url: source?.url, status: source?.status, source, manuallyAccepted: note.accepted_unverified_ids?.includes(imageId) ?? false };
  }) ?? [];
  const nickname = user?.nickname || user?.username || '我的穿搭日记';

  function updateDraft(changes: Partial<NoteDraft>) {
    if (!note || savingRef.current) return;
    setDraft(current => changeNoteDraft(current ?? draftFromNote(note), changes));
    setDraftStatus('有未保存的编辑，离开前请保存');
    setCopied(false);
    setSaveFeedback('');
  }

  function addTag() {
    if (!note) return;
    const tag = cleanTag(tagInput);
    if (!tag) return;
    if (note.tags.includes(tag)) { setActionError('这个话题已经添加过了。'); return; }
    updateDraft({ tags: [...note.tags, tag] });
    setTagInput('');
    setActionError('');
  }

  function reorderImage(index: number, offset: -1 | 1) {
    if (!note || coverLocked && (index === 0 || index + offset === 0)) return;
    updateDraft({ image_ids: moveDraftImage(note.image_ids, index, offset) });
    setPage(0);
    carouselRef.current?.scrollTo({ x: 0, animated: false });
  }

  function saveDraft() {
    if (!note || savingRef.current) return;
    const next = draft ?? draftFromNote(note);
    if (writeNoteDraft(checkpointScope, next, localDraftStorage)) {
      setDraftStatus('草稿已保存到本机');
      setSaveFeedback('草稿已保存到本机，重新打开会恢复。');
      setActionError('');
    } else {
      setDraftStatus('草稿未能保存，请重试');
      setActionError('本机存储暂时不可用，草稿未能保存。请重试或先复制文案。');
    }
  }

  function resolveDraft(keepLocal: boolean) {
    if (!state?.note || savingRef.current) return;
    const next = keepLocal && draft ? keepNoteDraft(state.note, draft) : draftFromNote(state.note);
    if (!keepLocal && draft?.dirty) {
      if (!writePreviousNoteDraft(checkpointScope, draft, localDraftStorage)) {
        setActionError('本机存储暂时不可用，先保留你的修改，稍后再试。');
        return;
      }
      setPreviousDraft(draft);
    }
    if (!writeNoteDraft(checkpointScope, next, localDraftStorage)) {
      setActionError('本机存储暂时不可用，版本选择未保存，请重试。');
      return;
    }
    setDraft(next);
    setDraftStatus(keepLocal ? '已保留你的修改，草稿已保存到本机' : '已采用服务端最新笔记');
    setActionError(''); setCopied(false); setSaveFeedback('');
    setPage(0);
    carouselRef.current?.scrollTo({ x: 0, animated: false });
  }

  function restorePreviousDraft() {
    if (!previousDraft || savingRef.current) return;
    if (!writeNoteDraft(checkpointScope, previousDraft, localDraftStorage)) {
      setActionError('本机存储暂时不可用，草稿未能恢复，请重试。');
      return;
    }
    setDraft(previousDraft);
    setDraftStatus('已恢复你的上一份修改');
    setActionError(''); setCopied(false); setSaveFeedback('');
    setPage(0);
    carouselRef.current?.scrollTo({ x: 0, animated: false });
  }

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
    if (!note || !aiConfirmed || !titleValid || savingRef.current) return;
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
    if (!projectId || editing) return false;
    setEditing(true); setActionError('');
    let reused: boolean | undefined;
    try {
      const result = await api.sendMessage(projectId, { action }, { onEvent: event => {
        if ((event.type === 'job' || event.type === 'done') && typeof event.data.reused === 'boolean') reused = event.data.reused;
      } });
      if (typeof result.reused === 'boolean') reused = result.reused;
      try {
        const next = await api.state(projectId); setState(next);
        if (next.pending_action?.type === 'edit_image' && typeof next.pending_action.reused === 'boolean') reused = next.pending_action.reused;
        if (next.note) setDraft(current => reconcileNoteDraft(next.note!, current));
        observeGeneration(projectId, '这组片', next);
      }
      catch (cause) { setActionError(`修改已提交，进度暂时没同步：${errorText(cause)}`); }
      setRetry(value => value + 1);
      return { accepted: true, ...(typeof reused === 'boolean' ? { reused } : {}) };
    } catch (cause) { if (!(cause instanceof ApiError) || cause.code !== 'unverified_image') setActionError(errorText(cause)); throw cause; }
    finally { setEditing(false); }
  }

  return <ImageInteractions images={state?.images ?? []} script={state?.script} editActions={editActions} busy={editing} canEdit={['images', 'note'].includes(state?.stage ?? '')} stage={state?.stage} note={note} pendingAction={state?.pending_action} onAction={editImage} onReference={image => { if (projectId) router.dismissTo({ pathname: '/projects/[id]', params: { id: projectId, refImage: image.id } }); }}><Page>
    <Header title="编辑笔记" subtitle="把灵感，穿进日常" onBack={backToStudio} />
    <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
      {!!error && !!state && <View style={styles.notice}><Notice text={error} onRetry={() => setRetry((value) => value + 1)} /></View>}
      {loading && !state ? <LoadingSkeleton kind="note" /> : !note ? <StatePanel
        icon={notFound ? 'document-text-outline' : error ? 'cloud-offline-outline' : 'document-text-outline'}
        title={notFound ? '项目已删除或不存在' : error ? '连接暂时中断' : '笔记还在酝酿中'}
        description={notFound ? '这组片已无法访问，返回列表看看其他片场。' : error || '先回编导间选好图片，我们就把这份穿搭灵感写成一篇笔记。'}
        actionLabel={notFound ? '返回项目列表' : error ? '重试' : '返回编导间'}
        onAction={error && !notFound ? () => setRetry(value => value + 1) : backToStudio}
      /> : <>
        {draftConflict ? <View style={styles.draftConflict} testID="note-draft-conflict" accessibilityRole="alert">
          <Text style={styles.videoTitle}>笔记有新版本</Text>
          <Text style={styles.checklistHint}>你的修改还在。选一下这次发布用哪一版。</Text>
          <View style={styles.conflictButtons}>
            <Button title="保留我的修改" variant="secondary" disabled={preparing || saving} onPress={() => resolveDraft(true)} testID="keep-note-draft" />
            <Button title="采用新版本" disabled={preparing || saving} onPress={() => resolveDraft(false)} testID="adopt-server-note" />
          </View>
        </View> : null}
        <View style={styles.authorHeader}>
          <View style={styles.authorRow}>
            <View style={styles.avatar}><Text style={styles.avatarText}>{nickname.slice(0, 1).toUpperCase()}</Text></View>
            <View style={styles.authorInfo}><Text style={styles.authorName}>{nickname}</Text><Text style={styles.authorCaption}>我的穿搭日记</Text></View>
            <Badge label="准备发布" tone="success" />
          </View>
        </View>
        <View onLayout={(event) => setCarouselWidth(Math.min(event.nativeEvent.layout.width, carouselMaxWidth))} style={styles.carouselFrame}>
          <ScrollView
            ref={carouselRef}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            testID="preview-carousel"
            accessibilityLabel="笔记图片轮播，左右滑动查看"
            style={{ width: carouselWidth, alignSelf: 'center' }}
            scrollEventThrottle={100}
            onScroll={(event) => setPage(Math.round(event.nativeEvent.contentOffset.x / carouselWidth))}
          >
            {images.map((image, index) => <View key={image.id} style={{ width: carouselWidth, aspectRatio: 3 / 4 }}>
              <PreviewImage id={image.id} url={image.url} index={index} disabled={preparing || saving} onRefresh={() => setRetry(value => value + 1)} />
              {image.source ? <View pointerEvents="none" style={{ position: 'absolute', top: space.xl + space.lg, left: space.sm, right: space.sm, bottom: 0 }}><FidelityBadge image={image.source} /></View> : null}
              {image.manuallyAccepted ? <View pointerEvents="none" style={styles.manualBadge}><Badge label="手动采用" tone="brand" /></View> : null}
            </View>)}
          </ScrollView>
          {images.length > 0 ? <View style={styles.pageBadge}><Badge label={`${Math.min(page + 1, images.length)} / ${images.length}`} tone="inverse" /></View> : null}
          {page === 0 && images.length > 0 ? <View style={styles.coverBadge}><Badge label="封面" /></View> : null}
        </View>
        {images.length > 1 ? <View style={styles.dots}>{images.map((image, index) => <View key={image.id} style={[styles.dot, page === index && styles.dotActive]} />)}</View> : null}
        <AnimatedEntry style={styles.noteContent}>
          {images[page]?.source ? <ImageRevisionInfo image={images[page].source} /> : null}
          <View style={styles.formSection}>
            <Field label="标题" value={note.title} placeholder="写一个让人想点开的标题" editable={!preparing && !saving} onChangeText={title => updateDraft({ title: limitTitle(title) })} testID="note-title" style={styles.noteTitle} />
            <Text testID="note-title-count" accessibilityLabel={`标题 ${titleCount} 字，最多 ${NOTE_TITLE_LIMIT} 字`} style={[styles.titleCount, !titleValid && styles.actionError]}>{titleCount}/{NOTE_TITLE_LIMIT}</Text>
            {!titleValid ? <Text style={styles.actionError}>{titleCount > NOTE_TITLE_LIMIT ? '标题最多 20 字，请精简后再发布。' : '加一个标题，让这篇穿搭更容易被看见。'}</Text> : null}
          </View>
          <Field label="正文" value={note.body} placeholder="分享今天的穿搭和心情…" multiline editable={!preparing && !saving} onChangeText={body => updateDraft({ body })} testID="note-body" style={styles.noteBody} />
          <View style={styles.formSection}>
            <Text style={styles.formLabel}>话题</Text>
            <View style={styles.tags}>{note.tags.map(tag => <Pressable key={tag} accessibilityRole="button" accessibilityLabel={`删除话题 ${tag}`} disabled={preparing || saving} testID={`remove-note-tag-${tag}`} onPress={() => updateDraft({ tags: note.tags.filter(item => item !== tag) })} style={styles.tag}><Text style={styles.tagText}>#{tag}</Text><Ionicons name="close" size={14} color={colors.redText} /></Pressable>)}</View>
            <View style={styles.tagInputRow}><View style={styles.tagInput}><Field label="添加话题" value={tagInput} placeholder="例如：周末穿搭" editable={!preparing && !saving} onChangeText={setTagInput} onSubmitEditing={addTag} returnKeyType="done" testID="note-tag-input" /></View><Button title="添加" icon="add" variant="secondary" disabled={!cleanTag(tagInput) || preparing || saving} onPress={addTag} testID="add-note-tag" /></View>
          </View>
          <View style={styles.formSection}>
            <View style={styles.videoHeading}><Ionicons name="images-outline" size={18} color={colors.red} /><Text style={styles.videoTitle}>图片顺序</Text></View>
            <Text style={styles.checklistHint}>主图固定在第一位，其他图片可调整顺序。</Text>
            {images.map((image, index) => <View key={image.id} style={styles.orderRow} testID={`note-image-order-${image.id}`}>
              {image.url ? <FadeImage source={{ uri: previewUrl(image.url, 360) }} style={styles.orderThumbnail} /> : <View style={styles.orderThumbnail}><Ionicons name="image-outline" size={22} color={colors.muted} /></View>}
              <Text style={styles.orderLabel}>图片 {index + 1}{index === 0 ? coverLocked ? ' · 主图' : ' · 封面' : ''}{image.manuallyAccepted ? ' · 手动采用' : ''}</Text>
              <Pressable accessibilityRole="button" accessibilityLabel={`图片 ${index + 1} 前移`} accessibilityState={{ disabled: (index === 0 || coverLocked && index === 1) || preparing || saving }} disabled={(index === 0 || coverLocked && index === 1) || preparing || saving} onPress={() => reorderImage(index, -1)} testID={`move-note-image-${image.id}-earlier`} style={[styles.orderButton, ((index === 0 || coverLocked && index === 1) || preparing || saving) && styles.disabledControl]}><Ionicons name="arrow-up" size={18} color={colors.redText} /></Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel={`图片 ${index + 1} 后移`} accessibilityState={{ disabled: (index === images.length - 1 || coverLocked && index === 0) || preparing || saving }} disabled={(index === images.length - 1 || coverLocked && index === 0) || preparing || saving} onPress={() => reorderImage(index, 1)} testID={`move-note-image-${image.id}-later`} style={[styles.orderButton, ((index === images.length - 1 || coverLocked && index === 0) || preparing || saving) && styles.disabledControl]}><Ionicons name="arrow-down" size={18} color={colors.redText} /></Pressable>
            </View>)}
          </View>
          <View style={styles.draftNotice}><Ionicons name="save-outline" size={16} color={colors.muted} /><View style={{ flex: 1, gap: space.xs }}><Text style={styles.checklistHint}>编辑会在本机覆盖发布文案，原始笔记保留在编导间。草稿保存在当前设备。</Text>{!!draftStatus && <Text testID="note-draft-status" accessibilityLiveRegion="polite" style={styles.draftStatus}>{draftStatus}</Text>}</View></View>
          <View style={styles.draftActions}>
            <Button title="恢复原始笔记" variant="ghost" icon="refresh-outline" disabled={preparing || saving} onPress={() => resolveDraft(false)} testID="restore-server-note" />
            {previousDraft ? <Button title="恢复我的草稿" variant="ghost" disabled={preparing || saving} onPress={restorePreviousDraft} testID="restore-previous-note-draft" /> : null}
          </View>
          <NoteDisclosure note={note} projectCost={state?.cost_cny} projectPoints={state?.cost_points} />
          <View style={styles.noteEnd}><View style={styles.endLine} /><Text style={styles.endLabel}>记录穿搭，也记录自己</Text><View style={styles.endLine} /></View>
          {state?.video?.url ? <View style={styles.videoSection}><View style={styles.videoHeading}><Ionicons name="videocam-outline" size={17} color={colors.red} /><Text style={styles.videoTitle}>你的 5 秒穿搭短片</Text></View><VideoPlayer uri={state.video.url} posterUrl={state.video.poster_url} testID="video-player" /></View> : state?.video && ['queued', 'running'].includes(state.video.status) ? <ProgressStrip title="短片正在制作" detail="好了会出现在这里，你可以继续查看笔记。" /> : state?.video?.status === 'failed' ? <View style={styles.videoSection}><Notice text="短片这次没能完成，图文笔记已经为你保留。" /><Button title="回编导间重试短片" variant="secondary" icon="refresh" onPress={backToStudio} testID="retry-video-in-studio" /></View> : null}
          <View style={styles.checklist} testID="publish-checklist">
            <View style={styles.videoHeading}><Ionicons name="checkbox-outline" size={18} color={colors.red} /><Text style={styles.videoTitle}>发布清单</Text></View>
            <Text style={styles.checklistHint}>{images.length} 张图片，按以下顺序保存{Platform.OS === 'web' ? '到下载目录' : '到相册'}。图片已有 AI 角标。</Text>
            {!savedImagesAreInOrder(note.image_ids, publishProgress.savedImageIds) ? <Text accessibilityRole="alert" testID="publish-order-changed" style={styles.actionError}>图片顺序已调整。已保存的图片不会重复下载，请在发布平台按这份清单重新排列。</Text> : null}
            <Text testID="publish-copy" style={styles.checklistItem}>{publishProgress.copiedText === noteText(note) ? '✓ 文案已复制' : '○ 文案待复制'}</Text>
            {images.map((image, index) => <Text key={image.id} testID={`publish-image-${image.id}`} style={styles.checklistItem}>{publishProgress.savedImageIds.includes(image.id) ? '✓' : '○'} 图片 {index + 1}{index === 0 ? coverLocked ? ' · 主图' : ' · 封面' : ''}{image.manuallyAccepted ? ' · 手动采用' : ''} · {publishProgress.savedImageIds.includes(image.id) ? '已保存' : image.url && image.status === 'succeeded' ? '待保存' : '等待生成'}</Text>)}
            <Text testID="publish-video" style={styles.checklistItem}>{state?.video?.status === 'succeeded'
              ? `${publishProgress.savedVideoKeys.includes(videoKey(state.video) ?? '') ? '✓' : '○'} 视频 · ${publishProgress.savedVideoKeys.includes(videoKey(state.video) ?? '') ? '已保存' : '待保存'}`
              : state?.video && ['queued', 'running'].includes(state.video.status) ? '○ 视频 · 制作中，完成后继续' : state?.video?.status === 'failed' ? '— 视频未生成成功，本次仅发布图文' : '— 无视频，本次发布图文'}</Text>
            <Pressable accessibilityRole="checkbox" accessibilityLabel="AI 生成内容，发布时勾选平台 AI 内容声明" accessibilityState={{ checked: aiConfirmed, disabled: preparing || saving }} disabled={preparing || saving} aria-checked={aiConfirmed} testID="publish-ai-confirm" onPress={() => updateDraft({ aiConfirmed: !aiConfirmed })} style={styles.aiCheckbox}>
              <Ionicons name={aiConfirmed ? 'checkbox' : 'square-outline'} size={22} color={aiConfirmed ? colors.red : colors.muted} />
              <Text style={styles.aiCheckboxText}>{aiConfirmed ? 'AI 生成内容 · 已确认发布时勾选平台声明' : 'AI 生成内容 · 我会在发布时勾选平台声明'}</Text>
            </Pressable>
            <Text style={styles.checklistHint}>这里的确认不会替你设置发布平台。请在发布页手动勾选 AI 内容声明，并按清单顺序选择图片和视频。</Text>
            <Text testID="publish-share" style={styles.checklistHint}>{publishProgress.share === 'unavailable' ? '当前浏览器不支持系统分享，可手动打开发布平台。' : publishProgress.share === 'dismissed' ? '分享已取消，可重新打开。' : publishProgress.share === 'shared' ? '系统分享面板已打开；是否发布由你在目标平台确认。' : '素材准备完成后会打开系统分享面板。'}</Text>
          </View>
          <Button title="返回编导间继续创作" variant="ghost" icon="arrow-back" onPress={backToStudio} />
        </AnimatedEntry>
      </>}
    </ScrollView>
    {note ? <View style={styles.bottomBar}>
      {!!actionError ? <Toast text={actionError} tone="danger" onDismiss={() => setActionError('')} /> : saveFeedback ? <Toast text={saveFeedback} tone="success" onDismiss={() => setSaveFeedback('')} /> : copied ? <Toast text="文案已复制，可以去发布啦。" tone="success" onDismiss={() => setCopied(false)} /> : null}
      {preparing && <ProgressStrip title={publishStep || '正在准备发布'} detail="文案与媒体会按发布清单依次准备" />}
      <View style={styles.bottomButtons}>
        <View style={styles.draftButton}><Button title="保存草稿" variant="secondary" icon="save-outline" disabled={saving || preparing} onPress={saveDraft} testID="save-note-draft" /></View>
        <View style={styles.publishButton}><Button title={preparing ? publishStep || '正在准备发布' : publishFailed ? '继续准备发布' : publishProgress.share ? '重新打开分享' : '准备发布'} icon="share-outline" loading={preparing} disabled={!aiConfirmed || !titleValid || saving || !images.length} onPress={() => void prepareForPublish()} testID="prepare-publish" /></View>
      </View>
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
  carouselFrame: { alignSelf: 'center', width: '100%', backgroundColor: colors.imagePlaceholder, minHeight: 44, borderRadius: radius.lg, overflow: 'hidden' },
  carouselImage: { width: '100%', height: '100%' },
  imagePlaceholder: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.md },
  placeholderText: { ...type.caption, color: colors.muted },
  pageBadge: { position: 'absolute', right: space.lg, top: space.lg },
  coverBadge: { position: 'absolute', left: space.lg, top: space.lg },
  manualBadge: { position: 'absolute', left: space.lg, bottom: space.lg },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: space.sm, marginTop: space.lg },
  dot: { height: space.xs, width: space.xs, borderRadius: radius.sm, backgroundColor: colors.border },
  dotActive: { width: space.lg, backgroundColor: colors.red },
  noteContent: { paddingHorizontal: space.xl, paddingTop: space.xl, gap: space.xl },
  authorHeader: { paddingHorizontal: space.xl, paddingVertical: space.md },
  authorRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  avatar: { width: 44, height: 44, borderRadius: radius.md, backgroundColor: colors.blush, justifyContent: 'center', alignItems: 'center' },
  avatarText: { ...type.subtitle, color: colors.redText, fontWeight: '700' },
  authorInfo: { flex: 1, gap: space.xs },
  authorName: { ...type.caption, color: colors.ink, fontWeight: '600' },
  authorCaption: { ...type.badge, color: colors.muted },
  noteTitle: { ...type.heading, color: colors.ink, letterSpacing: -0.3 },
  noteBody: { ...type.reading, color: colors.ink, minHeight: 220 },
  formSection: { gap: space.sm },
  formLabel: { ...type.label, color: colors.ink },
  titleCount: { ...type.caption, color: colors.muted, textAlign: 'right' },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  tag: { backgroundColor: colors.blush, borderRadius: radius.sm, paddingHorizontal: space.md, paddingVertical: space.sm, minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: space.sm },
  tagText: { ...type.caption, color: colors.redText, fontWeight: '500' },
  tagInputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: space.sm },
  tagInput: { flex: 1 },
  orderRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.xs },
  orderThumbnail: { width: 44, height: 58, borderRadius: radius.sm, backgroundColor: colors.imagePlaceholder, alignItems: 'center', justifyContent: 'center' },
  orderLabel: { ...type.caption, color: colors.ink, flex: 1 },
  orderButton: { width: 44, height: 44, borderRadius: radius.sm, backgroundColor: colors.blush, alignItems: 'center', justifyContent: 'center' },
  disabledControl: { opacity: 0.35 },
  draftNotice: { padding: space.md, backgroundColor: colors.paper, borderRadius: radius.sm, flexDirection: 'row', gap: space.sm },
  draftConflict: { margin: space.lg, padding: space.lg, backgroundColor: colors.blush, borderRadius: radius.md, gap: space.md },
  conflictButtons: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  draftActions: { gap: space.xs },
  draftStatus: { ...type.caption, color: colors.green },
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
  draftButton: { flex: 1 },
  publishButton: { flex: 1.4 },
  actionError: { ...type.caption, color: colors.danger },
});
