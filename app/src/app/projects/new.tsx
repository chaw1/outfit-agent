import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { profilePhotos } from '../../lib/profile';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { Asset, AssetKind } from '../../api/types';
import { AnimatedEntry, Badge, Button, FadeImage, Field, Header, Notice, Page, ProgressStrip, errorText, styles } from '../../components/ui';
import { colors, radius, space, type } from '../../theme';
import { useSession } from '../../context/Session';

export default function NewProject() {
  const { api, user, photos } = useSession();
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [brand, setBrand] = useState('');
  const [brief, setBrief] = useState('');
  const [garments, setGarments] = useState<Asset[]>([]);
  const [model, setModel] = useState<Asset | null>(null);
  const [modelChoice, setModelChoice] = useState<string | null | undefined>(undefined);
  const savedPhotos = profilePhotos(user?.profile?.model_asset_ids || [], photos);
  const selectedModelId = modelChoice === undefined ? savedPhotos[0]?.id : modelChoice;
  const selectedModel = model?.id === selectedModelId ? model : savedPhotos.find(photo => photo.id === selectedModelId);
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
        if (kind === 'model') { setModel(asset); setModelChoice(asset.id); } else setGarments(previous => [...previous, asset]);
      }
    } catch (e) { setError(`图片没传好：${errorText(e)}`); } finally { setUploading(null); }
  }
  async function submit() {
    if (!title.trim() || !brand.trim() || !brief.trim()) return setError('项目名、品牌和合作需求都写一点，灵感才有方向。');
    if (!garments.length) return setError('先上传至少一张品牌衣服图吧。');
    setBusy(true); setError('');
    try {
      const result = await api.createProject({ title: title.trim(), brand: brand.trim(), brief: brief.trim(), garment_asset_ids: garments.map(item => item.id), ...(selectedModelId ? { model_asset_id: selectedModelId } : {}) });
      router.replace({ pathname: '/projects/[id]', params: { id: result.id } });
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  return <Page>
    <Header title="新建品牌合作" onBack={() => router.back()} />
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        <AnimatedEntry style={localStyles.intro}>
          <Text style={localStyles.eyebrow}>A NEW STORY</Text>
          <Text style={styles.title}>这次，想怎么穿？</Text>
          <Text style={styles.subtitle}>把品牌的需求放进来，一起找到你的表达。</Text>
        </AnimatedEntry>
        <View style={localStyles.formSection}>
          <Field label="项目名称" placeholder="例如：秋日衬衫合作笔记" value={title} onChangeText={setTitle} maxLength={100} />
          <Field label="合作品牌" placeholder="这次和哪个品牌一起创作？" value={brand} onChangeText={setBrand} maxLength={100} />
          <Field label="品牌需求" placeholder="想突出什么？穿去哪里？品牌给你的原话也可以。" value={brief} onChangeText={setBrief} multiline />
        </View>
        <View style={localStyles.section}>
          <View style={[styles.row, { justifyContent: 'space-between', flexWrap: 'wrap' }]}><Text style={styles.section}>品牌衣服图</Text><Badge label="至少 1 张 · 支持多选" /></View>
          {!!garments.length && <View style={localStyles.thumbnails}>{garments.map((item, index) => <View key={item.id} style={localStyles.garment}>
            <FadeImage source={{ uri: item.url }} style={localStyles.garmentImage} />
            <Pressable accessibilityRole="button" accessibilityLabel={`移除衣服图 ${index + 1}`} onPress={() => setGarments(previous => previous.filter(asset => asset.id !== item.id))} style={({ pressed }) => [localStyles.removeImage, pressed && localStyles.pressed]}><View style={localStyles.removeGlyph}><Ionicons name="close" size={16} color={colors.ink} /></View></Pressable>
          </View>)}</View>}
          <Pressable accessibilityRole="button" accessibilityLabel="上传衣服图" testID="upload-garments" disabled={!!uploading || busy} onPress={() => void pick('garment')} style={({ pressed }) => [localStyles.uploadArea, pressed && localStyles.uploadPressed, (!!uploading || busy) && { opacity: 0.6 }]}>
            <View style={localStyles.uploadIcon}><Ionicons name="add" size={24} color={colors.redText} /></View>
            <Text style={localStyles.uploadTitle}>{uploading === 'garment' ? '正在上传衣服图…' : '添加衣服图'}</Text>
            <Text style={localStyles.caption}>平铺、挂拍或商品图都可以</Text>
          </Pressable>
        </View>
        <View style={localStyles.section}>
          <View style={styles.row}><Text style={styles.section}>让你来当主角</Text><Badge label="选填" /></View>
          <Text style={styles.subtitle}>{savedPhotos.length ? '已默认带上档案里的本人照片，也可以选择另一张。' : '上传你的照片作为模特；留空就用默认模特。'}</Text>
          {!!savedPhotos.length && <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.md }}>{savedPhotos.map((photo, index) => <Pressable key={photo.id} accessibilityRole="button" accessibilityLabel={`选择档案照片 ${index + 1}`} accessibilityState={{ selected: selectedModelId === photo.id }} aria-selected={selectedModelId === photo.id} onPress={() => setModelChoice(photo.id)} style={({ pressed }) => [localStyles.profilePhoto, selectedModelId === photo.id && localStyles.profileSelected, pressed && localStyles.pressed]}>
            {photo.url ? <FadeImage source={{ uri: photo.url }} style={localStyles.profileImage} /> : <View style={[localStyles.profileImage, localStyles.profilePlaceholder]}><Ionicons name="person-outline" size={24} color={colors.muted} /></View>}
            <Text style={[localStyles.caption, { textAlign: 'center', color: selectedModelId === photo.id ? colors.redText : colors.muted }]}>{index === 0 ? '档案默认' : `照片 ${index + 1}`}{selectedModelId === photo.id ? ' ✓' : ''}</Text>
          </Pressable>)}</ScrollView>}
          {selectedModelId && !savedPhotos.some(photo => photo.id === selectedModelId) && selectedModel && <View style={[styles.row, { flexWrap: 'wrap' }]}>{selectedModel.url && <FadeImage source={{ uri: selectedModel.url }} style={localStyles.profileImage} />}<Text style={styles.subtitle}>本次合作的本人照片</Text><Button title="移除照片" variant="ghost" onPress={() => { setModel(null); setModelChoice(undefined); }} /></View>}
          <Button title={uploading === 'model' ? '正在上传…' : selectedModelId ? '更换我的照片' : '上传我的照片'} icon="person-outline" variant="secondary" disabled={!!uploading || busy} onPress={() => void pick('model')} />
        </View>
        {!!uploading && <ProgressStrip title={uploading === 'garment' ? '正在上传衣服图…' : '正在上传本人照片…'} detail="稍等一下，马上就能继续创作" />}
        {!!error && <Notice text={error} />}
        <Button title="开始聊灵感" icon="arrow-forward" loading={busy} disabled={!!uploading} onPress={() => void submit()} />
      </ScrollView>
    </KeyboardAvoidingView>
  </Page>;
}

const localStyles = StyleSheet.create({
  intro: { gap: space.sm, paddingVertical: space.sm },
  eyebrow: { ...type.badge, color: colors.redText, letterSpacing: 2 },
  formSection: { gap: space.xl },
  section: { gap: space.lg, paddingTop: space.xl, borderTopWidth: 1, borderTopColor: colors.border },
  thumbnails: { flexDirection: 'row', flexWrap: 'wrap', gap: space.md },
  garment: { width: 96, aspectRatio: 3 / 4 },
  garmentImage: { width: '100%', height: '100%', borderRadius: radius.md, backgroundColor: colors.imagePlaceholder },
  removeImage: { position: 'absolute', top: 0, right: 0, minWidth: 44, minHeight: 44, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' },
  removeGlyph: { width: 28, height: 28, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.glass },
  pressed: { opacity: 0.7, transform: [{ scale: 0.97 }] },
  uploadArea: { borderWidth: 1, borderStyle: 'dashed', borderColor: colors.border, borderRadius: radius.md, padding: space.xl, alignItems: 'center', backgroundColor: colors.paper, gap: space.sm },
  uploadPressed: { backgroundColor: colors.blush, transform: [{ scale: 0.99 }] },
  uploadIcon: { height: 44, width: 44, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.blush },
  uploadTitle: { ...type.body, color: colors.ink, fontWeight: '600' },
  caption: { ...type.caption, color: colors.muted },
  profilePhoto: { borderWidth: 2, borderColor: colors.border, borderRadius: radius.md, padding: space.xs, gap: space.sm, backgroundColor: colors.surface },
  profileSelected: { borderColor: colors.red, backgroundColor: colors.blush },
  profileImage: { width: 84, aspectRatio: 3 / 4, borderRadius: radius.sm, backgroundColor: colors.imagePlaceholder },
  profilePlaceholder: { alignItems: 'center', justifyContent: 'center' },
});
