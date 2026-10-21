import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { profilePhotos } from '../../lib/profile';
import { checkProjectCreation, createProjectWithRecovery, projectCreationRecoveryText, type ProjectCreationRecovery } from '../../lib/projectCreation';
import type { Asset, AssetKind, AutoQuote, ProjectMode } from '../../api/types';
import { AnimatedEntry, Badge, Button, FadeImage, Field, Header, Notice, Page, ProgressStrip, errorText, styles } from '../../components/ui';
import { studio, radius, space, type } from '../../theme';
import { formatPoints } from '../../lib/transparency';
import { STYLE_TAGS, styleBatch, toggleStyleTag } from '../../lib/styleTags';
import { useSession } from '../../context/Session';
import { GarmentPicker, ModelSourceLabel } from '../../components/AssetLibrary';
import { useLibraryModels } from '../../lib/assets';

export default function NewProject() {
  const { api, user, photos } = useSession();
  const router = useRouter();
  const [mode, setMode] = useState<ProjectMode>('guided');
  const [help, setHelp] = useState<ProjectMode | null>(null);
  const [batch, setBatch] = useState(0);
  const [tags, setTags] = useState<string[]>([STYLE_TAGS[0]]);
  const [quote, setQuote] = useState<AutoQuote>();
  const [quoteError, setQuoteError] = useState('');
  useEffect(() => { let active = true; void api.autoQuote().then(value => { if (active) { if (!Number.isFinite(value.estimate_points) || value.estimate_points < 0) throw new Error('invalid quote'); setQuote(value); setQuoteError(''); } }).catch(() => { if (active) setQuoteError('估点暂时没取到，可稍后再试。'); }); return () => { active = false; }; }, [api]);
  const [title, setTitle] = useState('');
  const [brand, setBrand] = useState('');
  const [brief, setBrief] = useState('');
  const [garments, setGarments] = useState<Asset[]>([]);
  const selectGarment = useCallback((item: Asset) => setGarments(previous => previous.some(asset => asset.id === item.id) ? previous : [...previous, item]), []);
  const [references, setReferences] = useState<Asset[]>([]);
  const [model, setModel] = useState<Asset | null>(null);
  const [modelChoice, setModelChoice] = useState<string | null | undefined>(undefined);
  const library = useLibraryModels();
  const savedPhotos = profilePhotos(user?.profile?.model_asset_ids || [], [...photos, ...(library.models || [])]);
  const selectedModelId = modelChoice === undefined ? savedPhotos[0]?.id : modelChoice;
  const selectedModel = model?.id === selectedModelId ? model : savedPhotos.find(photo => photo.id === selectedModelId);
  const [uploading, setUploading] = useState<AssetKind | null>(null);
  const [uploadProgress, setUploadProgress] = useState<{ current: number; total: number } | null>(null);
  const picking = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [creationRecovery, setCreationRecovery] = useState<ProjectCreationRecovery | null>(null);
  async function pick(kind: AssetKind) {
    if (picking.current || busy || (kind === 'reference' && references.length >= 3)) return;
    picking.current = true;
    setUploading(kind);
    setError('');
    try {
      if (Platform.OS !== 'web') {
        const result = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!result.granted) { setError('需要允许访问选中的照片，才能上传图片。你也可以到系统设置中开启。'); return; }
      }
      const limit = kind === 'reference' ? 3 - references.length : kind === 'garment' ? 9 : 1;
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: kind !== 'model', selectionLimit: limit, quality: 0.9 });
      if (result.canceled) return;
      const items = result.assets.slice(0, limit);
      for (const [index, item] of items.entries()) {
        setUploadProgress({ current: index + 1, total: items.length });
        const nativeFile = { uri: item.uri, name: item.fileName || `outfit-${Date.now()}.jpg`, type: item.mimeType || 'image/jpeg' };
        const file = Platform.OS === 'web' ? item.file || new File([await (await fetch(item.uri)).blob()], nativeFile.name, { type: nativeFile.type }) : nativeFile;
        const asset = await api.uploadAsset(file, kind);
        if (kind === 'model') { setModel(asset); setModelChoice(asset.id); }
        else if (kind === 'reference') setReferences(previous => [...previous, asset].slice(0, 3));
        else setGarments(previous => [...previous, asset]);
      }
    } catch (e) { setError(`图片没传好：${errorText(e)}`); } finally { picking.current = false; setUploading(null); setUploadProgress(null); }
  }
  async function submit(confirmRecreate = false) {
    if (picking.current || busy) return;
    if (creationRecovery && !confirmRecreate) {
      setBusy(true); setError('');
      try { setCreationRecovery(await checkProjectCreation(api, creationRecovery.input)); }
      catch (e) { setCreationRecovery({ ...creationRecovery, projects: null }); setError(errorText(e)); }
      finally { setBusy(false); }
      return;
    }
    if (creationRecovery?.projects === null) return;
    if (!brief.trim()) return setError('写一点这次想拍什么，灵感才有方向。');
    if (mode === 'auto' && !quote) return setError('先取到这次的估点，再开拍。');
    if (!garments.length) return setError('先上传至少一张衣服图吧。');
    setBusy(true); setError(''); setCreationRecovery(null);
    try {
      const result = await createProjectWithRecovery(api, { title: title.trim() || `${brand.trim() || '自由创作'} · ${tags[0] || STYLE_TAGS[0]}`, brand: brand.trim() || '自由创作', brief: brief.trim(), mode, style_tags: tags, garment_asset_ids: garments.map(item => item.id), ...(selectedModelId ? { model_asset_id: selectedModelId } : {}), ...(references.length ? { reference_asset_ids: references.map(item => item.id) } : {}) });
      if (result.kind === 'created') router.replace({ pathname: '/projects/[id]', params: { id: result.project.id } });
      else setCreationRecovery(result.recovery);
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  const descriptions = { auto: '交给我们，全套图文和视频一次出好，中途可以接手。', guided: '聊灵感、定脚本、挑图改图，每一步你说了算。' };
  return <Page tone="studio">
    <Header title="拍一组新片" onBack={() => router.back()} />
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} contentContainerStyle={[styles.content, { gap: space.xl }]}>
        <AnimatedEntry style={localStyles.intro}>
          <Text style={localStyles.eyebrow}>YOUR NEXT TAKE / 01</Text>
          <Text style={localStyles.display}>一件衣服，{ '\n' }一组大片</Text>
          <Text style={localStyles.caption}>带上衣服，把灵感交给片场。</Text>
        </AnimatedEntry>
        <View style={localStyles.modeSwitch} accessibilityRole="tablist" accessibilityLabel="出片模式">
          {(['auto', 'guided'] as const).map(value => <Pressable key={value} accessibilityRole="tab" accessibilityLabel={value === 'auto' ? '一键出片' : '沉浸编导'} accessibilityState={{ selected: mode === value }} aria-selected={mode === value} testID={`mode-${value}`} onPress={() => { setMode(value); setError(''); }} style={[localStyles.mode, mode === value && localStyles.modeActive]}><Ionicons name={value === 'auto' ? 'sparkles-outline' : 'film-outline'} size={18} color={mode === value ? studio.ink : studio.muted} /><Text style={[localStyles.modeTitle, mode !== value && { color: studio.muted }]}>{value === 'auto' ? '一键出片' : '沉浸编导'}</Text></Pressable>)}
        </View>
        <View style={styles.row}><Text testID="mode-description" style={[localStyles.caption, { flex: 1 }]}>{descriptions[mode]}</Text><Pressable accessibilityRole="button" accessibilityLabel={mode === 'auto' ? '了解一键出片' : '了解沉浸编导'} onPress={() => setHelp(mode)} style={localStyles.help}><Ionicons name="help-circle-outline" size={23} color={studio.muted} /></Pressable></View>
        <View style={localStyles.section}>
          <View style={[styles.row, { justifyContent: 'space-between', flexWrap: 'wrap' }]}><Text style={localStyles.sectionTitle}>衣服（必填）</Text><Badge label="至少 1 张 · 支持多选" /></View>
          {!!garments.length && <View style={localStyles.thumbnails}>{garments.map((item, index) => <View key={item.id} style={localStyles.garment}>
            <FadeImage source={{ uri: item.url }} style={localStyles.garmentImage} />
            <Pressable accessibilityRole="button" accessibilityLabel={`移除衣服图 ${index + 1}`} disabled={!!uploading || busy} onPress={() => setGarments(previous => previous.filter(asset => asset.id !== item.id))} style={({ pressed }) => [localStyles.removeImage, pressed && localStyles.pressed]}><View style={localStyles.removeGlyph}><Ionicons name="close" size={16} color={studio.ink} /></View></Pressable>
          </View>)}</View>}
          <Pressable accessibilityRole="button" accessibilityLabel="上传衣服图" testID="upload-garments" disabled={!!uploading || busy} onPress={() => void pick('garment')} style={({ pressed }) => [localStyles.uploadArea, pressed && localStyles.uploadPressed, (!!uploading || busy) && { opacity: 0.6 }]}>
            <View style={localStyles.uploadIcon}><Ionicons name="add" size={24} color={studio.accent} /></View>
            <Text style={localStyles.uploadTitle}>{uploading === 'garment' ? '正在上传衣服图…' : '添加衣服图'}</Text>
            <Text style={localStyles.caption}>平铺、挂拍或商品图都可以</Text>
          </Pressable>
          <GarmentPicker selectedIds={garments.map(item => item.id)} onSelect={selectGarment} disabled={!!uploading || busy} />
        </View>
        <View style={localStyles.section}>
          <View style={styles.row}><Text style={localStyles.sectionTitle}>出镜的人</Text><Badge label="选填" /></View>
          <Text style={localStyles.subtitle}>{savedPhotos.length ? '已默认带上档案里的本人照片，也可以选择另一张。' : '上传你的照片作为模特；留空就用默认模特。'}</Text>
          {!!savedPhotos.length && <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.md }}>{savedPhotos.map((photo, index) => <Pressable key={photo.id} accessibilityRole="button" accessibilityLabel={`选择档案照片 ${index + 1}`} accessibilityState={{ selected: selectedModelId === photo.id }} aria-selected={selectedModelId === photo.id} onPress={() => setModelChoice(photo.id)} style={({ pressed }) => [localStyles.profilePhoto, selectedModelId === photo.id && localStyles.profileSelected, pressed && localStyles.pressed]}>
            {photo.url ? <FadeImage source={{ uri: photo.url }} style={localStyles.profileImage} /> : <View style={[localStyles.profileImage, localStyles.profilePlaceholder]}><Ionicons name="person-outline" size={24} color={studio.muted} /></View>}
            <Text style={[localStyles.caption, { textAlign: 'center', color: selectedModelId === photo.id ? studio.accent : studio.muted }]}>{index === 0 ? '档案默认' : `照片 ${index + 1}`}{selectedModelId === photo.id ? ' ✓' : ''}</Text>
            <ModelSourceLabel id={photo.id} />
          </Pressable>)}</ScrollView>}
          {selectedModelId && !savedPhotos.some(photo => photo.id === selectedModelId) && selectedModel && <View style={[styles.row, { flexWrap: 'wrap' }]}>{selectedModel.url && <FadeImage source={{ uri: selectedModel.url }} style={localStyles.profileImage} />}<Text style={localStyles.subtitle}>这组片的本人照片</Text><ModelSourceLabel source={model?.source} /><Button title="移除照片" variant="ghost" onPress={() => { setModel(null); setModelChoice(undefined); }} /></View>}
          <Button title={uploading === 'model' ? '正在上传…' : selectedModelId ? '更换我的照片' : '上传我的照片'} icon="person-outline" variant="secondary" disabled={!!uploading || busy} onPress={() => void pick('model')} />
        </View>
        <View style={localStyles.section}>
          <View style={[styles.row, { justifyContent: 'space-between', flexWrap: 'wrap' }]}><Text style={localStyles.sectionTitle}>参考图（选填）</Text><Text testID="reference-count" style={localStyles.caption}>{references.length}/3</Text></View>
          <Text style={localStyles.subtitle}>{mode === 'auto' ? '一键出片建议带上参考，光线和构图更有方向。' : '带上喜欢的场景、光线或构图。'}</Text>
          {!!references.length && <View style={localStyles.thumbnails}>{references.map((item, index) => <View key={item.id} testID={`reference-asset-${item.id}`} style={localStyles.garment}>
            <FadeImage source={{ uri: item.url }} style={localStyles.garmentImage} accessibilityLabel={`参考图 ${index + 1}`} />
            <Pressable accessibilityRole="button" accessibilityLabel={`移除参考图 ${index + 1}`} disabled={!!uploading || busy} onPress={() => setReferences(previous => previous.filter(asset => asset.id !== item.id))} style={({ pressed }) => [localStyles.removeImage, pressed && localStyles.pressed]}><View style={localStyles.removeGlyph}><Ionicons name="close" size={16} color={studio.ink} /></View></Pressable>
          </View>)}</View>}
          <Button title={uploading === 'reference' ? '正在上传参考图…' : references.length === 3 ? '已添加 3 张参考图' : '添加参考图'} icon="images-outline" variant="secondary" testID="upload-references" disabled={!!uploading || busy || references.length >= 3} onPress={() => void pick('reference')} />
          <Text style={localStyles.caption}>最多 3 张，可移除后重新选择。</Text>
        </View>
        <View style={localStyles.section}>
          <Text style={localStyles.sectionTitle}>描述你的风格</Text>
          <Field label="这次想拍什么" placeholder="想穿去哪里？喜欢什么光线、氛围？" value={brief} onChangeText={setBrief} multiline />
          <View style={localStyles.tags} testID="style-tags">{styleBatch(batch).map(tag => <Pressable key={tag} accessibilityRole="button" accessibilityLabel={`风格：${tag}`} accessibilityState={{ selected: tags.includes(tag), disabled: tags.length >= 6 && !tags.includes(tag) }} aria-selected={tags.includes(tag)} testID={`style-tag-${tag}`} disabled={tags.length >= 6 && !tags.includes(tag)} onPress={() => setTags(previous => toggleStyleTag(previous, tag))} style={[localStyles.tag, tags.includes(tag) && localStyles.tagSelected]}><Text style={[localStyles.caption, tags.includes(tag) && { color: studio.ink }]}>{tag}</Text></Pressable>)}</View>
          <View style={[styles.row, { justifyContent: 'space-between' }]}><Text testID="selected-style-tags" style={[localStyles.caption, { flex: 1 }]}>{tags.length ? `已选 ${tags.length}/6 · ${tags.join('、')}` : '最多选 6 个，也可以只写想法'}</Text><Button title="换一批" testID="shuffle-style-tags" variant="ghost" icon="shuffle-outline" onPress={() => setBatch(value => value + 1)} /></View>
          <Field label="品牌" placeholder="选填，留空就是自由创作" value={brand} onChangeText={setBrand} maxLength={100} />
          <Field label="项目名称" placeholder={`${brand.trim() || '自由创作'} · ${tags[0] || STYLE_TAGS[0]}`} value={title} onChangeText={setTitle} maxLength={100} />
        </View>
        {!!quoteError && mode === 'auto' && <Notice text={quoteError} onRetry={() => { void api.autoQuote().then(value => { if (!Number.isFinite(value.estimate_points) || value.estimate_points < 0) throw new Error('invalid quote'); setQuote(value); setQuoteError(''); }).catch(() => setQuoteError('估点暂时没取到，可稍后再试。')); }} />}
        {!!uploading && <ProgressStrip title={uploading === 'garment' ? '正在上传衣服图…' : uploading === 'reference' ? '正在上传参考图…' : '正在上传本人照片…'} detail={uploadProgress ? `第 ${uploadProgress.current}/${uploadProgress.total} 张` : '正在选择图片'} />}
        {!!error && <Notice text={error} />}
        {creationRecovery && <View style={{ gap: space.md }}>
          <Notice text={projectCreationRecoveryText(creationRecovery)} />
          {creationRecovery.projects?.map(project => <Button key={project.id} title={`打开项目：${project.title}`} variant="secondary" disabled={busy} onPress={() => router.replace({ pathname: '/projects/[id]', params: { id: project.id } })} />)}
          {creationRecovery.projects !== null && <Button title="确认重新新建" variant="secondary" disabled={busy || !!uploading} onPress={() => void submit(true)} />}
        </View>}
      </ScrollView>
      <View style={localStyles.footer}><Button title={creationRecovery ? '再查一次项目' : mode === 'guided' ? '开拍，先聊灵感' : quote ? `开拍，全自动 · 约 ${formatPoints(quote.estimate_points)}` : '正在估点…'} testID="start-shooting" icon="arrow-forward" loading={busy} disabled={!!uploading || (mode === 'auto' && !quote)} onPress={() => void submit()} /></View>
    </KeyboardAvoidingView>
    <Modal visible={help !== null} transparent animationType="fade" onRequestClose={() => setHelp(null)}><View style={localStyles.helpOverlay}><View accessibilityViewIsModal style={localStyles.helpCard}><Text style={localStyles.sectionTitle}>{help === 'auto' ? '一键出片' : '沉浸编导'}</Text><Text style={localStyles.subtitle}>{help ? descriptions[help] : ''}</Text><Button title="知道了" onPress={() => setHelp(null)} /></View></View></Modal>
  </Page>;
}

const localStyles = StyleSheet.create({
  display: { ...type.display, color: studio.ink },
  sectionTitle: { ...type.heading, color: studio.ink },
  subtitle: { ...type.body, color: studio.muted },
  modeSwitch: { flexDirection: 'row', padding: space.xs, gap: space.xs, borderWidth: 1, borderColor: studio.line, borderRadius: radius.md, backgroundColor: studio.canvas },
  mode: { minHeight: 52, flex: 1, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: space.sm, borderRadius: radius.sm },
  modeActive: { backgroundColor: studio.glass, borderWidth: 1, borderColor: studio.line },
  modeTitle: { ...type.subtitle, color: studio.ink },
  help: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  helpOverlay: { flex: 1, backgroundColor: studio.helpOverlay, justifyContent: 'center', padding: space.xl },
  helpCard: { alignSelf: 'center', width: '100%', maxWidth: 440, backgroundColor: studio.surface, borderColor: studio.line, borderWidth: 1, padding: space.xl, borderRadius: radius.lg, gap: space.xl },
  footer: { borderTopWidth: 1, borderColor: studio.line, backgroundColor: studio.bg, padding: space.lg },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  tag: { minHeight: 44, paddingHorizontal: space.md, paddingVertical: space.md, borderRadius: radius.sm, borderWidth: 1, borderColor: studio.line, backgroundColor: studio.canvas, justifyContent: 'center' },
  tagSelected: { backgroundColor: studio.softAccent, borderColor: studio.accent },
  intro: { gap: space.sm, paddingVertical: space.sm },
  eyebrow: { ...type.badge, color: studio.accent, letterSpacing: 2 },
  formSection: { gap: space.xl },
  section: { gap: space.lg, padding: space.lg, borderWidth: 1, borderColor: studio.line, borderRadius: radius.lg, backgroundColor: studio.glass },
  thumbnails: { flexDirection: 'row', flexWrap: 'wrap', gap: space.md },
  garment: { width: 96, aspectRatio: 3 / 4 },
  garmentImage: { width: '100%', height: '100%', borderRadius: radius.md, backgroundColor: studio.canvas },
  removeImage: { position: 'absolute', top: 0, right: 0, minWidth: 44, minHeight: 44, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' },
  removeGlyph: { width: 28, height: 28, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center', backgroundColor: studio.glass },
  pressed: { opacity: 0.7, transform: [{ scale: 0.97 }] },
  uploadArea: { borderWidth: 1, borderStyle: 'dashed', borderColor: studio.line, borderRadius: radius.md, padding: space.xl, alignItems: 'center', backgroundColor: studio.canvas, gap: space.sm },
  uploadPressed: { backgroundColor: studio.softAccent, transform: [{ scale: 0.99 }] },
  uploadIcon: { height: 44, width: 44, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center', backgroundColor: studio.softAccent },
  uploadTitle: { ...type.body, color: studio.ink, fontWeight: '600' },
  caption: { ...type.caption, color: studio.muted },
  profilePhoto: { borderWidth: 2, borderColor: studio.line, borderRadius: radius.md, padding: space.xs, gap: space.sm, backgroundColor: studio.surface },
  profileSelected: { borderColor: studio.accent, backgroundColor: studio.softAccent },
  profileImage: { width: 84, aspectRatio: 3 / 4, borderRadius: radius.sm, backgroundColor: studio.canvas },
  profilePlaceholder: { alignItems: 'center', justifyContent: 'center' },
});
