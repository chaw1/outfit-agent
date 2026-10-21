import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import * as Clipboard from 'expo-clipboard';
import { ActivityIndicator, Keyboard, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import Animated, { SlideInDown, cancelAnimation, useAnimatedStyle, useSharedValue, useReducedMotion, withRepeat, withSequence, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AutoProgress } from '../../components/AutoProgress';
import { formatPoints, pointsValue } from '../../lib/transparency';
import { Cards } from '../../components/Cards';
import { ScriptHistory } from '../../components/ScriptHistory';
import { ScriptViewer } from '../../components/ScriptViewer';
import { AnimatedEntry, Header, IconButton, LoadingSkeleton, Notice, Page, ProgressStrip, StatePanel, Toast, stageNames } from '../../components/ui';
import { colors, space, radius, motion, layout, type as typography } from '../../theme';
import { useWorkspace } from '../../hooks/useWorkspace';
import type { Action, Message, OutfitImage, ProjectState } from '../../api/types';
import { ImageInteractions, useImageInteractions } from '../../components/ImageInteractions';
import { feedback } from '../../lib/haptics';
import { canRephrase } from '../../lib/conversation';
import { quickPrompts } from '../../lib/quickPrompts';
import { Chip } from '../../components/ds';
import { useSession } from '../../context/Session';
import { MessageTrace } from '../../components/MessageTrace';

function ReferenceThumbnail({ image, testID }: { image: OutfitImage; testID: string }) {
  const interaction = useImageInteractions();
  const opacity = useSharedValue(0);
  const imageStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={`查看引用图片 v${image.version}`} onPress={() => interaction.open(image.id)} onLongPress={() => interaction.menu(image.id)} style={({ pressed }) => [styles.reference, pressed && styles.pressed]}><Animated.Image source={{ uri: image.url }} style={[styles.referenceImage, imageStyle]} onLoad={() => { opacity.set(withTiming(1, { duration: motion.normal })); }} /></Pressable>;
}

function StageStep({ stage, index, active, completed }: { stage: string; index: number; active: boolean; completed: boolean }) {
  const pulse = useSharedValue(1);
  const reducedMotion = useReducedMotion();
  useEffect(() => {
    pulse.set(active && !reducedMotion ? withRepeat(withSequence(withTiming(0.55, { duration: motion.pulse }), withTiming(1, { duration: motion.pulse })), -1) : withTiming(1, { duration: motion.fast }));
    return () => cancelAnimation(pulse);
  }, [active, pulse, reducedMotion]);
  const animatedStyle = useAnimatedStyle(() => ({ opacity: pulse.value }));
  return <View style={styles.step} accessibilityLabel={`第 ${index + 1} 步，${stageNames[stage]}，${active ? '当前阶段' : completed ? '已完成' : '未开始'}`}>
    <Animated.View style={[styles.stepTrack, (active || completed) && styles.stepTrackActive, animatedStyle]} />
    <View style={styles.stepLabelRow}><Text style={[styles.stepNumber, active && styles.activeText]}>{completed && !active ? '✓' : String(index + 1).padStart(2, '0')}</Text><Text style={[styles.stepLabel, active && styles.activeText]}>{stageNames[stage]}</Text></View>
  </View>;
}

// 等回复的那几秒给一句具体的话，让人知道它在干什么，而不是一个空气泡。
function thinkingLabel(state?: ProjectState): string {
  switch (state?.pending_action?.type) {
    case 'choose_direction': return '正在按这个方向写脚本…';
    case 'confirm_script': return '正在改脚本…';
    default: break;
  }
  switch (state?.stage) {
    case 'brief':
    case 'direction': return '正在看衣服、想方向…';
    case 'script': return '正在写脚本…';
    case 'note': return '正在写笔记…';
    default: return '正在想，马上回你…';
  }
}

function messageText(message: Message, state?: ProjectState) {
  if (message.text) return message.text;
  const action = message.action;
  if (!action) return '';
  switch (action.type) {
    case 'choose_direction': return `就选「${state?.directions.find(item => item.id === action.direction_id)?.name || '这个方向'}」。`;
    case 'confirm_script': return '脚本确认，开始出图吧。';
    case 'edit_image': return `帮我改一版：${action.instruction}`;
    case 'approve_images': return `这 ${action.image_ids.length} 张选好了，按这个顺序写笔记。`;
    case 'confirm_video': return '确认，用这张图生成短视频。';
    case 'restore_script': return '恢复到这版脚本。';
    case 'regenerate_reply': return '换个说法。';
  }
}


export default function Workspace() {
  const params = useLocalSearchParams<{ id: string; refImage?: string }>();
  const { api, token } = useSession();
  return <WorkspacePage key={`${api.baseUrl}|${token}|${params.id}`} id={params.id || ''} refImage={params.refImage} />;
}

function WorkspacePage({ id, refImage }: { id: string; refImage?: string }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { project, state, messages, cards, loading, busy, error, send, retry, failedMessages, retryMessage, missing, takeOver } = useWorkspace(id);
  const [text, setText] = useState('');
  const [selectedMessage, setSelectedMessage] = useState<Message>();
  const [copyStatus, setCopyStatus] = useState('');
  const [notice, setNotice] = useState<{ text: string; tone: 'info' | 'success' }>();
  const [refs, setRefs] = useState<string[]>([]);
  const overlay = useRef(false);
  const keyboardOpen = useRef(false);
  const input = useRef<React.ComponentRef<typeof TextInput>>(null);
  const scroll = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const previousCount = useRef(0);
  const atBottom = useRef(true);
  const overlayChanged = useCallback((visible: boolean) => { overlay.current = visible; }, []);
  const addReference = useCallback((image: OutfitImage) => setRefs(previous => [...new Set([...previous, image.id])]), []);
  useFocusEffect(useCallback(() => {
    if (refImage) {
      setRefs(previous => [...new Set([...previous, refImage])]);
      router.setParams({ refImage: undefined });
    }
  }, [refImage, router]));
  useEffect(() => {
    const show = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', () => {
      keyboardOpen.current = true;
      if (!overlay.current) scroll.current?.scrollToEnd({ animated: true });
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => { keyboardOpen.current = false; });
    return () => { show.remove(); hide.remove(); };
  }, []);
  const preview = () => router.push({ pathname: '/preview/[id]', params: { id } });
  function submit() {
    if (!text.trim() || busy) return;
    const value = text.trim(); feedback(); setText(''); setRefs([]);
    void send({ text: value, ...(refs.length ? { refs } : {}) });
  }
  function act(action: Action) {
    if (action.type !== 'choose_direction') { void send({ action }); return; }
    const name = state?.directions.find(item => item.id === action.direction_id)?.name ?? '这个方向';
    setNotice({ text: `正在确认「${name}」，为你准备脚本…`, tone: 'info' });
    void send({ action }).then(result => setNotice(result && result.accepted ? { text: `已选「${name}」，脚本已准备好。`, tone: 'success' } : undefined));
  }
  const automatic = (state?.mode ?? project?.mode) === 'auto';
  const prompts = quickPrompts(state);
  const projectPoints = pointsValue(state?.cost_points, state?.cost_cny);
  const stageOrder = ['direction', 'script', 'images', 'note'];
  const finished = ['video', 'done'].includes(state?.stage || '');
  const activeIndex = finished ? stageOrder.length - 1 : state ? stageOrder.indexOf(state.stage) : -1;
  const visibleCards = cards.filter(card => {
    if (card.type === 'references') return true;
    if (!state) return true;
    if (state.stage === 'direction' || state.stage === 'brief') return card.type === 'garments' || card.type === 'directions';
    if (state.stage === 'script') return card.type === 'script';
    if (state.stage === 'images') return card.type === 'images';
    if (state.stage === 'note') return card.type === 'note';
    if (state.stage === 'video' || state.stage === 'done') return card.type === 'video' || card.type === 'note';
    return true;
  });
  if (missing) return <Page><Header title="项目已不可用" onBack={() => router.replace('/')} /><View style={styles.empty}><StatePanel icon="folder-open-outline" title="这组片已不在这里" description="项目已删除或不存在，返回列表继续创作。" actionLabel="返回项目列表" onAction={() => router.replace('/')} /></View></Page>;
  // 短片阶段以后，笔记和短片是成果而不是待办：放到对话上方当成果栏，底部留给聊天，新消息不会被卡片顶住。
  const resultsFirst = Boolean(state && ['video', 'done'].includes(state.stage));
  const cardsNode = <Cards cards={visibleCards} state={state} busy={busy} onAction={act} onText={value => { void send({ text: value }); }} onPreview={preview} onDraft={value => { setText(value); setTimeout(() => input.current?.focus(), 50); }} />;
  return <ImageInteractions images={state?.images ?? []} editActions={messages.flatMap(message => message.action?.type === 'edit_image' ? [message.action] : [])} busy={busy} stage={state?.stage} note={state?.note} pendingAction={state?.pending_action} canEdit={!automatic && ['images', 'note'].includes(state?.stage ?? '')} onAction={action => send({ action })} onReference={addReference} onVisibilityChange={overlayChanged}><Page>
    <Header title={project?.title || '编导间'} subtitle={project?.brand || '把灵感，一起聊出来'} onBack={() => router.replace('/')} right={state?.note ? <IconButton name="document-text-outline" label="笔记预览" onPress={preview} /> : <IconButton name="refresh-outline" label="刷新项目" onPress={retry} />} />
    {state?.auto && automatic ? <AutoProgress auto={state.auto} active={state.auto.active} busy={busy} onTakeover={() => { void takeOver(); }} /> : <View style={styles.steps}>{stageOrder.map((stage, index) => <StageStep key={stage} stage={stage} index={index} active={index === activeIndex} completed={index < activeIndex || finished} />)}</View>}
    {state?.script && state.stage !== 'script' ? <ScriptViewer script={state.script} version={state.script_versions?.find(version => version.current)?.version} /> : null}
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : Platform.OS === 'android' ? 'height' : undefined}>
      <ScrollView ref={scroll} keyboardShouldPersistTaps="handled" keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'} contentContainerStyle={styles.conversation} onLayout={() => { if (keyboardOpen.current && !overlay.current) scroll.current?.scrollToEnd({ animated: true }); }} onScroll={({ nativeEvent }) => { atBottom.current = nativeEvent.layoutMeasurement.height + nativeEvent.contentOffset.y >= nativeEvent.contentSize.height - space.xxl; }} scrollEventThrottle={16} onContentSizeChange={() => { const newMessages = messages.length !== previousCount.current; previousCount.current = messages.length; if ((newMessages || atBottom.current) && !overlay.current) scroll.current?.scrollToEnd({ animated: true }); }}>
        {loading ? <LoadingSkeleton kind="workspace" /> : null}
        {project && <AnimatedEntry><View style={styles.brief}><View style={styles.briefHeading}><Ionicons name="briefcase-outline" size={15} color={colors.muted} /><Text style={styles.eyebrow}>THE BRIEF / 这次想拍什么</Text></View><Text style={styles.briefText}>{project.brief}</Text></View></AnimatedEntry>}
        {projectPoints !== undefined ? <View style={styles.costRow}><Ionicons name="wallet-outline" size={13} color={colors.muted} /><Text testID="project-cost" style={styles.cost}>这组片已用 {formatPoints(projectPoints)}</Text></View> : null}
        {resultsFirst ? cardsNode : null}
        {messages.map((message, index) => <AnimatedEntry key={message.id} delay={Math.min(index * 30, 120)} style={[styles.message, message.role === 'user' ? styles.userMessage : styles.assistantMessage]}>
          {message.role === 'assistant' && <View style={styles.assistantIdentity}><View style={styles.assistantIcon}><Ionicons name="sparkles-outline" size={13} color={colors.redText} /></View><Text style={styles.identityText}>衣序 · 你的穿搭搭子</Text></View>}
          {messageText(message, state) ? <Pressable testID={`message-${message.id}`} accessibilityRole="button" accessibilityLabel={`消息：${messageText(message, state)}`} onLongPress={() => { feedback(); setSelectedMessage(message); }} delayLongPress={450} style={({ pressed }) => [styles.bubble, message.role === 'user' ? styles.userBubble : styles.assistantBubble, pressed && styles.pressed]}><Text selectable style={styles.messageText}>{messageText(message, state)}</Text></Pressable> : busy && message.role === 'assistant' ? <ProgressStrip title="正在整理你的灵感…" /> : null}
          {message.role === 'assistant' && busy && index === messages.length - 1 && !messageText(message, state) ? <View testID="assistant-thinking" accessibilityRole="progressbar" accessibilityLabel="衣序正在想" style={[styles.bubble, styles.assistantBubble, styles.thinking]}><ActivityIndicator size="small" color={colors.redText} /><Text style={styles.thinkingText}>{thinkingLabel(state)}</Text></View> : null}
          <MessageTrace message={message} />
          {!busy && canRephrase(message, messages, state) ? <Pressable testID="rephrase-message" accessibilityRole="button" accessibilityLabel="换个说法" onPress={() => { void send({ action: { type: 'regenerate_reply', message_id: message.id } }); }} style={({ pressed }) => [styles.textAction, pressed && styles.pressed]}><Ionicons name="refresh-outline" size={14} color={colors.redText} /><Text style={styles.textActionLabel}>换个说法</Text></Pressable> : null}
          {message.refs?.length ? <View style={styles.messageReferences}>{message.refs.map(imageId => {
            const image = state?.images.find(item => item.id === imageId);
            return image ? <ReferenceThumbnail key={imageId} image={image} testID={`message-ref-${message.id}-${imageId}`} /> : <Text key={imageId} style={styles.cost}>引用图片暂不可用</Text>;
          })}</View> : null}
        </AnimatedEntry>)}
        {failedMessages.map(message => <AnimatedEntry key={message.id} style={styles.failedMessage}><View testID={`failed-${message.id}`} style={styles.failedBubble}><Pressable accessibilityRole="button" accessibilityLabel={`消息：${message.text}`} onLongPress={() => setSelectedMessage({ id: message.id, role: 'user', text: message.text, cards: [], refs: message.input.refs, created_at: message.createdAt })} style={styles.failedTextButton}><Text style={styles.messageText}>{message.input.action ? `操作未完成：${message.text}` : message.text}</Text></Pressable><View style={styles.failureLabel}><Ionicons name="alert-circle-outline" size={14} color={colors.danger} /><Text style={styles.failureText}>{message.certain ? '发送失败' : '发送状态待确认'}</Text></View><Pressable testID={message.certain ? 'retry-failed-message' : 'check-uncertain-message'} accessibilityRole="button" accessibilityLabel={message.certain ? '重发消息' : '核对发送状态'} disabled={busy} onPress={() => { void retryMessage(message); }} style={({ pressed }) => [styles.textAction, pressed && styles.pressed]}><Text style={styles.textActionLabel}>{message.certain ? '重发消息' : '核对发送状态'}</Text></Pressable></View></AnimatedEntry>)}
        {state?.active_jobs.length ? <ProgressStrip title="正在生成，完成后会自动出现在这里" detail="可以继续聊灵感，我们会为你保留每个版本。" /> : null}
        {!resultsFirst ? cardsNode : null}
        {!automatic && state?.script && state.stage !== 'script' ? <ScriptHistory versions={state.script_versions} busy={busy} generating={Boolean(state.active_jobs.length)} onAction={action => { void send({ action }); }} /> : null}
        {!loading && !messages.length && !busy && <StatePanel icon="chatbubbles-outline" title="从一个灵感开始" description="说说这组片的想法，我们一起开始。" actionLabel="说说拍摄想法" onAction={() => input.current?.focus()} />}
      </ScrollView>
      <View style={styles.composer}>
        {!!error && <Notice text={error} onRetry={retry} />}
        {refs.length ? <ScrollView horizontal contentContainerStyle={styles.composerReferences} keyboardShouldPersistTaps="handled" showsHorizontalScrollIndicator={false}>{refs.map(imageId => {
          const image = state?.images.find(item => item.id === imageId);
          if (!image) return null;
          return <View key={imageId} style={styles.composerReference}><ReferenceThumbnail image={image} testID={`chat-ref-${imageId}`} /><Pressable testID={`remove-chat-ref-${imageId}`} accessibilityRole="button" accessibilityLabel="移除引用图片" onPress={() => { feedback(); setRefs(previous => previous.filter(value => value !== imageId)); }} style={({ pressed }) => [styles.removeReference, pressed && styles.pressed]}><Ionicons name="close-circle" size={20} color={colors.muted} /></Pressable></View>;
        })}</ScrollView> : null}
        {!automatic && state?.pending_action && <View style={styles.pendingAction}><View style={styles.pendingDot} /><Text style={styles.pendingText} numberOfLines={2}>{state.pending_action.prompt}</Text></View>}
        {!automatic && !busy && prompts.length ? <ScrollView horizontal keyboardShouldPersistTaps="handled" showsHorizontalScrollIndicator={false} contentContainerStyle={styles.quickPrompts} testID="quick-prompts">{prompts.map(prompt => <Chip key={prompt} label={prompt} onPress={() => { feedback(); setText(''); setRefs([]); void send({ text: prompt }); }} />)}</ScrollView> : null}
        <View style={styles.inputRow}>
          <TextInput ref={input} accessibilityLabel="发给穿搭搭子" testID="chat-input" placeholder="说说你的想法，随时都能聊…" placeholderTextColor={colors.muted} value={text} onChangeText={setText} multiline maxLength={4000} style={styles.input} />
          <Pressable accessibilityRole="button" accessibilityLabel="发送消息" accessibilityState={{ disabled: busy || !text.trim() }} testID="send-message" disabled={busy || !text.trim()} onPress={submit} style={({ pressed }) => [styles.sendButton, (busy || !text.trim()) && styles.disabled, pressed && styles.pressed]}><Ionicons name="arrow-up" size={22} color={colors.white} /></Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
    {!!copyStatus && <Toast text={copyStatus} tone={copyStatus.startsWith('复制未') ? 'danger' : 'success'} onDismiss={() => setCopyStatus('')} />}
    {notice && <Toast text={notice.text} tone={notice.tone} onDismiss={() => setNotice(undefined)} />}
    <Modal visible={!!selectedMessage} transparent animationType="fade" onRequestClose={() => setSelectedMessage(undefined)}><View style={styles.modalShade}><Pressable style={StyleSheet.absoluteFill} accessibilityRole="button" accessibilityLabel="关闭消息操作" onPress={() => setSelectedMessage(undefined)} /><Animated.View entering={SlideInDown.duration(motion.normal)} style={[styles.messageSheet, { paddingBottom: space.xl + insets.bottom }]} accessibilityViewIsModal><View style={styles.sheetHandle} /><Text style={styles.sheetTitle}>消息操作</Text><Pressable accessibilityRole="button" accessibilityLabel="复制消息文本" testID="copy-message" style={({ pressed }) => [styles.sheetAction, pressed && styles.pressed]} onPress={() => {
      const value = selectedMessage ? messageText(selectedMessage, state) : '';
      void Clipboard.setStringAsync(value || '').then(() => { setCopyStatus('消息文本已复制'); setSelectedMessage(undefined); }).catch(() => { setCopyStatus('复制未完成，请长按文本选择复制。'); setSelectedMessage(undefined); });
    }}><Ionicons name="copy-outline" size={20} color={colors.redText} /><Text style={styles.sheetActionLabel}>复制文本</Text></Pressable><Pressable accessibilityRole="button" accessibilityLabel="取消消息操作" onPress={() => setSelectedMessage(undefined)} style={({ pressed }) => [styles.sheetAction, styles.cancelAction, pressed && styles.pressed]}><Text style={styles.cancelLabel}>取消</Text></Pressable></Animated.View></View></Modal>
  </Page></ImageInteractions>;
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  empty: { padding: space.xl },
  steps: { flexDirection: 'row', paddingHorizontal: space.lg, paddingVertical: space.lg, gap: space.sm, borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.white },
  step: { flex: 1, gap: space.sm },
  stepTrack: { height: 4, borderRadius: radius.sm, backgroundColor: colors.border },
  stepTrackActive: { backgroundColor: colors.red },
  stepLabelRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs, flexWrap: 'wrap' },
  stepNumber: { ...typography.badge, color: colors.muted, fontWeight: '600' },
  stepLabel: { ...typography.badge, color: colors.muted },
  activeText: { color: colors.redText, fontWeight: '700' },
  conversation: { padding: space.lg, paddingBottom: space.xl, gap: space.lg },
  brief: { backgroundColor: colors.paper, padding: space.lg, borderRadius: radius.md, gap: space.sm, borderWidth: 1, borderColor: colors.border },
  briefHeading: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  eyebrow: { ...typography.badge, color: colors.muted, letterSpacing: 1 },
  briefText: { ...typography.caption, color: colors.muted },
  costRow: { flexDirection: 'row', gap: space.xs, alignItems: 'center' },
  cost: { ...typography.badge, color: colors.muted },
  message: { gap: space.sm },
  userMessage: { alignItems: 'flex-end' },
  assistantMessage: { alignItems: 'flex-start' },
  assistantIdentity: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  assistantIcon: { backgroundColor: colors.blush, width: 28, height: 28, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm },
  identityText: { ...typography.badge, color: colors.muted },
  bubble: { maxWidth: '94%', minWidth: 44, minHeight: 44, padding: space.lg, borderRadius: radius.md, borderWidth: 1 },
  userBubble: { backgroundColor: colors.blush, borderColor: colors.blush, borderTopRightRadius: radius.sm },
  assistantBubble: { backgroundColor: colors.white, borderColor: colors.border, borderTopLeftRadius: radius.sm },
  thinking: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  thinkingText: { ...typography.caption, color: colors.muted },
  messageText: { ...typography.body, color: colors.ink },
  textAction: { minHeight: 44, minWidth: 44, flexDirection: 'row', alignItems: 'center', gap: space.xs, paddingHorizontal: space.sm, alignSelf: 'flex-start' },
  textActionLabel: { ...typography.caption, color: colors.redText, fontWeight: '600' },
  messageReferences: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  reference: { width: 52, aspectRatio: layout.thumbnailRatio, borderRadius: radius.sm, overflow: 'hidden', backgroundColor: colors.imagePlaceholder },
  referenceImage: { width: '100%', height: '100%' },
  pressed: { opacity: 0.8, transform: [{ scale: 0.98 }] },
  failedMessage: { alignSelf: 'flex-end', maxWidth: '94%' },
  failedBubble: { backgroundColor: colors.blush, padding: space.lg, borderRadius: radius.md, gap: space.sm, borderWidth: 1, borderColor: colors.border },
  failedTextButton: { minHeight: 44, justifyContent: 'center' },
  failureLabel: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  failureText: { ...typography.caption, color: colors.danger },
  composer: { borderTopWidth: 1, borderTopColor: colors.border, padding: space.md, paddingHorizontal: space.lg, gap: space.sm, backgroundColor: colors.white },
  composerReferences: { gap: space.md, paddingTop: space.xs },
  quickPrompts: { gap: space.sm, paddingVertical: space.xs },
  composerReference: { flexDirection: 'row', gap: space.xs, alignItems: 'flex-start' },
  removeReference: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  pendingAction: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  pendingDot: { width: 4, height: 4, borderRadius: radius.sm, backgroundColor: colors.red },
  pendingText: { ...typography.badge, color: colors.muted, flex: 1 },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', borderWidth: 1, borderColor: colors.border, backgroundColor: colors.paper, paddingLeft: space.lg, paddingRight: space.xs, borderRadius: radius.lg },
  input: { ...typography.body, flex: 1, minHeight: 52, paddingVertical: space.md, paddingRight: space.sm, maxHeight: 128, color: colors.ink },
  sendButton: { width: 44, height: 44, marginBottom: space.xs, backgroundColor: colors.redText, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  disabled: { opacity: 0.4 },
  modalShade: { flex: 1, backgroundColor: colors.overlay, justifyContent: 'flex-end', alignItems: 'center' },
  messageSheet: { width: '100%', maxWidth: 520, backgroundColor: colors.white, padding: space.xl, gap: space.lg, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg },
  sheetHandle: { width: 36, height: 4, backgroundColor: colors.border, borderRadius: radius.sm, alignSelf: 'center' },
  sheetTitle: { ...typography.heading, fontWeight: '700', color: colors.ink },
  sheetAction: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg, borderRadius: radius.sm, backgroundColor: colors.blush },
  sheetActionLabel: { ...typography.body, color: colors.redText, fontWeight: '600' },
  cancelAction: { backgroundColor: colors.paper, justifyContent: 'center' },
  cancelLabel: { ...typography.body, color: colors.muted },
});
