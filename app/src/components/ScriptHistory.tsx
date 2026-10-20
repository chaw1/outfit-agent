import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { SlideInDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Action, ScriptVersion } from '../api/types';
import { colors, space, radius, motion, type as typography } from '../theme';
import { AnimatedEntry, Badge, Button, StatePanel } from './ui';

export function ScriptHistory({ versions = [], busy, generating, onAction }: {
  versions?: ScriptVersion[];
  busy?: boolean;
  generating?: boolean;
  onAction: (action: Action) => void;
}) {
  const [open, setOpen] = useState(false);
  const insets = useSafeAreaInsets();
  return <>
    <Pressable accessibilityRole="button" accessibilityLabel="历史版本" testID="script-history" onPress={() => setOpen(true)} style={({ pressed }) => [styles.entry, pressed && styles.pressed]}>
      <Ionicons name="layers-outline" size={16} color={colors.redText} />
      <Text style={styles.entryText}>历史版本{versions.length ? ` · ${versions.length}` : ''} ↗</Text>
    </Pressable>
    <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
      <View style={styles.shade}>
        <Pressable style={StyleSheet.absoluteFill} accessibilityRole="button" accessibilityLabel="关闭历史版本遮罩" onPress={() => setOpen(false)} />
        <Animated.View entering={SlideInDown.duration(motion.normal)} style={[styles.modal, { paddingBottom: space.xl + insets.bottom }]} accessibilityViewIsModal>
          <View style={styles.handle} />
          <View style={styles.heading}>
            <Text style={styles.title}>脚本历史版本</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="关闭历史版本" onPress={() => setOpen(false)} style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}><Ionicons name="close" size={21} color={colors.muted} /></Pressable>
          </View>
          <Text style={styles.hint}>恢复后回到脚本确认，已有图片仍保留。</Text>
          {generating ? <View style={styles.generating}><Ionicons name="time-outline" size={16} color={colors.redText} /><Text style={styles.generatingText}>图片或短片还在生成，完成后即可恢复。</Text></View> : null}
          <ScrollView style={styles.list} contentContainerStyle={styles.listContent} showsVerticalScrollIndicator={false}>
            {versions.length ? [...versions].sort((a, b) => b.version - a.version).map((version, index) => <AnimatedEntry key={version.checkpoint_id} delay={index * 40}>
              <View style={[styles.version, version.current && styles.current]} testID={`script-version-${version.version}`}>
                <View style={styles.heading}><Text style={styles.versionTitle}>第 {version.version} 版{version.current ? ' · 当前版本' : ''}</Text>{version.current ? <Badge label="使用中" tone="success" /> : null}</View>
                <Text style={styles.time}>{new Date(version.created_at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</Text>
                <Text style={styles.summary}>{version.summary}</Text>
                <Button title={version.current ? '正在使用' : `恢复第 ${version.version} 版`} variant="secondary" disabled={busy || generating || version.current} testID={`restore-script-${version.version}`} onPress={() => { onAction({ type: 'restore_script', checkpoint_id: version.checkpoint_id }); setOpen(false); }} />
              </View>
            </AnimatedEntry>) : <StatePanel icon="reader-outline" title="第一版灵感，即将留下" description="还没有可恢复的脚本，写好第一版后会保存在这里。" actionLabel="继续创作" onAction={() => setOpen(false)} />}
          </ScrollView>
        </Animated.View>
      </View>
    </Modal>
  </>;
}

const styles = StyleSheet.create({
  entry: { alignSelf: 'flex-end', minHeight: 44, paddingHorizontal: space.sm, flexDirection: 'row', gap: space.sm, alignItems: 'center', marginBottom: space.sm },
  entryText: { ...typography.caption, color: colors.redText, fontWeight: '600' },
  pressed: { opacity: 0.75, transform: [{ scale: 0.98 }] },
  shade: { flex: 1, justifyContent: 'flex-end', alignItems: 'center', backgroundColor: colors.overlay },
  modal: { width: '100%', maxWidth: 520, maxHeight: '85%', backgroundColor: colors.white, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, padding: space.xl },
  handle: { alignSelf: 'center', width: 36, height: 4, borderRadius: radius.sm, backgroundColor: colors.border, marginBottom: space.md },
  heading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.sm, flexWrap: 'wrap' },
  title: { ...typography.heading, color: colors.ink, fontWeight: '700', flex: 1 },
  closeButton: { minWidth: 44, minHeight: 44, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.paper },
  hint: { ...typography.caption, color: colors.muted, marginVertical: space.sm },
  generating: { padding: space.md, flexDirection: 'row', alignItems: 'center', gap: space.sm, backgroundColor: colors.blush, borderRadius: radius.sm },
  generatingText: { ...typography.caption, color: colors.redText, flex: 1 },
  list: { flexShrink: 1 },
  listContent: { gap: space.md, paddingTop: space.lg },
  version: { backgroundColor: colors.paper, borderColor: colors.border, borderWidth: 1, padding: space.lg, borderRadius: radius.md, gap: space.sm },
  current: { borderColor: colors.green },
  versionTitle: { ...typography.body, color: colors.ink, fontWeight: '600' },
  time: { ...typography.badge, color: colors.muted },
  summary: { ...typography.body, color: colors.muted, marginBottom: space.sm },
});
