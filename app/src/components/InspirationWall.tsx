import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { radius, space, studio, type } from '../theme';
import { Button, FadeImage, IconButton } from './ui';

// 灵感墙：十种风格各一张，人、衣服、场景、光线都不同，按明暗交错排两列。
// 图片由出图模型按同一套摄影脚本生成，成片统一盖一次 AI 标识。
const inspiration = [
  { source: require('../../assets/inspiration/studio-01.jpg'), label: '松弛通勤', en: 'SOFT OFFICE', note: '灰西装外套 × 白 T × 白乐福鞋，清晨街道的阴天柔光' },
  { source: require('../../assets/inspiration/studio-02.jpg'), label: '老钱极简', en: 'QUIET LUXURY', note: '羊绒衫披肩 × 真丝衬衫 × 驼色阔腿裤，码头傍晚逆光' },
  { source: require('../../assets/inspiration/studio-03.jpg'), label: '法式慵懒', en: 'PARISIENNE', note: '条纹船领 × 黑色 A 字半裙 × 芭蕾鞋，阳台晨光' },
  { source: require('../../assets/inspiration/studio-04.jpg'), label: '街头胶片', en: 'STREET FILM', note: '皮夹克叠连帽衫 × 宽松牛仔，便利店门口直闪' },
  { source: require('../../assets/inspiration/studio-05.jpg'), label: '杂志大片', en: 'EDITORIAL', note: '结构感西装裙 × 尖头高跟，影棚单灯硬光' },
  { source: require('../../assets/inspiration/studio-06.jpg'), label: '闪光灯夜拍', en: 'FLASH NIGHT', note: '亮片吊带 × 皮裤，深夜街角机顶闪光' },
  { source: require('../../assets/inspiration/studio-07.jpg'), label: '复古港风', en: 'HONG KONG RETRO', note: '红缎吊带裙 × 黑色小西装 × 珍珠耳环，旧街霓虹' },
  { source: require('../../assets/inspiration/studio-08.jpg'), label: '户外野餐', en: 'PICNIC', note: '碎花棉裙 × 草帽 × 编织凉鞋，树影斑驳的草地' },
  { source: require('../../assets/inspiration/studio-09.jpg'), label: '美术馆漫步', en: 'GALLERY', note: '炭灰宽肩套装 × 黑高领 × 白球鞋，白盒子展厅' },
  { source: require('../../assets/inspiration/studio-10.jpg'), label: '雨天风衣', tag: '雨天街角', en: 'RAINY TRENCH', note: '驼色长风衣 × 深蓝牛仔 × 切尔西靴，雨后傍晚的斑马线' },
] as const;

// 两列各五张，高矮交错，让墙面有节奏而不是网格。
const ratios = [0.72, 0.8, 0.76, 0.68, 0.8, 0.72, 0.76, 0.8, 0.68, 0.76] as const;

export function InspirationWall() {
  const [selected, setSelected] = useState<number | null>(null);
  const current = selected === null ? null : inspiration[selected];
  // 全屏 Modal 里顶部安全区按主树的 insets 手动留，否则真机上关闭按钮会压在状态栏下点不到。
  const insets = useSafeAreaInsets();
  const router = useRouter();
  // 从这张图的风格直接开拍：新建页会勾上对应风格标签，并把氛围描述填进「这次想拍什么」。
  function start() {
    if (!current) return;
    const tag = 'tag' in current ? current.tag : current.label;
    setSelected(null);
    router.push({ pathname: '/projects/new', params: { style: tag, brief: `想拍「${current.label}」这种感觉：${current.note}。` } });
  }
  return <>
    <View testID="inspiration-wall" style={local.wall}>
      {[0, 1].map(column => <View key={column} style={[local.column, column === 1 && local.columnOffset]}>
        {inspiration.map((item, index) => index % 2 === column ? <Pressable key={index} testID={`inspiration-${String(index + 1).padStart(2, '0')}`} accessibilityRole="button" accessibilityLabel={`查看灵感 ${index + 1} · ${item.label}`} onPress={() => setSelected(index)} style={({ pressed }) => ({ opacity: pressed ? 0.8 : 1, gap: space.sm })}>
          <View style={[local.image, { aspectRatio: ratios[index] }]}><FadeImage source={item.source} resizeMode="cover" accessibilityLabel={`${item.label}穿搭成片`} style={{ width: '100%', height: '100%' }} /></View>
          <View style={local.caption}>
            <View style={local.captionRow}><Text style={local.number}>{String(index + 1).padStart(2, '0')}</Text><Text numberOfLines={1} style={local.label}>{item.label}</Text></View>
            <Text numberOfLines={1} style={local.en}>{item.en}</Text>
          </View>
        </Pressable> : null)}
      </View>)}
    </View>
    <Modal visible={current !== null} animationType="slide" presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : 'fullScreen'} onRequestClose={() => setSelected(null)} onDismiss={() => setSelected(null)}>
      <SafeAreaView testID="inspiration-viewer" edges={['bottom']} style={[local.viewer, { paddingTop: Platform.OS === 'ios' ? space.sm : insets.top }]}>
        <View style={local.viewerHeader}>
          <View style={{ flex: 1, gap: space.xs }}><Text style={local.viewerEn}>{current?.en}</Text><Text style={{ ...type.subtitle, color: studio.ink }}>{current?.label}</Text></View>
          <IconButton name="close" label="关闭灵感大图" onPress={() => setSelected(null)} />
        </View>
        {current && <Pressable accessibilityRole="button" accessibilityLabel="轻点关闭灵感大图" onPress={() => setSelected(null)} style={{ flex: 1 }}><FadeImage source={current.source} resizeMode="contain" accessibilityLabel={`${current.label}灵感大图`} style={{ flex: 1, width: '100%' }} /></Pressable>}
        <View style={local.viewerFooter}>
          <Text style={local.viewerNote}>{current?.note}</Text>
          <Button title="按这个风格拍一组" icon="sparkles-outline" testID="inspiration-start" onPress={start} />
          <Text style={local.viewerHint}>轻点图片或向下滑动关闭。</Text>
        </View>
      </SafeAreaView>
    </Modal>
  </>;
}

const local = StyleSheet.create({
  wall: { flexDirection: 'row', gap: space.md, alignItems: 'flex-start' },
  column: { flex: 1, gap: space.xl },
  columnOffset: { paddingTop: space.xl },
  image: { overflow: 'hidden', width: '100%', borderRadius: radius.sm, backgroundColor: studio.canvas },
  caption: { gap: space.xs },
  captionRow: { flexDirection: 'row', alignItems: 'baseline', gap: space.sm },
  number: { ...type.badge, color: studio.subtle, letterSpacing: 1 },
  label: { ...type.label, color: studio.ink, flex: 1 },
  en: { ...type.badge, color: studio.subtle, letterSpacing: 2 },
  viewer: { flex: 1, backgroundColor: studio.bg },
  viewerHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: space.lg, gap: space.md },
  viewerEn: { ...type.badge, color: studio.subtle, letterSpacing: 2 },
  viewerFooter: { padding: space.xl, gap: space.sm },
  viewerNote: { ...type.body, color: studio.ink, textAlign: 'center' },
  viewerHint: { ...type.caption, color: studio.muted, textAlign: 'center' },
});
