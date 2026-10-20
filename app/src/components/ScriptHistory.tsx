import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { Action, ScriptVersion } from '../api/types';
import { Button, colors } from './ui';

export function ScriptHistory({ versions = [], busy, generating, onAction }: {
  versions?: ScriptVersion[];
  busy?: boolean;
  generating?: boolean;
  onAction: (action: Action) => void;
}) {
  const [open, setOpen] = useState(false);
  return <>
    <Pressable accessibilityRole="button" accessibilityLabel="历史版本" testID="script-history" onPress={() => setOpen(true)} style={styles.entry}>
      <Text style={styles.entryText}>历史版本{versions.length ? ` · ${versions.length}` : ''} ↗</Text>
    </Pressable>
    <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
      <View style={styles.shade}><View style={styles.modal}>
        <View style={styles.heading}><Text style={styles.title}>脚本历史版本</Text><Pressable accessibilityRole="button" accessibilityLabel="关闭历史版本" onPress={() => setOpen(false)} hitSlop={12}><Text style={styles.close}>关闭</Text></Pressable></View>
        <Text style={styles.hint}>恢复后回到脚本确认，已有图片仍保留。</Text>
        {generating ? <Text style={styles.hint}>图片或短片还在生成，完成后即可恢复。</Text> : null}
        <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
          {versions.length ? [...versions].sort((a, b) => b.version - a.version).map(version => <View key={version.checkpoint_id} style={styles.version} testID={`script-version-${version.version}`}>
            <View style={styles.heading}><Text style={styles.versionTitle}>第 {version.version} 版{version.current ? ' · 当前版本' : ''}</Text><Text style={styles.time}>{new Date(version.created_at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</Text></View>
            <Text style={styles.summary}>{version.summary}</Text>
            <Button title={version.current ? '正在使用' : `恢复第 ${version.version} 版`} variant="secondary" disabled={busy || generating || version.current} testID={`restore-script-${version.version}`} onPress={() => { onAction({ type: 'restore_script', checkpoint_id: version.checkpoint_id }); setOpen(false); }} />
          </View>) : <Text style={styles.hint}>还没有可恢复的脚本，写好第一版后会保存在这里。</Text>}
        </ScrollView>
      </View></View>
    </Modal>
  </>;
}

const styles = StyleSheet.create({
  entry: { alignSelf: 'flex-end', paddingVertical: 8, paddingHorizontal: 3, marginBottom: 8 },
  entryText: { color: colors.red, fontSize: 12, fontWeight: '600' },
  shade: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#241C1959', padding: 24 },
  modal: { width: '100%', maxWidth: 430, maxHeight: '85%', backgroundColor: '#FFFFFF', borderRadius: 20, padding: 20 },
  heading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  title: { color: colors.ink, fontSize: 18, fontWeight: '700' },
  close: { color: colors.muted, fontSize: 12, paddingVertical: 8 },
  hint: { color: colors.muted, fontSize: 12, lineHeight: 21, marginVertical: 8 },
  list: { flexShrink: 1 },
  listContent: { gap: 12, paddingTop: 8 },
  version: { backgroundColor: '#FCFAF7', borderColor: colors.border, borderWidth: 1, padding: 14, borderRadius: 13, gap: 12 },
  versionTitle: { color: colors.ink, fontSize: 12, fontWeight: '600' },
  time: { color: colors.muted, fontSize: 10 },
  summary: { color: '#776B60', fontSize: 12, lineHeight: 21 },
});
