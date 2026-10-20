import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useRef, useState } from 'react';
import { Modal, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import type { Project } from '../api/types';
import { AnimatedEntry, Badge, Button, FadeImage, Field, IconButton, LoadingSkeleton, Page, StatePanel, Toast, colors, errorText, stageNames, styles } from '../components/ui';
import { useSession } from '../context/Session';
import { filterProjects } from '../lib/profile';
import { layout, radius, space, type } from '../theme';

export default function Projects() {
  const { api, token, user } = useSession();
  const router = useRouter();
  const [items, setItems] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [candidate, setCandidate] = useState<Project | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [feedback, setFeedback] = useState('');
  const requestId = useRef(0);
  const removedIds = useRef(new Set<string>());
  const candidateRef = useRef<Project | null>(null);
  function chooseCandidate(project: Project | null) {
    candidateRef.current = project;
    setCandidate(project);
  }
  const load = useCallback(async () => {
    if (!token) { setLoading(false); return; }
    const generation = ++requestId.current;
    setLoading(true); setError('');
    try {
      const result = await api.projects();
      if (generation === requestId.current) setItems(result.filter(item => !removedIds.current.has(item.id)));
    } catch (e) { if (generation === requestId.current) setError(errorText(e)); }
    finally { if (generation === requestId.current) setLoading(false); }
  }, [api, token]);
  useFocusEffect(useCallback(() => { void load(); return () => { requestId.current += 1; }; }, [load]));
  async function removeProject() {
    if (!candidate || deleting) return;
    setDeleting(true); setError('');
    try {
      await api.deleteProject(candidate.id);
      removedIds.current.add(candidate.id);
      setItems(previous => previous.filter(item => item.id !== candidate.id));
      chooseCandidate(null);
      setFeedback('合作项目已删除');
    } catch (e) { setError(errorText(e)); chooseCandidate(null); }
    finally { setDeleting(false); }
  }
  const visibleItems = filterProjects(items, query);
  return <Page>
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={loading && items.length > 0} onRefresh={() => void load()} tintColor={colors.red} />}>
      <View style={[styles.row, { justifyContent: 'space-between', gap: space.md }]}>
        <View style={{ flex: 1, gap: space.sm }}><Text style={{ ...type.badge, color: colors.muted, letterSpacing: 2 }}>OUTFIT NOTES / 衣序</Text><Text style={styles.title}>{user?.nickname ? `${user.nickname}的创作间` : '我的创作间'}</Text></View>
        <IconButton name="options-outline" label="设置" onPress={() => router.push('/settings')} />
      </View>
      <AnimatedEntry><View style={{ borderRadius: radius.lg, overflow: 'hidden', height: 252, backgroundColor: colors.imagePlaceholder }}>
        <FadeImage source={require('../../assets/editorial.jpg')} style={{ width: '100%', height: '100%' }} resizeMode="cover" accessibilityLabel="秋日穿搭灵感" />
        <View style={{ position: 'absolute', inset: 0, backgroundColor: colors.heroOverlay }} />
        <View style={{ position: 'absolute', left: space.xl, top: space.xl, paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.lg, backgroundColor: colors.glass }}><Text style={{ ...type.badge, color: colors.ink, letterSpacing: 2 }}>灵 感 预 览</Text></View>
        <View style={{ position: 'absolute', left: space.xl, right: space.xl, bottom: space.xl, gap: space.sm }}><Text style={{ ...type.title, color: colors.white }}>把品牌需求，{'\n'}穿成你的风格。</Text><Text style={{ ...type.caption, color: colors.white }}>聊灵感 · 定脚本 · 出好图 · 写笔记</Text></View>
      </View></AnimatedEntry>
      <Button title="新建品牌合作" icon="add" onPress={() => router.push('/projects/new')} />
      <View style={[styles.row, { justifyContent: 'space-between' }]}><Text style={styles.section}>合作项目 <Text style={{ ...type.label, color: colors.muted }}>{items.length.toString().padStart(2, '0')}</Text></Text><IconButton name="refresh-outline" label="刷新项目列表" onPress={() => void load()} /></View>
      {!!items.length && <Field label="搜索项目" placeholder="搜索项目名称或品牌" value={query} onChangeText={setQuery} returnKeyType="search" />}
      {!!query.trim() && !visibleItems.length && <StatePanel icon="search-outline" title="没有找到匹配的合作项目。" description="换个项目名称或品牌再找找。" actionLabel="清空搜索" onAction={() => setQuery('')} />}
      {!!error && <View accessibilityRole="alert"><StatePanel icon="cloud-offline-outline" title="暂时连接不上" description={error} actionLabel="重试" onAction={() => void load()} /></View>}
      {!!feedback && <Toast text={feedback} onDismiss={() => setFeedback('')} />}
      {loading && items.length === 0 ? <LoadingSkeleton kind="list" /> : items.length === 0 && !error ? <StatePanel icon="albums-outline" title="第一篇合作笔记，从这里开始" description="带上品牌给你的衣服图，剩下的灵感，我们一起聊出来。" actionLabel="创建第一篇合作" onAction={() => router.push('/projects/new')} /> : null}
      <View style={{ gap: space.lg }}>
      {visibleItems.map((item, index) => <AnimatedEntry key={item.id} delay={index * 40}><Pressable accessibilityRole="button" accessibilityLabel={`打开项目 ${item.title}`} onLongPress={() => chooseCandidate(item)} delayLongPress={500} onPress={() => { if (candidateRef.current) return; router.push({ pathname: '/projects/[id]', params: { id: item.id } }); }} style={({ pressed }) => ({ flexDirection: 'row', borderWidth: 1, borderColor: pressed ? colors.red : colors.border, backgroundColor: pressed ? colors.paper : colors.surface, borderRadius: radius.lg, padding: space.md, gap: space.md, alignItems: 'center', transform: [{ scale: pressed ? 0.985 : 1 }] })}>
        {item.cover_url ? <FadeImage source={{ uri: item.cover_url }} style={{ width: 72, aspectRatio: layout.thumbnailRatio, borderRadius: radius.sm, backgroundColor: colors.paper }} resizeMode="cover" accessibilityLabel={`${item.title}封面`} /> : <View style={{ width: 72, aspectRatio: layout.thumbnailRatio, borderRadius: radius.sm, backgroundColor: colors.paper, alignItems: 'center', justifyContent: 'center' }}><Ionicons name="shirt-outline" size={26} color={colors.muted} /></View>}
        <View style={{ flex: 1, gap: space.sm }}><Text style={{ ...type.badge, color: colors.muted, letterSpacing: 1 }}>{item.brand}</Text><Text numberOfLines={2} style={{ ...type.subtitle, color: colors.ink }}>{item.title}</Text><Badge label={stageNames[item.stage]} tone={['done', 'note'].includes(item.stage) ? 'success' : 'brand'} /><Text style={{ ...type.caption, color: colors.muted }}>{new Date(item.updated_at).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })} 更新</Text></View>
        <Pressable accessibilityRole="button" accessibilityLabel={`删除项目 ${item.title}`} onPress={event => { event.stopPropagation(); chooseCandidate(item); }} style={({ pressed }) => ({ minWidth: layout.touch, minHeight: layout.touch, borderRadius: radius.sm, backgroundColor: pressed ? colors.blush : colors.surface, alignItems: 'center', justifyContent: 'center' })}><Ionicons name="trash-outline" size={18} color={colors.muted} /></Pressable>
      </Pressable></AnimatedEntry>)}
      </View>
      <Text style={{ ...type.badge, color: colors.muted, textAlign: 'center', letterSpacing: 1, paddingTop: space.md }}>让每一次合作，都有你的表达</Text>
    </ScrollView>
    <Modal transparent animationType="fade" visible={!!candidate} onRequestClose={() => { if (!deleting) chooseCandidate(null); }}>
      <View style={{ flex: 1, backgroundColor: colors.overlay, justifyContent: 'center', padding: space.xl }}>
        <AnimatedEntry style={{ width: '100%', maxWidth: 420, alignSelf: 'center' }}><View accessibilityViewIsModal accessibilityLabel="删除项目确认" style={{ backgroundColor: colors.surface, borderRadius: radius.lg, padding: space.xl, gap: space.lg }}>
          <View style={{ width: 48, height: 48, backgroundColor: colors.blush, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' }}><Ionicons name="trash-outline" size={24} color={colors.danger} /></View>
          <Text style={styles.section}>删除这个合作项目？</Text><Text style={{ ...type.body, color: colors.ink }}>{candidate?.title}</Text><Text style={styles.subtitle}>项目对话、生成任务和生成的媒体会一并删除，上传的衣服原图会保留。删除后无法恢复。</Text>
          <Button title="确认删除项目" variant="danger" icon="trash-outline" loading={deleting} onPress={() => void removeProject()} /><Button title="保留项目" variant="ghost" disabled={deleting} onPress={() => chooseCandidate(null)} />
        </View></AnimatedEntry>
      </View>
    </Modal>
  </Page>;
}
