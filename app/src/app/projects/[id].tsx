import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { Cards } from '../../components/Cards';
import { ScriptHistory } from '../../components/ScriptHistory';
import { Header, IconButton, Loading, Notice, Page, colors, stageNames } from '../../components/ui';
import { useWorkspace } from '../../hooks/useWorkspace';
import type { Message, OutfitImage, ProjectState } from '../../api/types';
import { ImageInteractions, useImageInteractions } from '../../components/ImageInteractions';
import { feedback } from '../../lib/haptics';

function ReferenceThumbnail({ image, testID }: { image: OutfitImage; testID: string }) {
  const interaction = useImageInteractions();
  return <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={`查看引用图片 v${image.version}`} onPress={() => interaction.open(image.id)} onLongPress={() => interaction.menu(image.id)} style={{ borderRadius: 9, overflow: 'hidden' }}><Image source={{ uri: image.url }} style={{ width: 52, height: 66, backgroundColor: colors.paper }} /></Pressable>;
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
  }
}

export default function Workspace() {
  const params = useLocalSearchParams<{ id: string; refImage?: string }>();
  return <WorkspacePage key={params.id} id={params.id || ''} refImage={params.refImage} />;
}

function WorkspacePage({ id, refImage }: { id: string; refImage?: string }) {
  const router = useRouter();
  const { project, state, messages, cards, loading, busy, error, send, retry } = useWorkspace(id);
  const [text, setText] = useState('');
  const [refs, setRefs] = useState<string[]>([]);
  const overlay = useRef(false);
  const overlayChanged = useCallback((visible: boolean) => { overlay.current = visible; }, []);
  const addReference = useCallback((image: OutfitImage) => setRefs(previous => [...new Set([...previous, image.id])]), []);
  useFocusEffect(useCallback(() => {
    if (refImage) {
      setRefs(previous => [...new Set([...previous, refImage])]);
      router.setParams({ refImage: undefined });
    }
  }, [refImage, router]));
  const scroll = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const previousCount = useRef(0);
  const preview = () => router.push({ pathname: '/preview/[id]', params: { id } });
  function submit() {
    if (!text.trim() || busy) return;
    const value = text.trim(); feedback(); setText(''); setRefs([]);
    void send({ text: value, ...(refs.length ? { refs } : {}) }).then(accepted => {
      if (!accepted) { setText(current => current || value); setRefs(current => [...new Set([...refs, ...current])]); }
    });
  }
  const stageOrder = ['direction', 'script', 'images', 'note'];
  const activeIndex = state ? stageOrder.indexOf(state.stage) : -1;
  const visibleCards = cards.filter(card => {
    if (!state) return true;
    if (state.stage === 'direction' || state.stage === 'brief') return card.type === 'garments' || card.type === 'directions';
    if (state.stage === 'script') return card.type === 'script';
    if (state.stage === 'images') return card.type === 'images';
    if (state.stage === 'note') return card.type === 'note';
    if (state.stage === 'video' || state.stage === 'done') return card.type === 'video' || card.type === 'note';
    return true;
  });
  return <ImageInteractions images={state?.images ?? []} editActions={messages.flatMap(message => message.action?.type === 'edit_image' ? [message.action] : [])} busy={busy} canEdit={['images', 'note', 'done'].includes(state?.stage ?? '')} onAction={action => send({ action })} onReference={addReference} onVisibilityChange={overlayChanged}><Page>
    <Header title={project?.title || '合作工作台'} subtitle={project?.brand || '把灵感，一起聊出来'} onBack={() => router.replace('/')} right={state?.note ? <IconButton name="document-text-outline" label="笔记预览" onPress={preview} /> : <IconButton name="refresh-outline" label="刷新项目" onPress={retry} />} />
    <View style={{ flexDirection: 'row', paddingHorizontal: 22, paddingVertical: 14, gap: 5, borderBottomWidth: 1, borderBottomColor: colors.border }}>
      {stageOrder.map((stage, index) => <View key={stage} style={{ flex: 1, gap: 7 }}><View style={{ height: 3, borderRadius: 3, backgroundColor: index <= activeIndex || ['video', 'done'].includes(state?.stage || '') ? colors.red : '#F1EFEA' }} /><Text style={{ fontSize: 10, color: index === activeIndex ? colors.red : colors.muted, fontWeight: index === activeIndex ? '700' : '400' }}>{String(index + 1).padStart(2, '0')} {stageNames[stage]}</Text></View>)}
    </View>
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView ref={scroll} keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 18, paddingBottom: 28, gap: 18 }} onContentSizeChange={() => { if (messages.length !== previousCount.current) { previousCount.current = messages.length; if (!overlay.current) scroll.current?.scrollToEnd({ animated: true }); } }}>
        {loading ? <Loading text="正在接着上次的灵感…" /> : null}
        {project && <View style={{ backgroundColor: colors.paper, padding: 15, borderRadius: 14, gap: 7 }}><Text style={{ fontSize: 10, letterSpacing: 2, color: colors.muted }}>BRAND BRIEF / 合作需求</Text><Text style={{ fontSize: 12, lineHeight: 20, color: '#706C64' }}>{project.brief}</Text></View>}
        {typeof state?.cost_cny === 'number' ? <Text testID="project-cost" style={{ color: colors.muted, fontSize: 11 }}>项目累计约 ¥{state.cost_cny.toFixed(1)}</Text> : null}
        {messages.map(message => <View key={message.id} style={{ alignItems: message.role === 'user' ? 'flex-end' : 'flex-start', gap: 7 }}>
          {message.role === 'assistant' && <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}><View style={{ backgroundColor: colors.blush, padding: 5, borderRadius: 8 }}><Ionicons name="sparkles-outline" size={12} color={colors.red} /></View><Text style={{ fontSize: 10, color: colors.muted }}>衣序 · 你的穿搭搭子</Text></View>}
          {messageText(message, state) ? <View style={{ maxWidth: '94%', padding: 14, borderRadius: 15, backgroundColor: message.role === 'user' ? colors.blush : colors.paper, borderTopRightRadius: message.role === 'user' ? 4 : 15, borderTopLeftRadius: message.role === 'assistant' ? 4 : 15 }}><Text selectable style={{ fontSize: 13, lineHeight: 23, color: colors.ink }}>{messageText(message, state)}</Text></View> : busy && message.id.startsWith('local-') ? <ActivityIndicator size="small" color={colors.red} /> : null}
          {message.refs?.length ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 7 }}>{message.refs.map(imageId => {
            const image = state?.images.find(item => item.id === imageId);
            return image ? <ReferenceThumbnail key={imageId} image={image} testID={`message-ref-${message.id}-${imageId}`} /> : <Text key={imageId} style={{ color: colors.muted, fontSize: 11 }}>引用图片暂不可用</Text>;
          })}</View> : null}
        </View>)}
        {state?.active_jobs.length ? <View style={{ flexDirection: 'row', alignItems: 'center', padding: 12, gap: 9, borderRadius: 12, backgroundColor: colors.blush }}><ActivityIndicator size="small" color={colors.red} /><Text style={{ color: colors.red, fontSize: 12 }}>正在生成，完成后会自动出现在这里</Text></View> : null}
        <Cards cards={visibleCards} state={state} busy={busy} onAction={action => { void send({ action }); }} onPreview={preview} />
        {state?.script && state.stage !== 'script' ? <ScriptHistory versions={state.script_versions} busy={busy} generating={Boolean(state.active_jobs.length)} onAction={action => { void send({ action }); }} /> : null}
        {!loading && !messages.length && !busy && <Text style={{ color: colors.muted, textAlign: 'center', fontSize: 12 }}>说说这次合作的想法，我们一起开始。</Text>}
      </ScrollView>
      <View style={{ borderTopWidth: 1, borderTopColor: colors.border, padding: 12, paddingHorizontal: 16, gap: 8, backgroundColor: 'white' }}>
        {!!error && <Notice text={error} onRetry={retry} />}
        {refs.length ? <ScrollView horizontal contentContainerStyle={{ gap: 12, paddingTop: 4 }} keyboardShouldPersistTaps="handled">{refs.map(imageId => {
          const image = state?.images.find(item => item.id === imageId);
          if (!image) return null;
          return <View key={imageId} style={{ flexDirection: 'row', gap: 4, alignItems: 'flex-start' }}><ReferenceThumbnail image={image} testID={`chat-ref-${imageId}`} /><Pressable testID={`remove-chat-ref-${imageId}`} accessibilityRole="button" accessibilityLabel="移除引用图片" hitSlop={8} onPress={() => { feedback(); setRefs(previous => previous.filter(value => value !== imageId)); }} style={{ padding: 5 }}><Ionicons name="close-circle" size={19} color={colors.muted} /></Pressable></View>;
        })}</ScrollView> : null}
        {state?.pending_action && <Text style={{ color: colors.muted, fontSize: 10 }} numberOfLines={1}>{state.pending_action.prompt}</Text>}
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', borderWidth: 1, borderColor: colors.border, backgroundColor: colors.paper, paddingLeft: 14, paddingRight: 5, borderRadius: 23 }}>
          <TextInput accessibilityLabel="发给穿搭搭子" testID="chat-input" placeholder="说说你的想法，随时都能聊…" placeholderTextColor="#A5A097" value={text} onChangeText={setText} multiline maxLength={4000} style={{ flex: 1, paddingVertical: 14, fontSize: 13, lineHeight: 19, maxHeight: 110, color: colors.ink }} />
          <Pressable accessibilityRole="button" accessibilityLabel="发送消息" testID="send-message" disabled={busy || !text.trim()} onPress={submit} style={{ width: 35, height: 35, marginBottom: 6, backgroundColor: colors.red, borderRadius: 18, alignItems: 'center', justifyContent: 'center', opacity: busy || !text.trim() ? 0.35 : 1 }}><Ionicons name="arrow-up" size={21} color="white" /></Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  </Page></ImageInteractions>;
}
