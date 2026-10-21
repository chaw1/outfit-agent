import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AppState, KeyboardAvoidingView, Modal, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { Project, Stage } from '../api/types';
import { InspirationWall } from '../components/InspirationWall';
import { AssetLibraryEntry } from '../components/AssetLibrary';
import { StudioGlow } from '../components/ds/StudioGlow';
import { AnimatedEntry, Badge, Button, FadeImage, Field, IconButton, LoadingSkeleton, Page, StatePanel, Toast, errorText, stageNames, styles } from '../components/ui';
import { useSession } from '../context/Session';
import { notificationOwner } from '../lib/completionTracker';
import { recentCompletions, subscribeCompletions } from '../lib/completionFeed';
import { filterProjects } from '../lib/profile';
import { filterByStage, inProgressProjects, otherProjects, stageFilters } from '../lib/projectProgress';
import { Chip } from '../components/ds/Chip';
import { layout, radius, space, studio, type } from '../theme';
import { previewUrl } from '../lib/previewUrl';

export default function Projects() {
  const { api, token, user, baseUrl } = useSession();
  const router = useRouter();
  const [items, setItems] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [stageFilter, setStageFilter] = useState<Stage | ''>('');
  const [candidate, setCandidate] = useState<Project | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [menuMode, setMenuMode] = useState<'menu' | 'rename' | 'delete'>('menu');
  const [projectTitle, setProjectTitle] = useState('');
  const [updating, setUpdating] = useState(false);
  const [menuError, setMenuError] = useState('');
  const [feedback, setFeedback] = useState('');
  const requestId = useRef(0);
  const focused = useRef(false);
  const removedIds = useRef(new Set<string>());
  const candidateRef = useRef<Project | null>(null);
  const scope = notificationOwner({ baseUrl, userId: user?.id ?? '' });
  const subscribe = useCallback((listener: () => void) => subscribeCompletions(scope, listener), [scope]);
  const snapshot = useCallback(() => recentCompletions(scope), [scope]);
  const completions = useSyncExternalStore(subscribe, snapshot, snapshot).filter(item => items.some(project => project.id === item.projectId));
  function chooseCandidate(project: Project | null, mode: 'menu' | 'rename' | 'delete' = 'menu') {
    setMenuMode(mode);
    setProjectTitle(project?.title ?? '');
    setMenuError('');
    candidateRef.current = project;
    setCandidate(project);
  }
  const load = useCallback(async (quiet = false) => {
    if (!token) { setLoading(false); return; }
    const generation = ++requestId.current;
    if (!quiet) setLoading(true);
    setError('');
    try {
      const result = await api.projects();
      if (generation === requestId.current) setItems(result.filter(item => !removedIds.current.has(item.id)));
    } catch (e) { if (generation === requestId.current) setError(errorText(e)); }
    finally { if (generation === requestId.current) setLoading(false); }
  }, [api, token]);
  useFocusEffect(useCallback(() => { focused.current = true; void load(); return () => { focused.current = false; requestId.current += 1; }; }, [load]));
  const generating = items.some(item => item.progress?.status === 'generating');
  useEffect(() => {
    if (!generating) return;
    let polling = false;
    const timer = setInterval(() => {
      if (polling || !focused.current || (AppState.currentState && AppState.currentState !== 'active')) return;
      polling = true;
      void load(true).finally(() => { polling = false; });
    }, 5000);
    return () => clearInterval(timer);
  }, [generating, load]);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => { if (state === 'active' && focused.current) void load(true); });
    return () => subscription.remove();
  }, [load]);
  async function removeProject() {
    if (!candidate || deleting) return;
    setDeleting(true); setError('');
    try {
      await api.deleteProject(candidate.id);
      removedIds.current.add(candidate.id);
      setItems(previous => previous.filter(item => item.id !== candidate.id));
      chooseCandidate(null);
      setFeedback('这组片已删除');
    } catch (e) { setError(errorText(e)); chooseCandidate(null); }
    finally { setDeleting(false); }
  }
  async function updateProject(changes: { title?: string; pinned?: boolean }) {
    if (!candidate || updating) return;
    setUpdating(true); setMenuError('');
    // Discard any older list response so it cannot undo this metadata update.
    requestId.current += 1;
    try {
      const updated = await api.patchProject(candidate.id, changes);
      requestId.current += 1;
      setItems(previous => previous.map(item => item.id === updated.id ? updated : item));
      chooseCandidate(null);
      setFeedback(changes.title !== undefined ? '片场名称已更新' : changes.pinned ? '这组片已置顶' : '已取消置顶');
    } catch (cause) { setMenuError(errorText(cause)); }
    finally { setUpdating(false); }
  }
  const openProject = (id: string) => router.push({ pathname: '/projects/[id]', params: { id } });
  const filters = stageFilters(items);
  const visibleItems = filterByStage(filterProjects(items, query), stageFilter);
  const active = inProgressProjects(visibleItems);
  const others = otherProjects(visibleItems);
  function projectCard(item: Project, index: number, ongoing: boolean) {
    return <AnimatedEntry key={item.id} delay={index * 40} reflow exit><View style={local.projectCard}><Pressable testID={ongoing ? `progress-${item.id}` : `project-${item.id}`} accessibilityRole="button" accessibilityLabel={`打开这组片 ${item.title}`} onLongPress={() => chooseCandidate(item)} delayLongPress={500} onPress={() => { if (!candidateRef.current) openProject(item.id); }} style={({ pressed }) => ({ flex: 1, minWidth: 0, flexDirection: 'row', gap: space.md, alignItems: 'center', opacity: pressed ? 0.75 : 1 })}>
      {item.cover_url ? <FadeImage source={{ uri: previewUrl(item.cover_url) }} style={local.cover} resizeMode="cover" accessibilityLabel={`${item.title}封面`} /> : <View style={[local.cover, { alignItems: 'center', justifyContent: 'center' }]}><Ionicons name="shirt-outline" size={26} color={studio.muted} /></View>}
      <View style={{ flex: 1, gap: space.sm }}><Text style={{ ...type.badge, color: studio.muted, letterSpacing: 1 }}>{item.brand}</Text><Text numberOfLines={2} style={{ ...type.subtitle, color: studio.ink }}>{item.title}</Text>{ongoing ? <Text style={{ ...type.caption, color: item.progress?.status === 'generating' ? studio.generating : studio.muted }}>{item.progress?.label}</Text> : <Badge label={item.progress?.label || stageNames[item.stage]} tone={['done', 'note'].includes(item.stage) ? 'success' : 'neutral'} />}{!ongoing && <Text style={{ ...type.caption, color: studio.subtle }}>{new Date(item.updated_at).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })} 更新</Text>}</View>
      {ongoing && <Text style={{ ...type.label, color: studio.ink }}>继续</Text>}
      </Pressable>
      {item.pinned ? <View testID={`project-pin-${item.id}`} accessibilityLabel="已置顶" style={local.pin}><Ionicons name="pin" size={16} color={studio.accent} /></View> : null}
      <Pressable accessibilityRole="button" accessibilityLabel={`删除这组片 ${item.title}`} onPress={event => { event.stopPropagation(); chooseCandidate(item, 'delete'); }} style={({ pressed }) => ({ minWidth: layout.touch, minHeight: layout.touch, borderRadius: radius.sm, backgroundColor: pressed ? studio.softAccent : 'transparent', alignItems: 'center', justifyContent: 'center' })}><Ionicons name="trash-outline" size={18} color={studio.muted} /></Pressable>
    </View></AnimatedEntry>;
  }
  const inspiration = <AnimatedEntry><View style={{ gap: space.lg }}><View style={[styles.row, { justifyContent: 'space-between', alignItems: 'flex-end' }]}><Text style={local.section}>灵感墙</Text><Text style={local.eyebrow}>TAKE A LITTLE INSPIRATION</Text></View><Text style={{ ...type.body, color: studio.muted }}>一件衣服，可以有很多种主角感。</Text><InspirationWall /></View></AnimatedEntry>;
  return <Page tone="studio">
    <StudioGlow />
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={[styles.content, { paddingTop: space.lg }]} refreshControl={<RefreshControl refreshing={loading && items.length > 0} onRefresh={() => void load()} tintColor={studio.ink} />}>
      <View style={[styles.row, { justifyContent: 'space-between', gap: space.md }]}>
        <View style={{ flex: 1, gap: space.sm }}><Text numberOfLines={1} style={local.eyebrow}>衣序 · {dateLabel()}</Text><Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7} style={{ ...type.display, color: studio.ink }}>{greeting()}</Text><View style={[styles.row, { gap: space.xs, flexWrap: 'wrap' }]}><Text style={{ ...type.caption, color: studio.muted }}>{user?.nickname ? `${user.nickname}的片场` : '我的片场'}</Text>{active.length ? <Text style={{ ...type.caption, color: studio.muted }}>· {active.length} 组片正在拍</Text> : null}</View></View>
        <AssetLibraryEntry compact />
        <IconButton name="options-outline" label="设置" onPress={() => router.push('/settings')} />
      </View>
      {!!completions.length && <View testID="recent-completions" style={{ gap: space.md }}><Text style={local.section}>刚刚出好</Text>{completions.map(item => <Pressable key={`${item.projectId}-${item.jobIds.join('-')}`} accessibilityRole="button" accessibilityLabel={`查看刚刚出好 ${item.title}`} accessibilityHint={item.read ? '已查看' : '有新结果未查看'} testID={`recent-completion-${item.projectId}`} onPress={() => openProject(item.projectId)} style={[local.recent, !item.read && local.recentUnread]}>{(() => { const cover = items.find(project => project.id === item.projectId)?.cover_url; return cover ? <FadeImage source={{ uri: previewUrl(cover, 360) }} style={local.recentCover} resizeMode="cover" /> : <View style={local.recentIcon}><Ionicons name="sparkles-outline" size={20} color={studio.accent} /></View>; })()}<View style={{ flex: 1, gap: space.xs }}><Text style={{ ...type.label, color: studio.ink }}>{item.title}</Text><Text style={{ ...type.caption, color: studio.muted }}>{item.body}</Text></View><Ionicons name="arrow-forward" size={18} color={studio.ink} /></Pressable>)}</View>}
      {!items.length && !query.trim() && inspiration}
      {!!items.length && <Field label="搜索片场" placeholder="搜索这组片的名称或品牌" value={query} onChangeText={setQuery} returnKeyType="search" />}
      {filters.length > 1 && <ScrollView horizontal showsHorizontalScrollIndicator={false} testID="stage-filters" contentContainerStyle={{ gap: space.sm, paddingVertical: space.xs }}><Chip label="全部" selected={!stageFilter} onPress={() => setStageFilter('')} />{filters.map(entry => <Chip key={entry.stage} label={`${stageNames[entry.stage]} ${entry.count}`} selected={stageFilter === entry.stage} onPress={() => setStageFilter(current => current === entry.stage ? '' : entry.stage)} />)}</ScrollView>}
      {!!stageFilter && !query.trim() && !visibleItems.length && <StatePanel icon="albums-outline" title="这个阶段现在没有片。" description="换个阶段看看，或者看全部。" actionLabel="看全部" onAction={() => setStageFilter('')} />}
      {!!query.trim() && !visibleItems.length && <StatePanel icon="search-outline" title="没有找到这组片。" description="换个名字或品牌再找找。" actionLabel="清空搜索" onAction={() => setQuery('')} />}
      {!!error && <View accessibilityRole="alert"><StatePanel icon="cloud-offline-outline" title="暂时连接不上" description={error} actionLabel="重试" onAction={() => void load()} /></View>}
      {!!feedback && <Toast text={feedback} onDismiss={() => setFeedback('')} />}
      <View testID="in-progress" style={{ gap: space.lg }}><View style={[styles.row, { justifyContent: 'space-between' }]}><Text style={local.section}>进行中 <Text style={local.count}>{active.length.toString().padStart(2, '0')}</Text></Text><IconButton name="refresh-outline" label="刷新片场列表" onPress={() => void load()} /></View>{active.length ? active.map((item, index) => projectCard(item, index, true)) : <Text style={{ ...type.caption, color: studio.muted }}>眼下没有进行中的拍摄，随时可以开一组新片。</Text>}</View>
      {(!items.length || others.length > 0) && <View style={{ gap: space.lg }}><Text style={local.section}>我的片场 <Text style={local.count}>{others.length.toString().padStart(2, '0')}</Text></Text>{loading && !items.length ? <LoadingSkeleton kind="list" /> : !items.length && !error ? <StatePanel icon="albums-outline" title="第一组片，从这里开拍" description="带上一件喜欢的衣服，接下来一起找灵感。" /> : null}{others.map((item, index) => projectCard(item, index, false))}</View>}
      {!!items.length && !query.trim() && inspiration}
      <Text style={{ ...type.badge, color: studio.subtle, textAlign: 'center', letterSpacing: 2, paddingVertical: space.md }}>每一组片，都有你的表达</Text>
    </ScrollView>
    <View style={local.footer}><Button title="拍一组新片" icon="add" onPress={() => router.push('/projects/new')} /></View>
    <Modal transparent animationType="fade" visible={!!candidate} onRequestClose={() => { if (!deleting && !updating) chooseCandidate(null); }}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, backgroundColor: studio.modalOverlay, justifyContent: 'center', padding: space.xl }}>
        <AnimatedEntry style={{ width: '100%', maxWidth: 420, alignSelf: 'center' }}><View testID="project-menu" accessibilityViewIsModal accessibilityLabel={menuMode === 'delete' ? '删除这组片确认' : menuMode === 'rename' ? '重命名片场' : '片场操作'} style={{ backgroundColor: studio.canvas, borderWidth: 1, borderColor: studio.line, borderRadius: radius.lg, padding: space.xl, gap: space.lg }}>
          {menuMode === 'menu' ? <>
            <Text style={local.section} numberOfLines={2}>{candidate?.title}</Text>
            <Button title="重命名" icon="create-outline" variant="secondary" disabled={updating} testID="project-menu-rename" onPress={() => { setMenuMode('rename'); setMenuError(''); }} />
            <Button title={candidate?.pinned ? '取消置顶' : '置顶'} icon="pin-outline" variant="secondary" loading={updating} testID="project-menu-pin" onPress={() => void updateProject({ pinned: !candidate?.pinned })} />
            <Button title="删除" icon="trash-outline" variant="danger" disabled={updating} testID="project-menu-delete" onPress={() => setMenuMode('delete')} />
          </> : menuMode === 'rename' ? <>
            <Text style={local.section}>重命名片场</Text>
            <Field label="片场名称" value={projectTitle} onChangeText={value => setProjectTitle(Array.from(value).slice(0, 40).join(''))} editable={!updating} autoFocus testID="project-rename-input" returnKeyType="done" onSubmitEditing={() => { if (projectTitle.trim() && Array.from(projectTitle.trim()).length <= 40) void updateProject({ title: projectTitle.trim() }); }} />
            <Text style={{ ...type.caption, color: studio.muted }}>{Array.from(projectTitle.trim()).length}/40 字</Text>
            <Button title="保存名称" loading={updating} disabled={!projectTitle.trim() || Array.from(projectTitle.trim()).length > 40} testID="project-rename-save" onPress={() => void updateProject({ title: projectTitle.trim() })} />
          </> : <>
            <View style={{ width: 48, height: 48, backgroundColor: studio.softAccent, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' }}><Ionicons name="trash-outline" size={24} color={studio.accent} /></View>
            <Text style={local.section}>删除这组片？</Text><Text style={{ ...type.body, color: studio.ink }}>{candidate?.title}</Text><Text style={{ ...type.body, color: studio.muted }}>对话、生成任务和生成的媒体会一并删除，上传的衣服原图会保留。删除后无法恢复。</Text>
            <Button title="确认删除这组片" variant="danger" icon="trash-outline" loading={deleting} onPress={() => void removeProject()} />
          </>}
          {!!menuError && <Toast text={menuError} tone="danger" onDismiss={() => setMenuError('')} />}
          <Button title={menuMode === 'delete' ? '保留这组片' : '取消'} variant="ghost" disabled={deleting || updating} onPress={() => chooseCandidate(null)} />
        </View></AnimatedEntry>
      </KeyboardAvoidingView>
    </Modal>
  </Page>;
}

function greeting(now = new Date()) {
  const hour = now.getHours();
  if (hour < 5) return '夜深了';
  if (hour < 11) return '早上好';
  if (hour < 14) return '中午好';
  if (hour < 18) return '下午好';
  return '晚上好';
}

function dateLabel(now = new Date()) {
  const weekday = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()];
  return `${now.getMonth() + 1}月${now.getDate()}日 ${weekday}`;
}

const local = StyleSheet.create({
  pin: { position: 'absolute', top: space.xs, right: space.xs },
  projectCard: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: studio.line, backgroundColor: studio.glass, borderRadius: radius.md, padding: space.md, gap: space.md },
  eyebrow: { ...type.badge, color: studio.muted, letterSpacing: 1.4 },
  section: { ...type.heading, color: studio.ink, fontWeight: '500', letterSpacing: 1 },
  count: { ...type.caption, color: studio.subtle },
  cover: { width: 64, aspectRatio: layout.thumbnailRatio, borderRadius: radius.sm, backgroundColor: studio.canvas },
  recent: { padding: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: studio.line, backgroundColor: studio.glass, flexDirection: 'row', alignItems: 'center', gap: space.md },
  recentUnread: { borderColor: studio.accent },
  recentCover: { width: 56, aspectRatio: layout.thumbnailRatio, borderRadius: radius.sm, backgroundColor: studio.canvas },
  recentIcon: { width: 56, aspectRatio: layout.thumbnailRatio, borderRadius: radius.sm, backgroundColor: studio.softAccent, alignItems: 'center', justifyContent: 'center' },
  footer: { paddingHorizontal: space.xl, paddingTop: space.md, paddingBottom: space.lg, borderTopWidth: 1, borderTopColor: studio.line, backgroundColor: studio.bg },
});
