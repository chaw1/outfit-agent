import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { Asset } from '../api/types';
import { groupModels, modelStatusText, type ModelCard } from '../lib/models';
import { previewUrl } from '../lib/previewUrl';
import { layout, radius, space, studio, type } from '../theme';
import { FadeImage } from './ui';

export function ModelSelector({ models, uploaded, selectedId, onSelect, disabled = false }: {
  models: ModelCard[]; uploaded: Asset | null; selectedId?: string | null;
  onSelect: (id: string, source: 'model' | 'upload') => void; disabled?: boolean;
}) {
  const groups = groupModels(models, uploaded);
  return <View style={local.groups}>{groups.map(group => <View key={group.key} style={local.group}>
    <Text style={local.title}>{group.title}</Text>
    {!group.items.length && <Text style={local.caption}>{group.key === 'upload' ? '也可以上传本人照片，只用于这组片。' : '到设置里的「我的形象」建立身份卡。'}</Text>}
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={local.row}>
      {group.items.map(item => {
        const card = 'face' in item ? item : null;
        const photo = card ? card.face : item as Asset;
        const ready = card ? card.status === 'ready' : true;
        const selected = item.id === selectedId;
        const name = card?.name || '本次的本人照片';
        return <Pressable key={item.id} testID={`select-model-${item.id}`} accessibilityRole="button" accessibilityLabel={`选择${name}`} accessibilityState={{ selected, disabled: disabled || !ready }} aria-selected={selected} disabled={disabled || !ready} onPress={() => onSelect(item.id, card ? 'model' : 'upload')} style={({ pressed }) => [local.card, selected && local.selected, !ready && local.unavailable, pressed && local.pressed]}>
          {photo?.url ? <FadeImage source={{ uri: previewUrl(photo.url, 360) }} style={local.image} accessibilityLabel={name} /> : <View style={local.image} />}
          <Text numberOfLines={1} style={local.name}>{name}{selected ? ' ✓' : ''}</Text>
          <Text style={local.caption}>{card ? modelStatusText(card) : '本次使用'}</Text>
        </Pressable>;
      })}
    </ScrollView>
  </View>)}</View>;
}
const local = StyleSheet.create({
  groups: { gap: space.lg },
  group: { gap: space.sm },
  row: { gap: space.md },
  title: { ...type.label, color: studio.ink },
  caption: { ...type.caption, color: studio.muted },
  card: { width: layout.touch * 3, padding: space.sm, gap: space.xs, borderRadius: radius.md, borderWidth: 1, borderColor: studio.line, backgroundColor: studio.canvas },
  selected: { borderColor: studio.accent, backgroundColor: studio.softAccent },
  image: { width: '100%', aspectRatio: 3 / 4, borderRadius: radius.sm, backgroundColor: studio.surface },
  name: { ...type.label, color: studio.ink },
  unavailable: { opacity: 0.55 },
  pressed: { backgroundColor: studio.surface },
});
