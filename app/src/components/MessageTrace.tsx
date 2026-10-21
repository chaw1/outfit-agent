import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { Message } from '../api/types';
import { previewUrl } from '../lib/previewUrl';
import { seconds, traceSummary } from '../lib/transparency';
import { colors, layout, radius, space, type as typography } from '../theme';
import { FadeImage } from './ui';

export function MessageTrace({ message }: { message: Message }) {
  const [expanded, setExpanded] = useState(false);
  const trace = message.trace;
  if (message.role !== 'assistant' || !trace) return null;
  return <View style={styles.container}>
    <Pressable testID={`trace-${message.id}`} accessibilityRole="button" accessibilityLabel={`${traceSummary(trace)}，${expanded ? '收起' : '展开'}处理分步`} accessibilityState={{ expanded }} aria-expanded={expanded} onPress={() => setExpanded(value => !value)} style={({ pressed }) => [styles.summary, pressed && styles.pressed]}>
      <Text style={styles.caption}>{traceSummary(trace)}</Text><Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={13} color={colors.muted} />
    </Pressable>
    {expanded ? <View testID={`trace-steps-${message.id}`} style={styles.steps}>
      <Text style={styles.caption}>模型 · {trace.model}</Text>
      {trace.reference_images?.length ? <ScrollView horizontal showsHorizontalScrollIndicator={false} testID={`trace-references-${message.id}`} contentContainerStyle={styles.references}>
        {trace.reference_images.map(reference => <View key={reference.id} style={styles.reference}>
          <FadeImage source={{ uri: previewUrl(reference.url, 360) }} style={styles.thumbnail} accessibilityLabel={`${reference.role}参考缩略图`} />
          <Text style={styles.caption}>{reference.role}</Text>
        </View>)}
      </ScrollView> : null}
      {trace.steps.map((step, index) => <View key={`${index}-${step.label}`} style={styles.step}><Text style={[styles.caption, styles.label]}>{step.label}</Text><Text style={styles.caption}>{seconds(step.duration_ms)}</Text></View>)}
      {trace.reference_images?.length || trace.refs.length ? <Text style={styles.caption}>参考了 {trace.reference_images?.length || trace.refs.length} 张图片</Text> : null}
      {!trace.steps.length ? <Text style={styles.caption}>本轮没有额外分步</Text> : null}
    </View> : null}
  </View>;
}

const styles = StyleSheet.create({
  container: { maxWidth: '100%', alignSelf: 'stretch' },
  summary: { minHeight: layout.touch, minWidth: layout.touch, flexDirection: 'row', alignItems: 'center', gap: space.xs, alignSelf: 'flex-start', paddingHorizontal: space.xs },
  caption: { ...typography.badge, color: colors.muted, flexShrink: 1 },
  pressed: { opacity: 0.7 },
  steps: { gap: space.sm, padding: space.md, backgroundColor: colors.paper, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm },
  references: { gap: space.sm },
  reference: { width: 56, gap: space.xs, alignItems: 'center' },
  thumbnail: { width: 56, height: 72, borderRadius: radius.sm, backgroundColor: colors.imagePlaceholder },
  step: { flexDirection: 'row', justifyContent: 'space-between', gap: space.md },
  label: { flex: 1 },
});
