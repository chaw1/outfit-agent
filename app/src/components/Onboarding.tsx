import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState } from 'react';
import { Modal, ScrollView, StyleSheet, Text, View } from 'react-native';
import { AnimatedEntry, Button, Page } from './ui';
import { radius, space, studio, type } from '../theme';

const KEY = 'outfit.onboarding.v1';
const slides = [
  { icon: 'sparkles-outline', title: '一件衣服，一组大片', body: '带上一件喜欢的衣服，从穿搭图、图文笔记到短视频，把灵感拍成你的表达。' },
  { icon: 'film-outline', title: '一键出片，或者一步步来', body: '一键出片，全套图文和视频一次出好，中途可以接手。沉浸编导，聊灵感、定脚本、挑图改图，每一步你说了算。' },
  { icon: 'checkmark-circle-outline', title: '正式出图和视频会扣点，由你确认', body: '开拍前会显示预估点数。一键出片由你在开拍时确认，沉浸编导会在每次正式生成前请你确认。图片带有生成标识，发布时记得勾选内容声明。' },
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
    <Page tone="studio">
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={localStyles.scroll}>
        <AnimatedEntry key={index} style={localStyles.slide}>
          <View testID={`onboarding-${index + 1}`} style={localStyles.slide}>
            <View style={localStyles.heading}><Text style={localStyles.eyebrow}>欢迎来到衣序</Text><Text style={localStyles.counter}>0{index + 1} / 03</Text></View>
            <View style={localStyles.illustration}>
              <View style={localStyles.illustrationInset}><Ionicons name={slide.icon} size={64} color={studio.ink} /></View>
              <View style={localStyles.sparkle}><Ionicons name="sparkles" size={18} color={studio.accent} /></View>
            </View>
            <Text style={{ ...type.display, color: studio.ink }}>{slide.title}</Text>
            <Text style={localStyles.body}>{slide.body}</Text>
          </View>
        </AnimatedEntry>
      </ScrollView>
      <View style={localStyles.footer}>
        <View accessibilityLabel={`引导第 ${index + 1} 页，共 3 页`} style={localStyles.dots}>{slides.map((_, n) => <View key={n} style={[localStyles.dot, n === index && localStyles.dotActive]} />)}</View>
        <Button title={index === 2 ? '进入片场' : '下一步'} onPress={() => { void next(); }} />
      </View>
    </Page>
  </Modal>;
}

const localStyles = StyleSheet.create({
  scroll: { flexGrow: 1, padding: space.xxl, justifyContent: 'center' },
  slide: { gap: space.xl },
  heading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md },
  eyebrow: { ...type.caption, color: studio.muted, fontWeight: '500', letterSpacing: 2 },
  counter: { ...type.badge, color: studio.muted, letterSpacing: 1 },
  illustration: { height: 184, backgroundColor: studio.glass, borderWidth: 1, borderColor: studio.line, borderRadius: radius.lg, justifyContent: 'center', alignItems: 'center', marginVertical: space.sm },
  illustrationInset: { width: 112, height: 112, borderRadius: radius.lg, borderWidth: 1, borderColor: studio.line, alignItems: 'center', justifyContent: 'center', backgroundColor: studio.canvas, transform: [{ rotate: '-7deg' }] },
  sparkle: { position: 'absolute', top: space.xl, right: space.xl },
  body: { ...type.reading, color: studio.muted },
  footer: { paddingHorizontal: space.xxl, paddingBottom: space.xl, paddingTop: space.sm, gap: space.xl, backgroundColor: studio.bg },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: space.sm },
  dot: { width: space.sm, height: space.sm, borderRadius: radius.sm, backgroundColor: studio.line },
  dotActive: { width: space.xl, backgroundColor: studio.accent },
});
