import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState } from 'react';
import { Modal, Text, View } from 'react-native';
import { Button, Page, colors, styles } from './ui';

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
  return <Modal visible={visible} animationType="none" onRequestClose={() => undefined}><Page><View testID={`onboarding-${index + 1}`} style={{ flex: 1, padding: 32, justifyContent: 'center', gap: 30 }}><Text style={{ color: colors.red, letterSpacing: 3 }}>欢迎来到衣序 · {index + 1}/3</Text><View style={{ backgroundColor: colors.blush, borderRadius: 32, padding: 40, alignItems: 'center' }}><Ionicons name={slide.icon} size={70} color={colors.red} /></View><Text style={styles.title}>{slide.title}</Text><Text style={[styles.subtitle, { lineHeight: 26 }]}>{slide.body}</Text><View style={[styles.row, { justifyContent: 'center' }]}>{slides.map((_, n) => <View key={n} style={{ width: n === index ? 24 : 7, height: 7, borderRadius: 5, backgroundColor: n === index ? colors.red : colors.border }} />)}</View><Button title={index === 2 ? '开始创作' : '下一步'} onPress={() => { void next(); }} /></View></Page></Modal>;
}
