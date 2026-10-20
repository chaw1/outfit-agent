import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { NoteData, OutfitImage } from '../api/types';
import { Ionicons } from '@expo/vector-icons';
import { colors, layout, radius, space, type as typography } from '../theme';
import { Badge } from './ui';

export function FidelityBadge({ image }: { image: OutfitImage }) {
  const score = image.fidelity?.score;
  if (typeof score !== 'number' || !Number.isFinite(score)) return null;
  return <View testID={`fidelity-${image.id}`} style={styles.badge}><Badge label={`还原 ${Math.round(score)}`} tone={score >= 60 ? 'success' : 'danger'} /></View>;
}

export function ImageRevisionInfo({ image }: { image: OutfitImage }) {
  const [expanded, setExpanded] = useState(false);
  return <View style={styles.revision}>
    {image.fidelity?.auto_fixed ? <View testID={`auto-fixed-${image.id}`} style={styles.fixed}><Badge label="已自动修一版" tone="success" /></View> : null}
    {image.instruction ? <Text style={styles.detail}>{image.instruction}</Text> : null}
    {image.fidelity?.diffs.length ? <Pressable accessibilityRole="button" accessibilityLabel={expanded ? '收起差异点' : '展开差异点'} accessibilityState={{ expanded }} aria-expanded={expanded} onPress={() => setExpanded(value => !value)} style={({ pressed }) => [styles.diffs, pressed && styles.pressed]}><Text testID={`fidelity-diffs-${image.id}`} numberOfLines={expanded ? undefined : 2} style={styles.detail}>差异点：{image.fidelity.diffs.join('；')}</Text><View style={styles.expand}><Text style={styles.expandText}>{expanded ? '收起' : '展开差异点'}</Text><Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={14} color={colors.redText} /></View></Pressable> : null}
    {image.edit_check ? <View style={styles.check}><Ionicons name={image.edit_check.passed ? 'checkmark-circle-outline' : 'alert-circle-outline'} size={15} color={image.edit_check.passed ? colors.green : colors.danger} /><Text testID={`edit-check-${image.id}`} style={[styles.detail, styles.checkText, { color: image.edit_check.passed ? colors.green : colors.danger }]}>{image.edit_check.passed ? '已按要求改好' : '可能没改到位'}：{image.edit_check.reason}</Text></View> : null}
  </View>;
}

export function NoteDisclosure({ note, projectCost, testIDPrefix = 'note' }: { note: NoteData; projectCost?: number; testIDPrefix?: string }) {
  const cost = note.cost_cny ?? projectCost;
  return <View style={styles.disclosure}>
    {typeof cost === 'number' && Number.isFinite(cost) ? <View style={styles.disclosureRow}><Ionicons name="wallet-outline" size={14} color={colors.muted} /><Text testID={`${testIDPrefix}-cost`} style={styles.cost}>这篇成本约 ¥{cost.toFixed(1)}</Text></View> : null}
    <View style={styles.disclosureRow}><Ionicons name="sparkles-outline" size={14} color={colors.muted} /><Text testID={`${testIDPrefix}-ai-label`} style={styles.label}>{note.ai_label || '本篇含 AI 生成内容，发布时请勾选平台的 AI 内容声明。'}</Text></View>
  </View>;
}

const styles = StyleSheet.create({
  badge: { position: 'absolute', top: space.sm, left: space.sm },
  revision: { gap: space.sm, marginTop: space.sm },
  fixed: { alignSelf: 'flex-start' },
  detail: { ...typography.caption, color: colors.muted },
  diffs: { minHeight: layout.touch, gap: space.xs, paddingVertical: space.xs },
  pressed: { opacity: .7 },
  expand: { flexDirection: 'row', alignItems: 'center', gap: space.xs, minHeight: 24 },
  expandText: { ...typography.caption, color: colors.redText, fontWeight: '600' },
  check: { flexDirection: 'row', alignItems: 'flex-start', gap: space.xs },
  checkText: { flex: 1 },
  disclosure: { backgroundColor: colors.paper, borderRadius: radius.sm, padding: space.md, gap: space.sm, marginBottom: space.md },
  disclosureRow: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  cost: { ...typography.caption, color: colors.muted, fontWeight: '600', flex: 1 },
  label: { ...typography.caption, color: colors.muted, flex: 1 },
});
