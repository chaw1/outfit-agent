import { useState } from 'react';
import { Keyboard, StyleSheet, Text, View } from 'react-native';
import type { ScriptData } from '../api/types';
import { colors, space, radius, type as typography } from '../theme';
import { Badge, Button, Sheet } from './ui';

export function ScriptViewer({ script, version }: { script: ScriptData; version?: number }) {
  const [open, setOpen] = useState(false);
  const confirmed = script.status === 'confirmed';
  const title = confirmed ? '已确认脚本' : '当前脚本';
  return <>
    <View style={styles.entry}>
      <Button title={`查看${title}`} icon="reader-outline" variant="secondary" testID="view-script" onPress={() => { Keyboard.dismiss(); setOpen(true); }} />
    </View>
    <Sheet label={title} visible={open} onClose={() => setOpen(false)} testID="script-viewer" closeLabel="关闭脚本" closeTestID="close-script">
      <View style={styles.meta}><Badge label={confirmed ? '已确认' : '草稿'} tone={confirmed ? 'success' : 'neutral'} /><Text style={styles.muted}>{version ? `第 ${version} 版 · ` : ''}{script.shots.length} 个镜头</Text></View>
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>标题灵感</Text>
        {script.title_ideas.map((idea, index) => <Text selectable key={`${index}-${idea}`} style={styles.body}><Text style={styles.number}>{String(index + 1).padStart(2, '0')}  </Text>{idea}</Text>)}
      </View>
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>封面计划</Text>
        <Text selectable style={styles.body}>{script.cover.scene} · {script.cover.pose}</Text>
        {script.cover.text_overlay ? <Text selectable style={styles.muted}>封面字：{script.cover.text_overlay}</Text> : null}
      </View>
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>分镜与画面</Text>
        {script.shots.map((shot, index) => <View key={shot.id} testID={`script-viewer-shot-${shot.id}`} style={styles.shot}>
          <Text style={styles.number}>{String(index + 1).padStart(2, '0')}</Text>
          <View style={styles.shotContent}>
            <Text selectable style={styles.body}>{shot.scene}</Text>
            <Text selectable style={styles.muted}>{shot.pose} · {shot.camera}</Text>
            {shot.styling ? <Text selectable style={styles.styling}>搭配：{shot.styling}</Text> : null}
            <Text selectable style={styles.muted}>{shot.caption}</Text>
          </View>
        </View>)}
      </View>
      {script.video?.prompt ? <View style={styles.section}><Text style={styles.sectionLabel}>{script.video.duration} 秒短片灵感</Text><Text selectable style={styles.muted}>{script.video.prompt}</Text></View> : null}
    </Sheet>
  </>;
}

const styles = StyleSheet.create({
  entry: { paddingHorizontal: space.lg, paddingVertical: space.sm, borderBottomWidth: 1, borderBottomColor: colors.border },
  meta: { flexDirection: 'row', gap: space.sm, alignItems: 'center', flexWrap: 'wrap' },
  section: { gap: space.sm },
  sectionLabel: { ...typography.label, color: colors.ink },
  body: { ...typography.body, color: colors.ink },
  muted: { ...typography.caption, color: colors.muted },
  styling: { ...typography.caption, color: colors.redText },
  number: { ...typography.caption, color: colors.redText, fontWeight: '700', minWidth: space.xl },
  shot: { flexDirection: 'row', gap: space.sm, padding: space.md, borderRadius: radius.md, backgroundColor: colors.paper, borderWidth: 1, borderColor: colors.border },
  shotContent: { flex: 1, gap: space.xs },
});
