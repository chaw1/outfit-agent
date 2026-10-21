import { Text, View } from 'react-native';
import type { AutoState } from '../api/types';
import { autoProgress, autoSummaryLine, type AutoSummary } from '../lib/autoProgress';
import { colors, radius, space, type } from '../theme';
import { Button } from './ui';

export interface AutoProgressProps {
  auto: AutoState; active: boolean; busy: boolean; onTakeover: () => void;
  /** 跑完后的收尾账与出口；没给就只显示进度。 */
  summary?: AutoSummary; onPreview?: () => void; onStartNew?: () => void;
}

export function AutoProgress({ auto, active, busy, onTakeover, summary, onPreview, onStartNew }: AutoProgressProps) {
  const progress = autoProgress(auto);
  const finished = auto.step === 'done' && !!summary;
  return <View testID="auto-progress" style={{ padding: space.lg, gap: space.md, borderBottomWidth: 1, borderColor: colors.border, backgroundColor: colors.paper }}>
    <View accessibilityRole="progressbar" accessibilityLabel="一键出片进度" accessibilityValue={{ min: 0, max: 100, now: progress.percent }} style={{ flexDirection: 'row', gap: space.xs }}>{progress.steps.map(step => <View key={step.step} testID={`auto-step-${step.step}`} accessibilityLabel={`${step.label}，${step.completed ? '已完成' : step.current ? '当前步骤' : '未开始'}`} style={{ flex: 1, gap: space.sm }}><View style={{ height: 3, borderRadius: radius.sm, backgroundColor: step.completed || step.current ? colors.action : colors.border }} /><Text style={{ ...type.badge, textAlign: 'center', color: step.current ? colors.redText : colors.muted }}>{step.label}</Text></View>)}</View>
    {finished ? <View testID="auto-summary" style={{ gap: space.md }}>
      <View style={{ gap: space.xs }}><Text testID="auto-current-step" accessibilityLiveRegion="polite" style={{ ...type.label, color: colors.ink }}>{auto.label}</Text><Text testID="auto-summary-line" style={{ ...type.caption, color: colors.muted }}>{autoSummaryLine(summary)}。图在上方成果栏，想改哪张点开它。</Text></View>
      <View style={{ flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' }}>{onPreview && <Button title="看笔记并发布" icon="document-text-outline" testID="auto-open-preview" disabled={busy} onPress={onPreview} />}{onStartNew && <Button title="再拍一组" variant="secondary" icon="add-circle-outline" testID="auto-start-new" disabled={busy} onPress={onStartNew} />}</View>
    </View> : <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}><View style={{ flex: 1, gap: space.xs }}><Text testID="auto-current-step" accessibilityLiveRegion="polite" style={{ ...type.label, color: colors.ink }}>{auto.label}</Text><Text style={{ ...type.caption, color: colors.muted }}>{auto.step === 'done' ? '全套图文和视频都在这儿了。' : active ? '可以离开片场，出好后会提醒你。' : '接下来由你决定，已经在跑的画面会继续。'}</Text></View>{active && <Button title="我来接手" variant="secondary" testID="takeover-auto" disabled={busy} onPress={onTakeover} />}</View>}
  </View>;
}
