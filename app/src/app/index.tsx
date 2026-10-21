import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AppState, Modal, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { Project } from '../api/types';
import { InspirationWall } from '../components/InspirationWall';
import { AssetLibraryEntry } from '../components/AssetLibrary';
import { AnimatedEntry, Badge, Button, FadeImage, Field, IconButton, LoadingSkeleton, Page, StatePanel, Toast, errorText, stageNames, styles } from '../components/ui';
import { useSession } from '../context/Session';
import { notificationOwner } from '../lib/completionTracker';
import { recentCompletions, subscribeCompletions } from '../lib/completionFeed';
import { filterProjects } from '../lib/profile';
import { inProgressProjects, otherProjects } from '../lib/projectProgress';
import { layout, radius, space, studio, type } from '../theme';

export default function Projects() {
  const { api, token, user, baseUrl } = useSession();
  const router = useRouter();
  const [items, setItems] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [candidate, setCandidate] = useState<Project | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [feedback, setFeedback] = useState('');
  const requestId = useRef(0);
  const focused = useRef(false);
  const removedIds = useRef(new Set<string>());
  const candidateRef = useRef<Project | null>(null);
  const scope = notificationOwner({ baseUrl, userId: user?.id ?? '' });
  const subscribe = useCallback((listener: () => void) => subscribeCompletions(scope, listener), [scope]);
  const snapshot = useCallback(() => recentCompletions(scope), [scope]);
  const completions = useSyncExternalStore(subscribe, snapshot, snapshot).filter(item => items.some(project => project.id === item.projectId));
  function chooseCandidate(project: Project | null) {
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
  const openProject = (id: string) => router.push({ pathname: '/projects/[id]', params: { id } });
  const visibleItems = filterProjects(items, query);
  const active = inProgressProjects(visibleItems);
  const others = otherProjects(visibleItems);
  function projectCard(item: Project, index: number, ongoing: boolean) {
    return <AnimatedEntry key={item.id} delay={index * 40}><Pressable testID={ongoing ? `progress-${item.id}` : `project-${item.id}`} accessibilityRole="button" accessibilityLabel={`打开这组片 ${item.title}`} onLongPress={() => chooseCandidate(item)} delayLongPress={500} onPress={() => { if (!candidateRef.current) openProject(item.id); }} style={({ pressed }) => ({ flexDirection: 'row', borderWidth: 1, borderColor: pressed ? studio.accent : studio.line, backgroundColor: pressed ? studio.surface : studio.glass, borderRadius: radius.md, padding: space.md, gap: space.md, alignItems: 'center', transform: [{ scale: pressed ? 0.985 : 1 }] })}>
      {item.cover_url ? <FadeImage source={{ uri: item.cover_url }} style={local.cover} resizeMode="cover" accessibilityLabel={`${item.title}封面`} /> : <View style={[local.cover, { alignItems: 'center', justifyContent: 'center' }]}><Ionicons name="shirt-outline" size={26} color={studio.muted} /></View>}
      <View style={{ flex: 1, gap: space.sm }}><Text style={{ ...type.badge, color: studio.muted, letterSpacing: 1 }}>{item.brand}</Text><Text numberOfLines={2} style={{ ...type.subtitle, color: studio.ink }}>{item.title}</Text>{ongoing ? <Text style={{ ...type.caption, color: item.progress?.status === 'generating' ? studio.generating : studio.muted }}>{item.progress?.label}</Text> : <Badge label={item.progress?.label || stageNames[item.stage]} tone={['done', 'note'].includes(item.stage) ? 'success' : 'neutral'} />}{!ongoing && <Text style={{ ...type.caption, color: studio.subtle }}>{new Date(item.updated_at).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })} 更新</Text>}</View>
      {ongoing && <Text style={{ ...type.label, color: studio.ink }}>继续</Text>}
      <Pressable accessibilityRole="button" accessibilityLabel={`删除这组片 ${item.title}`} onPress={event => { event.stopPropagation(); chooseCandidate(item); }} style={({ pressed }) => ({ minWidth: layout.touch, minHeight: layout.touch, borderRadius: radius.sm, backgroundColor: pressed ? studio.softAccent : 'transparent', alignItems: 'center', justifyContent: 'center' })}><Ionicons name="trash-outline" size={18} color={studio.muted} /></Pressable>
    </Pressable></AnimatedEntry>;
  }
  return <Page tone="studio">
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={[styles.content, { paddingTop: space.lg }]} refreshControl={<RefreshControl refreshing={loading && items.length > 0} onRefresh={() => void load()} tintColor={studio.ink} />}>
      <View style={[styles.row, { justifyContent: 'space-between', gap: space.md }]}>
        <View style={{ flex: 1, gap: space.sm }}><Text style={local.eyebrow}>衣序 / OUTFIT STUDIO</Text><Text style={{ ...type.display, color: studio.ink }}>{user?.nickname ? `${user.nickname}的片场` : '我的片场'}</Text></View>
        <AssetLibraryEntry compact />
        <IconButton name="options-outline" label="设置" onPress={() => router.push('/settings')} />
      </View>
      {!!completions.length && <View testID="recent-completions" style={{ gap: space.md }}><Text style={local.section}>刚刚出好</Text>{completions.map(item => <Pressable key={`${item.projectId}-${item.jobIds.join('-')}`} accessibilityRole="button" accessibilityLabel={`查看刚刚出好 ${item.title}`} onPress={() => openProject(item.projectId)} style={local.recent}><Ionicons name="sparkles-outline" size={20} color={studio.accent} /><View style={{ flex: 1, gap: space.xs }}><Text style={{ ...type.label, color: studio.ink }}>{item.title}</Text><Text style={{ ...type.caption, color: studio.muted }}>{item.body}</Text></View><Ionicons name="arrow-forward" size={18} color={studio.ink} /></Pressable>)}</View>}
      <AnimatedEntry><View style={{ gap: space.lg }}><View style={[styles.row, { justifyContent: 'space-between', alignItems: 'flex-end' }]}><Text style={local.section}>灵感墙</Text><Text style={local.eyebrow}>TAKE A LITTLE INSPIRATION</Text></View><Text style={{ ...type.body, color: studio.muted }}>一件衣服，可以有很多种主角感。</Text><InspirationWall /></View></AnimatedEntry>
      {!!items.length && <Field label="搜索片场" placeholder="搜索这组片的名称或品牌" value={query} onChangeText={setQuery} returnKeyType="search" />}
      {!!query.trim() && !visibleItems.length && <StatePanel icon="search-outline" title="没有找到这组片。" description="换个名字或品牌再找找。" actionLabel="清空搜索" onAction={() => setQuery('')} />}
      {!!error && <View accessibilityRole="alert"><StatePanel icon="cloud-offline-outline" title="暂时连接不上" description={error} actionLabel="重试" onAction={() => void load()} /></View>}
      {!!feedback && <Toast text={feedback} onDismiss={() => setFeedback('')} />}
      <View testID="in-progress" style={{ gap: space.lg }}><View style={[styles.row, { justifyContent: 'space-between' }]}><Text style={local.section}>进行中 <Text style={local.count}>{active.length.toString().padStart(2, '0')}</Text></Text><IconButton name="refresh-outline" label="刷新片场列表" onPress={() => void load()} /></View>{active.length ? active.map((item, index) => projectCard(item, index, true)) : <Text style={{ ...type.caption, color: studio.muted }}>眼下没有进行中的拍摄，随时可以开一组新片。</Text>}</View>
      <View style={{ gap: space.lg }}><Text style={local.section}>我的片场 <Text style={local.count}>{others.length.toString().padStart(2, '0')}</Text></Text>{loading && !items.length ? <LoadingSkeleton kind="list" /> : !items.length && !error ? <StatePanel icon="albums-outline" title="第一组片，从这里开拍" description="带上一件喜欢的衣服，接下来一起找灵感。" /> : null}{others.map((item, index) => projectCard(item, index, false))}</View>
      <Text style={{ ...type.badge, color: studio.subtle, textAlign: 'center', letterSpacing: 2, paddingVertical: space.md }}>每一组片，都有你的表达</Text>
    </ScrollView>
    <View style={local.footer}><Button title="拍一组新片" icon="add" onPress={() => router.push('/projects/new')} /></View>
    <Modal transparent animationType="fade" visible={!!candidate} onRequestClose={() => { if (!deleting) chooseCandidate(null); }}>
      <View style={{ flex: 1, backgroundColor: studio.modalOverlay, justifyContent: 'center', padding: space.xl }}>
        <AnimatedEntry style={{ width: '100%', maxWidth: 420, alignSelf: 'center' }}><View accessibilityViewIsModal accessibilityLabel="删除这组片确认" style={{ backgroundColor: studio.canvas, borderWidth: 1, borderColor: studio.line, borderRadius: radius.lg, padding: space.xl, gap: space.lg }}>
          <View style={{ width: 48, height: 48, backgroundColor: studio.softAccent, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' }}><Ionicons name="trash-outline" size={24} color={studio.accent} /></View>
          <Text style={local.section}>删除这组片？</Text><Text style={{ ...type.body, color: studio.ink }}>{candidate?.title}</Text><Text style={{ ...type.body, color: studio.muted }}>对话、生成任务和生成的媒体会一并删除，上传的衣服原图会保留。删除后无法恢复。</Text>
          <Button title="确认删除这组片" variant="danger" icon="trash-outline" loading={deleting} onPress={() => void removeProject()} /><Button title="保留这组片" variant="ghost" disabled={deleting} onPress={() => chooseCandidate(null)} />
        </View></AnimatedEntry>
      </View>
    </Modal>
  </Page>;
}

const local = StyleSheet.create({
  eyebrow: { ...type.badge, color: studio.muted, letterSpacing: 1.4 },
  section: { ...type.heading, color: studio.ink, fontWeight: '500', letterSpacing: 1 },
  count: { ...type.caption, color: studio.subtle },
  cover: { width: 64, aspectRatio: layout.thumbnailRatio, borderRadius: radius.sm, backgroundColor: studio.canvas },
  recent: { padding: space.lg, borderRadius: radius.md, borderWidth: 1, borderColor: studio.line, backgroundColor: studio.glass, flexDirection: 'row', alignItems: 'center', gap: space.md },
  footer: { paddingHorizontal: space.xl, paddingTop: space.md, paddingBottom: space.lg, borderTopWidth: 1, borderTopColor: studio.line, backgroundColor: studio.bg },
});
