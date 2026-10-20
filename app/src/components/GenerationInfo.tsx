import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { NoteData, OutfitImage } from '../api/types';
import { colors } from './ui';

export function FidelityBadge({ image }: { image: OutfitImage }) {
  const score = image.fidelity?.score;
  if (typeof score !== 'number' || !Number.isFinite(score)) return null;
  return <View testID={`fidelity-${image.id}`} style={styles.badge}><Text style={styles.badgeText}>还原 {Math.round(score)}</Text></View>;
}

export function ImageRevisionInfo({ image }: { image: OutfitImage }) {
  const [expanded, setExpanded] = useState(false);
  return <View style={styles.revision}>
    {image.fidelity?.auto_fixed ? <Text testID={`auto-fixed-${image.id}`} style={styles.fixed}>已自动修一版</Text> : null}
    {image.instruction ? <Text style={styles.detail}>{image.instruction}</Text> : null}
    {image.fidelity?.diffs.length ? <Pressable accessibilityRole="button" accessibilityLabel={expanded ? '收起差异点' : '展开差异点'} accessibilityState={{ expanded }} aria-expanded={expanded} onPress={() => setExpanded(value => !value)}><Text testID={`fidelity-diffs-${image.id}`} numberOfLines={expanded ? undefined : 2} style={styles.detail}>差异点：{image.fidelity.diffs.join('；')}</Text><Text style={[styles.detail, { color: colors.red }]}>{expanded ? '收起' : '展开差异点'}</Text></Pressable> : null}
    {image.edit_check ? <Text testID={`edit-check-${image.id}`} style={[styles.detail, { color: image.edit_check.passed ? colors.green : '#AE2940' }]}>{image.edit_check.passed ? '已按要求改好' : '可能没改到位'}：{image.edit_check.reason}</Text> : null}
  </View>;
}

export function NoteDisclosure({ note, projectCost, testIDPrefix = 'note' }: { note: NoteData; projectCost?: number; testIDPrefix?: string }) {
  const cost = note.cost_cny ?? projectCost;
  return <View style={styles.disclosure}>
    {typeof cost === 'number' && Number.isFinite(cost) ? <Text testID={`${testIDPrefix}-cost`} style={styles.cost}>这篇成本约 ¥{cost.toFixed(1)}</Text> : null}
    <Text testID={`${testIDPrefix}-ai-label`} style={styles.label}>{note.ai_label || '本篇含 AI 生成内容，发布时请勾选平台的 AI 内容声明。'}</Text>
  </View>;
}

const styles = StyleSheet.create({
  badge: { position: 'absolute', top: 8, left: 8, paddingHorizontal: 7, paddingVertical: 4, borderRadius: 5, backgroundColor: '#FFFFFFED' },
  badgeText: { color: colors.green, fontSize: 10, fontWeight: '700' },
  revision: { gap: 3, marginTop: 5 },
  fixed: { color: colors.green, fontSize: 10, lineHeight: 17, fontWeight: '600' },
  detail: { color: '#897B6D', fontSize: 10, lineHeight: 17 },
  disclosure: { backgroundColor: '#FAF7F2', borderRadius: 10, padding: 12, gap: 6, marginBottom: 12 },
  cost: { color: '#77604D', fontSize: 12, fontWeight: '600' },
  label: { color: '#8E8176', fontSize: 11, lineHeight: 19 },
});
