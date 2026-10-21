import { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { radius, space, studio, type } from '../theme';
import { FadeImage, IconButton } from './ui';

const inspiration = [
  { source: require('../../assets/inspiration/studio-01.jpg'), label: '松弛通勤' },
  { source: require('../../assets/inspiration/studio-02.jpg'), label: '老钱极简' },
  { source: require('../../assets/inspiration/studio-03.jpg'), label: '法式慵懒' },
  { source: require('../../assets/inspiration/studio-04.jpg'), label: '街头胶片' },
  { source: require('../../assets/inspiration/studio-05.jpg'), label: '杂志大片' },
  { source: require('../../assets/inspiration/studio-06.jpg'), label: '咖啡馆午后' },
  { source: require('../../assets/inspiration/studio-07.jpg'), label: '闪光灯夜拍' },
  { source: require('../../assets/inspiration/studio-08.jpg'), label: '复古港风' },
  { source: require('../../assets/inspiration/studio-09.jpg'), label: '户外野餐' },
  { source: require('../../assets/inspiration/studio-10.jpg'), label: '美术馆漫步' },
] as const;

export function InspirationWall() {
  const [selected, setSelected] = useState<number | null>(null);
  const current = selected === null ? null : inspiration[selected];
  return <>
    <View testID="inspiration-wall" style={local.wall}>
      {[0, 1].map(column => <View key={column} style={local.column}>
        {inspiration.map((item, index) => index % 2 === column ? <Pressable key={index} testID={`inspiration-${String(index + 1).padStart(2, '0')}`} accessibilityRole="button" accessibilityLabel={`查看灵感 ${index + 1} · ${item.label}`} onPress={() => setSelected(index)} style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1, gap: space.sm })}>
          <View style={[local.image, { aspectRatio: index % 3 === 0 ? 0.68 : index % 3 === 1 ? 0.85 : 0.75 }]}><FadeImage source={item.source} resizeMode="cover" accessibilityLabel={`${item.label}穿搭成片`} style={{ width: '100%', height: '100%' }} /></View>
          <View style={local.caption}><Text style={local.number}>{String(index + 1).padStart(2, '0')}</Text><Text style={local.label}>{item.label}</Text></View>
        </Pressable> : null)}
      </View>)}
    </View>
    <Modal visible={current !== null} animationType="fade" onRequestClose={() => setSelected(null)}>
      <SafeAreaView testID="inspiration-viewer" style={local.viewer}>
        <View style={local.viewerHeader}><Text style={{ ...type.label, color: studio.ink }}>{current?.label}</Text><IconButton name="close" label="关闭灵感大图" onPress={() => setSelected(null)} /></View>
        {current && <FadeImage source={current.source} resizeMode="contain" accessibilityLabel={`${current.label}灵感大图`} style={{ flex: 1, width: '100%' }} />}
        <Text style={local.viewerHint}>从这里，找一点开拍的灵感。</Text>
      </SafeAreaView>
    </Modal>
  </>;
}

const local = StyleSheet.create({
  wall: { flexDirection: 'row', gap: space.md, alignItems: 'flex-start' },
  column: { flex: 1, gap: space.xl },
  image: { overflow: 'hidden', width: '100%', borderRadius: radius.sm, backgroundColor: studio.canvas },
  caption: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  number: { ...type.badge, color: studio.subtle, letterSpacing: 1 },
  label: { ...type.caption, color: studio.muted, flex: 1 },
  viewer: { flex: 1, backgroundColor: studio.bg },
  viewerHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: space.lg },
  viewerHint: { ...type.caption, color: studio.muted, textAlign: 'center', padding: space.xl },
});
