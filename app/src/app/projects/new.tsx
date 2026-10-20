import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import type { Asset, AssetKind } from '../../api/types';
import { Button, Field, Header, Notice, Page, colors, errorText, styles } from '../../components/ui';
import { useSession } from '../../context/Session';

export default function NewProject() {
  const { api } = useSession();
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [brand, setBrand] = useState('');
  const [brief, setBrief] = useState('');
  const [garments, setGarments] = useState<Asset[]>([]);
  const [model, setModel] = useState<Asset | null>(null);
  const [uploading, setUploading] = useState<AssetKind | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function pick(kind: 'garment' | 'model') {
    setError('');
    try {
      if (Platform.OS !== 'web') {
        const result = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!result.granted) { setError('需要允许访问选中的照片，才能上传衣服图。你也可以到系统设置中开启。'); return; }
      }
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: kind === 'garment', selectionLimit: kind === 'garment' ? 9 : 1, quality: 0.9 });
      if (result.canceled) return;
      setUploading(kind);
      for (const item of result.assets) {
        const nativeFile = { uri: item.uri, name: item.fileName || `outfit-${Date.now()}.jpg`, type: item.mimeType || 'image/jpeg' };
        const file = Platform.OS === 'web' ? item.file || new File([await (await fetch(item.uri)).blob()], nativeFile.name, { type: nativeFile.type }) : nativeFile;
        const asset = await api.uploadAsset(file, kind);
        if (kind === 'model') setModel(asset); else setGarments(previous => [...previous, asset]);
      }
    } catch (e) { setError(`图片没传好：${errorText(e)}`); } finally { setUploading(null); }
  }
  async function submit() {
    if (!title.trim() || !brand.trim() || !brief.trim()) return setError('项目名、品牌和合作需求都写一点，灵感才有方向。');
    if (!garments.length) return setError('先上传至少一张品牌衣服图吧。');
    setBusy(true); setError('');
    try {
      const result = await api.createProject({ title: title.trim(), brand: brand.trim(), brief: brief.trim(), garment_asset_ids: garments.map(item => item.id), ...(model ? { model_asset_id: model.id } : {}) });
      router.replace({ pathname: '/projects/[id]', params: { id: result.id } });
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  return <Page>
    <Header title="新建品牌合作" onBack={() => router.back()} />
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
        <View style={{ gap: 8 }}><Text style={{ color: colors.red, fontSize: 10, letterSpacing: 2 }}>A NEW STORY</Text><Text style={styles.title}>这次，想怎么穿？</Text><Text style={styles.subtitle}>把品牌的需求放进来，一起找到你的表达。</Text></View>
        <Field label="项目名称" placeholder="例如：秋日衬衫合作笔记" value={title} onChangeText={setTitle} maxLength={100} />
        <Field label="合作品牌" placeholder="这次和哪个品牌一起创作？" value={brand} onChangeText={setBrand} maxLength={100} />
        <Field label="品牌需求" placeholder="想突出什么？穿去哪里？品牌给你的原话也可以。" value={brief} onChangeText={setBrief} multiline />
        <View style={{ gap: 12 }}><View style={[styles.row, { justifyContent: 'space-between' }]}><Text style={styles.section}>品牌衣服图</Text><Text style={{ color: colors.muted, fontSize: 11 }}>至少 1 张 · 支持多选</Text></View>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>{garments.map((item, index) => <View key={item.id} style={{ width: 96, height: 116 }}><Image source={{ uri: item.url }} style={{ width: '100%', height: '100%', borderRadius: 13, backgroundColor: colors.paper }} /><Pressable accessibilityRole="button" accessibilityLabel={`移除衣服图 ${index + 1}`} onPress={() => setGarments(previous => previous.filter(asset => asset.id !== item.id))} style={{ position: 'absolute', top: 5, right: 5, borderRadius: 10, padding: 3, backgroundColor: 'rgba(255,255,255,0.92)' }}><Ionicons name="close" size={14} /></Pressable></View>)}</View>
          <Pressable accessibilityRole="button" accessibilityLabel="上传衣服图" testID="upload-garments" disabled={!!uploading || busy} onPress={() => void pick('garment')} style={{ borderWidth: 1, borderStyle: 'dashed', borderColor: '#D8D4CA', borderRadius: 16, padding: 24, alignItems: 'center', backgroundColor: colors.paper, gap: 9 }}><Ionicons name="add" size={24} color={colors.red} /><Text style={{ color: colors.ink, fontSize: 13, fontWeight: '600' }}>{uploading === 'garment' ? '正在上传衣服图…' : '添加衣服图'}</Text><Text style={{ color: colors.muted, fontSize: 11 }}>平铺、挂拍或商品图都可以</Text></Pressable>
        </View>
        <View style={{ gap: 12 }}><Text style={styles.section}>让你来当主角 <Text style={{ fontSize: 12, color: colors.muted, fontWeight: '400' }}>选填</Text></Text><Text style={[styles.subtitle, { fontSize: 12 }]}>上传你的照片作为模特；留空就用默认模特。</Text>{model && <View style={styles.row}><Image source={{ uri: model.url }} style={{ width: 72, height: 90, borderRadius: 12 }} /><Button title="移除照片" variant="ghost" onPress={() => setModel(null)} /></View>}<Button title={uploading === 'model' ? '正在上传…' : model ? '更换我的照片' : '上传我的照片'} icon="person-outline" variant="secondary" disabled={!!uploading || busy} onPress={() => void pick('model')} /></View>
        {!!error && <Notice text={error} />}
        <Button title="开始聊灵感" icon="arrow-forward" loading={busy} disabled={!!uploading} onPress={() => void submit()} />
      </ScrollView>
    </KeyboardAvoidingView>
  </Page>;
}
