import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { Image, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import type { Project } from '../api/types';
import { Button, IconButton, Loading, Notice, Page, colors, errorText, stageNames, styles } from '../components/ui';
import { useSession } from '../context/Session';

export default function Projects() {
  const { api, token, user } = useSession();
  const router = useRouter();
  const [items, setItems] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    if (!token) { setLoading(false); return; }
    setLoading(true); setError('');
    try { setItems(await api.projects()); } catch (e) { setError(errorText(e)); } finally { setLoading(false); }
  }, [api, token]);
  useFocusEffect(useCallback(() => { void load(); }, [load]));
  return <Page>
    <ScrollView contentContainerStyle={[styles.content, { paddingTop: 20 }]} refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void load()} tintColor={colors.red} />}>
      <View style={[styles.row, { justifyContent: 'space-between' }]}>
        <View><Text style={{ color: colors.muted, fontSize: 11, letterSpacing: 2, marginBottom: 7 }}>OUTFIT NOTES / 衣序</Text><Text style={styles.title}>{user?.nickname ? `${user.nickname}的创作间` : '我的创作间'}</Text></View>
        <IconButton name="options-outline" label="设置" onPress={() => router.push('/settings')} />
      </View>
      <View style={{ borderRadius: 22, overflow: 'hidden', height: 252, backgroundColor: '#E3DED4' }}>
        <Image source={require('../../assets/editorial.jpg')} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
        <View style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.23)' }} />
        <View style={{ position: 'absolute', left: 23, top: 22, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.9)' }}><Text style={{ fontSize: 10, color: colors.ink, letterSpacing: 2 }}>灵 感 预 览</Text></View>
        <View style={{ position: 'absolute', left: 23, right: 20, bottom: 23, gap: 9 }}><Text style={{ fontSize: 26, lineHeight: 37, fontWeight: '700', color: 'white' }}>把品牌需求，{ '\n' }穿成你的风格。</Text><Text style={{ color: 'white', opacity: 0.9, fontSize: 12 }}>聊灵感 · 定脚本 · 出好图 · 写笔记</Text></View>
      </View>
      <Button title="新建品牌合作" icon="add" onPress={() => router.push('/projects/new')} />
      <View style={[styles.row, { marginTop: 8, justifyContent: 'space-between' }]}><Text style={styles.section}>合作项目 <Text style={{ fontSize: 13, color: colors.muted, fontWeight: '400' }}>{items.length.toString().padStart(2, '0')}</Text></Text><Text style={{ fontSize: 11, color: colors.muted }}>最近更新</Text></View>
      {!!error && <Notice text={error} onRetry={() => void load()} />}
      {loading && items.length === 0 ? <Loading text="正在找回你的灵感…" /> : items.length === 0 && !error ? <View style={{ backgroundColor: colors.paper, borderRadius: 18, padding: 26, alignItems: 'center', gap: 12 }}><Ionicons name="albums-outline" size={26} color="#ABA69A" /><Text style={{ color: colors.ink, fontWeight: '600' }}>第一篇合作笔记，从这里开始</Text><Text style={[styles.subtitle, { textAlign: 'center', fontSize: 12 }]}>带上品牌给你的衣服图，{ '\n' }剩下的灵感，我们一起聊出来。</Text></View> : null}
      {items.map(item => <Pressable key={item.id} accessibilityRole="button" accessibilityLabel={`打开项目 ${item.title}`} onPress={() => router.push({ pathname: '/projects/[id]', params: { id: item.id } })} style={{ flexDirection: 'row', borderWidth: 1, borderColor: colors.border, borderRadius: 18, padding: 12, gap: 16, alignItems: 'center' }}>
        {item.cover_url ? <Image source={{ uri: item.cover_url }} style={{ width: 84, height: 108, borderRadius: 11, backgroundColor: colors.paper }} resizeMode="cover" /> : <View style={{ width: 84, height: 108, borderRadius: 11, backgroundColor: colors.paper, alignItems: 'center', justifyContent: 'center' }}><Ionicons name="shirt-outline" size={26} color="#C4BFB2" /></View>}
        <View style={{ flex: 1, gap: 9 }}><Text style={{ color: colors.muted, fontSize: 11, letterSpacing: 1 }}>{item.brand}</Text><Text numberOfLines={2} style={{ color: colors.ink, fontSize: 16, fontWeight: '600', lineHeight: 23 }}>{item.title}</Text><View style={styles.row}><Text style={{ color: colors.red, backgroundColor: colors.blush, paddingHorizontal: 8, paddingVertical: 4, fontSize: 10, borderRadius: 5 }}>{stageNames[item.stage]}</Text><Text style={{ fontSize: 10, color: colors.muted }}>{new Date(item.updated_at).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}</Text></View></View>
        <Ionicons name="chevron-forward" size={16} color={colors.muted} />
      </Pressable>)}
      <Text style={{ fontSize: 10, color: '#B2AEA5', textAlign: 'center', letterSpacing: 2, paddingTop: 12 }}>让每一次合作，都有你的表达</Text>
    </ScrollView>
  </Page>;
}
