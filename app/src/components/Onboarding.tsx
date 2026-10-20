import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState } from 'react';
import { Modal, ScrollView, StyleSheet, Text, View } from 'react-native';
import { AnimatedEntry, Button, Page, styles } from './ui';
import { colors, radius, space, type } from '../theme';

const KEY = 'outfit.onboarding.v1';
const slides = [
  { icon: 'sparkles-outline', title: '把品牌需求，穿成你的风格', body: '上传衣服图，聊灵感、定脚本、出图和改图，最后整理成图文笔记与短视频。' },
  { icon: 'checkmark-circle-outline', title: '花钱前，由你来确认', body: '整理方向时会自动生成灵感预览并产生费用；正式批量出图和视频会单独请你确认，改图提交前也请检查。项目里可以看到累计估算费用。' },
  { icon: 'document-text-outline', title: '创作有 AI，发布有声明', body: '图片带有生成标识。准备发布时核对文案与媒体，并在目标平台勾选 AI 内容声明。' },
] as const;
export function Onboarding() {
  const [visible, setVisible] = useState(false);
  const [index, setIndex] = useState(0);
  useEffect(() => { let alive = true; void AsyncStorage.getItem(KEY).then(value => { if (alive && !value) setVisible(true); }).catch(() => { if (alive) setVisible(true); }); return () => { alive = false; }; }, []);
  const slide = slides[index];
  async function next() {
    if (index < 2) return setIndex(Math.min(2, index + 1));
    try { await AsyncStorage.setItem(KEY, 'done'); } catch { /* 本机存储不可用时仍允许开始创作。 */ } finally { setVisible(false); }
  }
  return <Modal visible={visible} animationType="fade" onRequestClose={() => undefined}>
    <Page>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={localStyles.scroll}>
        <AnimatedEntry key={index} style={localStyles.slide}>
          <View testID={`onboarding-${index + 1}`} style={localStyles.slide}>
            <View style={localStyles.heading}><Text style={localStyles.eyebrow}>欢迎来到衣序</Text><Text style={localStyles.counter}>0{index + 1} / 03</Text></View>
            <View style={localStyles.illustration}>
              <View style={localStyles.illustrationInset}><Ionicons name={slide.icon} size={64} color={colors.redText} /></View>
              <View style={localStyles.sparkle}><Ionicons name="sparkles" size={18} color={colors.redText} /></View>
            </View>
            <Text style={styles.title}>{slide.title}</Text>
            <Text style={[styles.subtitle, localStyles.body]}>{slide.body}</Text>
          </View>
        </AnimatedEntry>
      </ScrollView>
      <View style={localStyles.footer}>
        <View accessibilityLabel={`引导第 ${index + 1} 页，共 3 页`} style={localStyles.dots}>{slides.map((_, n) => <View key={n} style={[localStyles.dot, n === index && localStyles.dotActive]} />)}</View>
        <Button title={index === 2 ? '开始创作' : '下一步'} onPress={() => { void next(); }} />
      </View>
    </Page>
  </Modal>;
}

const localStyles = StyleSheet.create({
  scroll: { flexGrow: 1, padding: space.xxl, justifyContent: 'center' },
  slide: { gap: space.xl },
  heading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md },
  eyebrow: { ...type.caption, color: colors.redText, fontWeight: '600', letterSpacing: 2 },
  counter: { ...type.badge, color: colors.muted, letterSpacing: 1 },
  illustration: { height: 184, backgroundColor: colors.blush, borderRadius: radius.lg, justifyContent: 'center', alignItems: 'center', marginVertical: space.sm },
  illustrationInset: { width: 112, height: 112, borderRadius: radius.lg, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface, transform: [{ rotate: '-7deg' }] },
  sparkle: { position: 'absolute', top: space.xl, right: space.xl },
  body: { ...type.reading, color: colors.muted },
  footer: { paddingHorizontal: space.xxl, paddingBottom: space.xl, paddingTop: space.sm, gap: space.xl, backgroundColor: colors.surface },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: space.sm },
  dot: { width: space.sm, height: space.sm, borderRadius: radius.sm, backgroundColor: colors.border },
  dotActive: { width: space.xl, backgroundColor: colors.red },
});
