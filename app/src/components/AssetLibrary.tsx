import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { ApiError } from '../api/client';
import type { Asset } from '../api/types';
import { useSession } from '../context/Session';
import { hideAssetLibrary, loadLibraryModels, modelLibraryAsset, useLibraryModels, type LibraryAsset, type LibraryKind } from '../lib/assets';
import { colors, layout, radius, space, studio, type } from '../theme';
import { previewUrl } from '../lib/previewUrl';
import { filterGarmentsByTag, garmentTagCounts, toggleGarmentTag, type GarmentTagCount } from '../lib/garmentTags';
import { defaultModelId, modelStatusText } from '../lib/models';
import { Chip } from './ds/Chip';
import { Badge, Button, FadeImage, Header, IconButton, Notice, Page, Skeleton, StatePanel, Toast, errorText } from './ui';
import { VideoPlayer } from './VideoPlayer';

const tabs: { kind: LibraryKind; title: string }[] = [{ kind: 'model', title: '我的模特' }, { kind: 'garment', title: '我的衣服' }, { kind: 'image', title: '我的成片' }, { kind: 'video', title: '我的短片' }];
const PAGE_SIZE = 30;

function GarmentTagFilters({ tags, selected, onSelect, testID }: { tags: GarmentTagCount[]; selected: string | null; onSelect: (tag: string | null) => void; testID: string }) {
  if (!tags.length) return null;
  return <View style={local.tagFilters} testID={testID}>
    <Text style={local.body}>按衣服标签筛选{selected ? ` · ${selected}` : ''}</Text>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={local.tagChips}>
      {tags.map(({ tag, count }) => <Chip key={tag} label={`${tag} · ${count}`} selected={selected === tag} onPress={() => onSelect(toggleGarmentTag(selected, tag))} />)}
    </ScrollView>
  </View>;
}

export function AssetLibraryEntry({ compact = false }: { compact?: boolean }) {
  const router = useRouter();
  const library = useLibraryModels();
  if (library.supported !== true) return null;
  return compact ? <IconButton name="images-outline" label="素材库" onPress={() => router.push('/assets')} /> : <Button title="素材库" icon="images-outline" variant="secondary" onPress={() => router.push('/assets')} />;
}

export function ModelSourceLabel({ id, source }: { id?: string; source?: Asset['source'] }) {
  const library = useLibraryModels();
  const value = source || library.models?.find(item => item.id === id)?.source;
  return value ? <Text style={local.source}>{value === 'generated' ? '成片' : '上传'}</Text> : null;
}

export function GarmentPicker({ selectedIds, onSelect, disabled = false }: { selectedIds: string[]; onSelect: (item: Asset) => void; disabled?: boolean }) {
  const { api, token, baseUrl, isCurrentSession } = useSession();
  const library = useLibraryModels();
  const { garment } = useLocalSearchParams<{ garment?: string | string[] }>();
  const prefillId = Array.isArray(garment) ? garment[0] : garment;
  const prefilled = useRef('');
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<LibraryAsset[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  useEffect(() => {
    if (library.supported !== true || (!open && (!prefillId || prefilled.current === prefillId))) return;
    let active = true;
    setLoading(true); setError('');
    void (async () => {
      try {
        const choices: LibraryAsset[] = [];
        let total = 0;
        do {
          const page = await api.myAssets('garment', 100, choices.length);
          choices.push(...page.items); total = page.total;
          if (!page.items.length) break;
        } while (choices.length < total);
        if (active && isCurrentSession(token, baseUrl)) {
          setItems(choices);
          if (prefillId && prefilled.current !== prefillId) {
            prefilled.current = prefillId;
            const item = choices.find(choice => choice.id === prefillId);
            if (item) onSelect({ ...item, kind: 'garment' });
            else setError('这件衣服暂时没找到，请从我的衣服里重新选择。');
          }
        }
      } catch (failure) {
        if (!active || !isCurrentSession(token, baseUrl)) return;
        if (failure instanceof ApiError && failure.status === 404) hideAssetLibrary(api);
        else setError(errorText(failure));
      } finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, [api, baseUrl, isCurrentSession, library.supported, onSelect, open, prefillId, retry, token]);
  if (library.supported !== true) return null;
  return <View style={local.pickerGroup}>
    <Button title="从我的衣服里选" variant="secondary" disabled={disabled} onPress={() => setOpen(true)} />
    {loading && !open && <Text accessibilityRole="status" style={local.body}>正在取回我的衣服…</Text>}
    {!!error && !open && <Notice text={error} onRetry={() => { prefilled.current = ''; setRetry(value => value + 1); }} />}
    <Modal visible={open} animationType="slide" onRequestClose={() => setOpen(false)}><Page tone="studio"><Header title="我的衣服" onBack={() => setOpen(false)} /><ScrollView contentContainerStyle={local.content}>
      <GarmentTagFilters tags={garmentTagCounts(items)} selected={selectedTag} onSelect={setSelectedTag} testID="picker-garment-tags" />
      {!!error && <Notice text={error} onRetry={() => setRetry(value => value + 1)} />}
      {loading ? <View accessibilityRole="progressbar" accessibilityLabel="正在加载我的衣服"><Skeleton height={layout.touch * 3} /></View> : !items.length && !error ? <StatePanel icon="shirt-outline" title="我的衣服" description="拍过的片都会留在这里" /> : null}
      {!loading && selectedTag && !filterGarmentsByTag(items, selectedTag).length ? <Text style={local.body}>这个标签下还没有衣服，再点标签可取消筛选。</Text> : null}
      {!loading && filterGarmentsByTag(items, selectedTag).map(item => <Pressable key={item.id} testID={`pick-garment-${item.id}`} accessibilityRole="button" accessibilityLabel={`选择我的衣服 ${item.name || item.project_title || '这件衣服'}`} accessibilityState={{ disabled: selectedIds.includes(item.id), selected: selectedIds.includes(item.id) }} disabled={selectedIds.includes(item.id)} onPress={() => { onSelect({ ...item, kind: 'garment' }); setOpen(false); }} style={({ pressed }) => [local.pickerCard, pressed && local.pressed]}><FadeImage source={{ uri: previewUrl(item.url) }} style={local.pickerImage} resizeMode="cover" /><View style={local.pickerDescription}><Text style={local.name}>{item.name || item.project_title || '我的衣服'}</Text>{item.tags?.length ? <Text style={local.source}>{item.tags.join(' · ')}</Text> : null}<Text style={local.body}>{selectedIds.includes(item.id) ? '已添加' : '用这件拍一组新片'}</Text></View></Pressable>)}
    </ScrollView></Page></Modal>
  </View>;
}

export function AssetLibrary() {
  const { api, user, token, baseUrl, updateMe, refreshUser, isCurrentSession } = useSession();
  const library = useLibraryModels();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const tileWidth = (Math.min(width, layout.maxWidth) - space.xl * 2 - space.md) / 2;
  const [kind, setKind] = useState<LibraryKind>('model');
  const [items, setItems] = useState<LibraryAsset[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [candidate, setCandidate] = useState<LibraryAsset>();
  const [preview, setPreview] = useState<LibraryAsset>();
  const [busy, setBusy] = useState(false);
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [tags, setTags] = useState<GarmentTagCount[]>([]);
  const [tagError, setTagError] = useState('');
  const [tagRevision, setTagRevision] = useState(0);
  useEffect(() => {
    if (kind !== 'garment') return;
    let active = true;
    void api.myAssetTags().then(page => {
      if (active && isCurrentSession(token, baseUrl)) {
        setTags(page.items); setTagError('');
        setSelectedTag(current => page.items.some(item => item.tag === current) ? current : null);
      }
    }).catch(failure => { if (active && isCurrentSession(token, baseUrl)) setTagError(errorText(failure)); });
    return () => { active = false; };
  }, [api, baseUrl, isCurrentSession, kind, tagRevision, token]);
  const generation = useRef(0);
  const load = useCallback(async (offset = 0) => {
    const attempt = ++generation.current;
    setLoading(true); setError('');
    try {
      const page = kind === 'model' ? await api.myModels().then(page => {
        const models = page.items.filter(item => item.kind !== 'preset' && item.face);
        return { items: models.slice(offset, offset + PAGE_SIZE).map(modelLibraryAsset), total: models.length };
      }) : await api.myAssets(kind, PAGE_SIZE, offset, selectedTag);
      if (attempt !== generation.current || !isCurrentSession(token, baseUrl)) return;
      setItems(previous => offset ? [...previous, ...page.items.filter(item => !previous.some(existing => (existing.model_id || existing.id) === (item.model_id || item.id)))] : page.items);
      setTotal(page.total);
    } catch (failure) {
      if (attempt !== generation.current || !isCurrentSession(token, baseUrl)) return;
      if (failure instanceof ApiError && failure.status === 404) hideAssetLibrary(api);
      else setError(errorText(failure));
    } finally { if (attempt === generation.current) setLoading(false); }
  }, [api, baseUrl, isCurrentSession, kind, selectedTag, token]);
  useFocusEffect(useCallback(() => { setItems([]); setTotal(0); void load(); return () => { generation.current += 1; }; }, [load]));
  async function makeDefault(item: LibraryAsset) {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await updateMe({ profile: { model_asset_ids: [item.id, ...(user?.profile?.model_asset_ids || []).filter(id => id !== item.id)] } });
      if (!isCurrentSession(token, baseUrl)) return;
      await loadLibraryModels(api, true);
      setNotice('已设为默认出镜的人');
    } catch (failure) { if (isCurrentSession(token, baseUrl)) setError(errorText(failure)); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!candidate || busy) return;
    const item = candidate;
    setBusy(true); setError(''); setNotice('');
    try {
      if (kind === 'model' && item.model_id) await api.deleteModel(item.model_id);
      else await api.deleteMyAsset(item.id);
      if (!isCurrentSession(token, baseUrl)) return;
      setItems(previous => previous.filter(asset => (asset.model_id || asset.id) !== (item.model_id || item.id))); setTotal(previous => Math.max(0, previous - 1)); setCandidate(undefined);
      await Promise.allSettled([refreshUser(), loadLibraryModels(api, true)]);
      setNotice('已删除');
      setTagRevision(value => value + 1);
    } catch (failure) { if (isCurrentSession(token, baseUrl)) { setError(errorText(failure)); setCandidate(undefined); } }
    finally { setBusy(false); }
  }
  const title = (item: LibraryAsset) => item.name || item.analysis?.name || item.project_title || (item.kind === 'model' ? '我的模特' : item.kind === 'garment' ? '我的衣服' : item.kind === 'video' ? '我的短片' : '我的成片');
  if (library.supported === false) return <View style={local.content}><StatePanel icon="images-outline" title="当前服务未开通素材库" description="拍过的片都会留在这里" /></View>;
  return <View style={local.root}>
    <View accessibilityRole="tablist" style={local.tabs}>{tabs.map(tab => <Pressable key={tab.kind} accessibilityRole="tab" accessibilityLabel={tab.title} accessibilityState={{ selected: kind === tab.kind }} aria-selected={kind === tab.kind} testID={`library-tab-${tab.kind}`} onPress={() => { if (kind !== tab.kind) { setKind(tab.kind); setSelectedTag(null); setNotice(''); } }} style={({ pressed }) => [local.tab, kind === tab.kind && local.tabSelected, pressed && local.pressed]}><Text style={[local.tabText, kind === tab.kind && local.selectedText]}>{tab.title}</Text></Pressable>)}</View>
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={local.content}>
      {kind === 'garment' ? <GarmentTagFilters tags={tags} selected={selectedTag} onSelect={setSelectedTag} testID="library-garment-tags" /> : null}
      {kind === 'garment' && tagError ? <Notice text={tagError} onRetry={() => setTagRevision(value => value + 1)} /> : null}
      {!!notice && <Toast text={notice} onDismiss={() => setNotice('')} />}
      {!!error && <Notice text={error} onRetry={() => void load(items.length ? items.length : 0)} />}
      {loading && !items.length ? <View accessibilityRole="progressbar" accessibilityLabel="正在加载素材库" style={local.grid}>{[0, 1].map(index => <Skeleton key={index} width={tileWidth} height={tileWidth / layout.thumbnailRatio} />)}</View> : null}
      {!loading && !items.length && !error ? <StatePanel icon={kind === 'garment' ? 'shirt-outline' : kind === 'model' ? 'person-outline' : kind === 'video' ? 'videocam-outline' : 'images-outline'} title={tabs.find(tab => tab.kind === kind)!.title} description={kind === 'garment' && selectedTag ? '这个标签下还没有衣服，再点标签可取消筛选。' : '拍过的片都会留在这里'} /> : null}
      <View style={local.grid}>{items.map(item => <View key={item.model_id || item.id} testID={`library-${item.id}`} style={[local.tile, { width: tileWidth }]}>
        <Pressable accessibilityRole="button" accessibilityLabel={`查看${title(item)}`} onPress={() => setPreview(item)} style={local.imageFrame} testID={`library-image-${item.id}`}><FadeImage source={{ uri: previewUrl(item.kind === 'video' ? (item.poster_url || item.url) : item.url) }} style={local.image} resizeMode="cover" accessibilityLabel={title(item)} />{item.kind === 'video' ? <View style={local.playBadge}><Ionicons name="play" size={16} color={colors.white} /></View> : null}</Pressable>
        <View style={local.details}><View style={local.labels}><Badge label={item.model_status ? modelStatusText({ status: item.model_status, missing: item.missing || [] }) : item.kind === 'video' ? '5 秒短片' : item.source === 'generated' ? '成片' : '上传'} />{kind === 'model' && (item.model_id ? item.model_id === defaultModelId(library.identities || [], user?.profile?.model_asset_ids[0]) : user?.profile?.model_asset_ids[0] === item.id) ? <Badge label="默认" tone="brand" /> : null}</View><Text numberOfLines={2} style={local.name}>{title(item)}</Text>
          {kind === 'garment' && item.tags?.length ? <Text style={local.source}>{item.tags.join(' · ')}</Text> : null}
          {kind === 'model' ? <><Button title="设为默认" variant="secondary" disabled={busy || (!!item.model_status && item.model_status !== 'ready') || user?.profile?.model_asset_ids[0] === item.id} onPress={() => void makeDefault(item)} /><Button title="删除" variant="ghost" disabled={busy} onPress={() => setCandidate(item)} /></> : null}
          {kind === 'garment' ? <><Button title="用这件拍一组新片" variant="secondary" onPress={() => router.push({ pathname: '/projects/new', params: { garment: item.id } })} /><Button title="删除" variant="ghost" disabled={busy} onPress={() => setCandidate(item)} /></> : null}
          {(kind === 'image' || kind === 'video') && item.project_id ? <Button title="回到这组片" variant="secondary" onPress={() => router.push({ pathname: '/projects/[id]', params: { id: item.project_id! } })} /> : null}
        </View>
      </View>)}</View>
      {items.length < total && items.length > 0 ? <Button title="再看一些" variant="secondary" loading={loading} onPress={() => void load(items.length)} /> : null}
    </ScrollView>
    <Modal visible={!!candidate} transparent animationType="fade" onRequestClose={() => { if (!busy) setCandidate(undefined); }}><View style={local.shade}><View accessibilityViewIsModal testID="library-delete-confirmation" style={local.dialog}><Text style={local.dialogTitle}>确认删除{candidate?.kind === 'model' ? '这位模特' : '这件衣服'}？</Text><Text style={local.body}>{candidate?.kind === 'model' ? '会从我的模特与默认出镜中移除；正在被片场使用或正在建立身份卡的模特不能删，已拍的片会保留。' : '没有被片场使用的衣服可以删除。'}</Text><Button title="确认删除" variant="danger" loading={busy} onPress={() => void remove()} /><Button title="取消" variant="secondary" disabled={busy} onPress={() => setCandidate(undefined)} /></View></View></Modal>
    <Modal visible={!!preview} transparent animationType="fade" onRequestClose={() => setPreview(undefined)}><View style={local.shade}><View accessibilityViewIsModal testID="library-preview" style={local.preview}><Text style={local.dialogTitle}>{preview ? title(preview) : ''}</Text>{preview && (preview.kind === 'video' ? <VideoPlayer uri={preview.url} posterUrl={preview.poster_url || undefined} autoPlay /> : <FadeImage source={{ uri: preview.url }} style={local.previewImage} resizeMode="contain" accessibilityLabel="素材库大图" />)}{preview?.project_id ? <Button title="回到这组片" variant="secondary" onPress={() => { const id = preview.project_id!; setPreview(undefined); router.push({ pathname: '/projects/[id]', params: { id } }); }} /> : null}<Button title={preview?.kind === 'video' ? '关闭' : '关闭大图'} variant="ghost" onPress={() => setPreview(undefined)} /></View></View></Modal>
  </View>;
}

const local = StyleSheet.create({
  tagFilters: { gap: space.sm },
  tagChips: { gap: space.sm },
  source: { ...type.badge, color: studio.muted, textAlign: 'center', paddingVertical: space.xs },
  pickerGroup: { gap: space.sm },
  pickerCard: { minHeight: layout.touch, flexDirection: 'row', alignItems: 'center', padding: space.md, gap: space.md, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: studio.line, backgroundColor: studio.canvas },
  pickerImage: { width: layout.touch * 2, aspectRatio: layout.thumbnailRatio, borderRadius: radius.sm },
  pickerDescription: { flex: 1, gap: space.sm },
  root: { flex: 1 },
  tabs: { flexDirection: 'row', padding: space.lg, gap: space.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: studio.line },
  playBadge: { position: 'absolute', right: space.sm, bottom: space.sm, width: 32, height: 32, borderRadius: radius.md, backgroundColor: colors.red, alignItems: 'center', justifyContent: 'center', paddingLeft: space.xs },
  tab: { flex: 1, minHeight: layout.touch, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm, backgroundColor: studio.canvas, paddingHorizontal: space.xs },
  tabSelected: { backgroundColor: studio.softAccent },
  tabText: { ...type.label, color: studio.muted },
  selectedText: { color: studio.ink },
  pressed: { backgroundColor: studio.surface },
  content: { padding: space.xl, paddingBottom: space.xxl, gap: space.lg },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.md, alignItems: 'flex-start' },
  tile: { borderRadius: radius.md, backgroundColor: studio.canvas, overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth, borderColor: studio.line },
  imageFrame: { width: '100%', aspectRatio: layout.thumbnailRatio, minHeight: layout.touch, backgroundColor: studio.surface },
  image: { width: '100%', height: '100%' },
  details: { padding: space.sm, gap: space.sm },
  labels: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  name: { ...type.label, color: studio.ink },
  shade: { flex: 1, backgroundColor: colors.heroOverlay, alignItems: 'center', justifyContent: 'center', padding: space.xl },
  dialog: { width: '100%', maxWidth: layout.maxWidth, padding: space.xl, gap: space.lg, borderRadius: radius.lg, backgroundColor: studio.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: studio.line },
  dialogTitle: { ...type.subtitle, color: studio.ink },
  body: { ...type.body, color: studio.muted },
  preview: { width: '100%', maxWidth: layout.maxWidth, maxHeight: '100%', padding: space.lg, gap: space.md, borderRadius: radius.lg, backgroundColor: studio.bg },
  previewImage: { width: '100%', aspectRatio: layout.thumbnailRatio, flexShrink: 1, minHeight: layout.touch },
});
