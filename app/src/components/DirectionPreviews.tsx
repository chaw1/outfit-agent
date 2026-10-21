import { useState } from 'react';
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Action, Direction } from '../api/types';
import { directionPreviews, retryDirectionPreview, type DirectionPreview } from '../lib/directionPreviews';
import { previewUrl } from '../lib/previewUrl';
import { formatPoints } from '../lib/transparency';
import { colors, radius, space, studio, type as typography } from '../theme';
import { Badge, Button, FadeImage, IconButton, ProgressStrip } from './ui';

function PreviewTile({ direction, preview, selected, enabled, retryPoints, onSelect, onView, onRetry }: {
  direction: Direction; preview: DirectionPreview; selected: boolean; enabled: boolean; retryPoints?: number;
  onSelect: () => void; onView: () => void; onRetry: () => void;
}) {
  const [failedUrl, setFailedUrl] = useState<string>();
  const [reload, setReload] = useState(0);
  const ready = preview.status === 'succeeded' && !!preview.url && failedUrl !== preview.url;
  const failed = preview.status === 'failed' || (preview.status === 'succeeded' && !ready);
  return <View testID={`preview-tile-${preview.id}`} style={[local.tile, selected && local.selected]}>
    <View style={local.imageArea}>
      {ready && preview.url ? <Pressable accessibilityRole="button" accessibilityLabel={`查看${direction.name} · ${preview.variant}`} testID={`preview-image-${preview.id}`} onPress={onView} style={local.image}>
        <FadeImage key={reload} source={{ uri: previewUrl(preview.url) }} style={local.image} resizeMode="cover" onError={() => setFailedUrl(preview.url ?? undefined)} accessibilityLabel={`${direction.name} · ${preview.variant}`} />
        <View style={local.zoom}><Badge label="点开看大图" /></View>
      </Pressable> : <View style={local.placeholder}>
        {failed ? <><Text style={local.hint}>这张灵感图暂时没成功</Text><Button title={preview.status === 'failed' ? `重试这张${retryPoints === undefined ? '' : ` · 约 ${formatPoints(retryPoints)}`}` : '重新加载'} variant="secondary" disabled={!enabled && preview.status === 'failed'} testID={`retry-preview-${preview.id}`} onPress={() => { if (preview.status === 'failed') onRetry(); else { setFailedUrl(undefined); setReload(value => value + 1); } }} /></> : <ProgressStrip title={preview.status === 'running' ? '正在描绘这张灵感…' : '灵感图已排队'} />}
      </View>}
    </View>
    <Pressable accessibilityRole="radio" aria-checked={selected} accessibilityLabel={`选择${preview.variant}`} accessibilityState={{ checked: selected, disabled: !enabled }} disabled={!enabled} testID={`select-preview-${preview.id}`} onPress={event => { event.stopPropagation(); onSelect(); }} style={local.caption}>
      <Text style={[local.variant, selected && local.selectedText]}>{preview.variant}</Text><Text style={local.hint}>{selected ? '✓ 已选中' : '选这张'}</Text>
    </Pressable>
  </View>;
}

export function DirectionPreviews({ direction, selectedId, enabled, retryPoints, onSelect, onAction }: {
  direction: Direction; selectedId: string; enabled: boolean; retryPoints?: number;
  onSelect: (id: string) => void; onAction: (action: Action) => void;
}) {
  const [viewingId, setViewingId] = useState<string>();
  const previews = directionPreviews(direction);
  const viewing = previews.find(item => item.id === viewingId);
  const insets = useSafeAreaInsets();
  return <>
    <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={local.strip} testID={`direction-preview-${direction.id}`}>
      {previews.map(preview => <PreviewTile key={preview.id} direction={direction} preview={preview} selected={selectedId === preview.id} enabled={enabled} retryPoints={retryPoints} onSelect={() => onSelect(preview.id)} onView={() => setViewingId(preview.id)} onRetry={() => { const action = retryDirectionPreview(direction, preview.id); if (action) onAction(action); }} />)}
    </ScrollView>
    <Modal visible={!!viewing} animationType="slide" presentationStyle="fullScreen" onRequestClose={() => setViewingId(undefined)}>
      <SafeAreaView edges={['bottom']} style={[local.viewer, { paddingTop: Platform.OS === 'ios' ? insets.top + space.sm : insets.top }]} testID="direction-preview-viewer">
        <View style={local.viewerHeader}><View style={local.title}><Text style={local.viewerTitle}>{direction.name}</Text><Text style={local.hint}>{viewing?.variant}</Text></View><IconButton name="close" label="关闭方向灵感大图" onPress={() => setViewingId(undefined)} /></View>
        {viewing?.url ? <FadeImage source={{ uri: viewing.url }} resizeMode="contain" style={local.fullImage} accessibilityLabel={`${direction.name} · ${viewing.variant}大图`} /> : null}
        <View style={local.viewerFooter}><Text style={local.note}>{direction.scene} · {direction.mood}</Text>{enabled && viewing ? <Button title="选这张灵感" testID="select-viewed-preview" onPress={() => { onSelect(viewing.id); setViewingId(undefined); }} /> : null}</View>
      </SafeAreaView>
    </Modal>
  </>;
}

const local = StyleSheet.create({
  strip: { gap: space.sm, paddingBottom: space.md },
  tile: { width: 184, borderWidth: 2, borderColor: colors.border, borderRadius: radius.sm, overflow: 'hidden', backgroundColor: colors.surface },
  selected: { borderColor: colors.red },
  imageArea: { height: 218, backgroundColor: colors.imagePlaceholder },
  image: { width: '100%', height: '100%' },
  placeholder: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: space.sm, gap: space.sm },
  caption: { padding: space.sm, gap: space.xs },
  variant: { ...typography.caption, color: colors.ink, fontWeight: '600' },
  selectedText: { color: colors.redText },
  hint: { ...typography.caption, color: colors.muted },
  zoom: { position: 'absolute', bottom: space.sm, left: space.sm },
  viewer: { flex: 1, backgroundColor: studio.bg },
  viewerHeader: { flexDirection: 'row', alignItems: 'center', padding: space.lg, gap: space.md },
  title: { flex: 1, gap: space.xs },
  viewerTitle: { ...typography.subtitle, color: studio.ink },
  fullImage: { flex: 1, width: '100%' },
  viewerFooter: { padding: space.lg, gap: space.md },
  note: { ...typography.body, color: studio.ink },
});
