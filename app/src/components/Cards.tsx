import { Ionicons } from '@expo/vector-icons';
import { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { Action, Card, Direction, OutfitImage, ProjectState } from '../api/types';
import { VideoPlayer } from './VideoPlayer';
import { FidelityBadge, ImageRevisionInfo, NoteDisclosure } from './GenerationInfo';
import { ScriptHistory } from './ScriptHistory';

type CardsProps = {
  cards: Card[];
  state?: ProjectState;
  busy?: boolean;
  onAction: (action: Action) => void;
  onPreview: () => void;
};

type IconName = React.ComponentProps<typeof Ionicons>['name'];
const colors = {
  red: '#FF2442',
  ink: '#242323',
  muted: '#86817D',
  line: '#F0ECE8',
  cream: '#F7F4EF',
  pink: '#FFF0F2',
  green: '#4C775A',
};

function Icon({ name, size = 16, color = colors.muted }: { name: IconName; size?: number; color?: string }) {
  return <Ionicons name={name} size={size} color={color} />;
}

function CardHeading({ icon, title, detail }: { icon: IconName; title: string; detail?: string }) {
  return (
    <View style={styles.heading}>
      <View style={styles.headingIcon}><Icon name={icon} color={colors.red} size={17} /></View>
      <Text style={styles.headingTitle}>{title}</Text>
      {detail ? <Text style={styles.headingDetail}>{detail}</Text> : null}
    </View>
  );
}

function Button({ title, onPress, disabled, testID, secondary = false, icon }: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  testID?: string;
  secondary?: boolean;
  icon?: IconName;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled: Boolean(disabled) }}
      testID={testID}
      style={({ pressed }) => [styles.button, secondary && styles.secondaryButton, disabled && styles.disabledButton, pressed && !disabled && styles.pressed]}
    >
      {icon ? <Icon name={icon} color={secondary ? colors.ink : '#FFFFFF'} size={17} /> : null}
      <Text style={[styles.buttonText, secondary && styles.secondaryButtonText]}>{title}</Text>
    </Pressable>
  );
}

function DirectionOption({ direction, selected, enabled, onPress }: {
  direction: Direction;
  selected: boolean;
  enabled: boolean;
  onPress: () => void;
}) {
  const palette = Array.isArray(direction.palette) ? direction.palette.join(' · ') : direction.palette;
  return (
    <Pressable
      onPress={onPress}
      disabled={!enabled}
      accessibilityRole="button"
      accessibilityLabel={`选择方向：${direction.name}`}
      accessibilityState={{ selected, disabled: !enabled }}
      testID={`direction-${direction.id}`}
      style={({ pressed }) => [styles.direction, selected && styles.directionSelected, pressed && enabled && styles.pressed]}
    >
      <DirectionPreview direction={direction} />
      <View style={styles.rowBetween}>
        <Text style={styles.directionName}>{direction.name}</Text>
        <View style={[styles.radio, selected && styles.radioSelected]}>
          {selected ? <Icon name="checkmark" size={12} color="#FFFFFF" /> : null}
        </View>
      </View>
      <Text style={styles.directionScene}>{direction.scene} · {direction.mood}</Text>
      <Text style={styles.directionWhy}>{direction.why}</Text>
      {palette ? <View style={styles.palette}><Icon name="color-palette-outline" size={12} /><Text style={styles.paletteText}>{palette}</Text></View> : null}
      {direction.sample_title ? <Text style={styles.sampleTitle}>“{direction.sample_title}”</Text> : null}
      <Text style={[styles.directionAction, selected && { color: colors.green }]}>
        {selected ? '已选这个方向' : enabled ? '就选这个方向  ↗' : '方向已确认'}
      </Text>
    </Pressable>
  );
}

function DirectionPreview({ direction }: { direction: Direction }) {
  const [failedUrl, setFailedUrl] = useState<string>();
  const [loadedUrl, setLoadedUrl] = useState<string>();
  const url = direction.preview_url;
  const failed = direction.preview_status === 'failed' || Boolean(url && failedUrl === url) || (direction.preview_status === 'succeeded' && !url);
  const ready = Boolean(url && !failed && (!direction.preview_status || direction.preview_status === 'succeeded'));
  const running = direction.preview_status === 'running';
  return <View style={styles.directionPreview} testID={`direction-preview-${direction.id}`}>
    {ready && url ? <>
      <Image source={{ uri: url }} style={styles.previewImage} resizeMode="cover" accessibilityLabel={`${direction.name}灵感预览`} testID={`preview-image-${direction.id}`} onLoad={() => setLoadedUrl(url)} onError={() => setFailedUrl(url)} />
      {loadedUrl !== url ? <ActivityIndicator color={colors.red} style={StyleSheet.absoluteFill} /> : null}
      <View style={styles.previewLabel}><Text style={styles.previewLabelText}>灵感预览 · AI生成</Text></View>
    </> : <View style={styles.previewPlaceholder} testID={`preview-placeholder-${direction.id}`}>
      {failed ? <Icon name="image-outline" color="#A8907D" size={24} /> : direction.preview_status ? <ActivityIndicator color="#B6967B" size="small" /> : <Icon name="color-palette-outline" color="#B6967B" size={24} />}
      <Text style={styles.previewStatus}>{failed ? '灵感图暂时没成功，可先按文字选方向' : running ? '正在描绘这份灵感…' : direction.preview_status === 'queued' ? '灵感图已排队，马上开始' : '灵感预览暂未提供'}</Text>
      {!failed && direction.preview_status ? <View style={styles.progressTrack}><View style={[styles.progressFill, !running && { width: '20%' }]} /></View> : null}
    </View>}
  </View>;
}

function useImageVersions(items: OutfitImage[], state?: ProjectState) {
  return useMemo(() => {
    const relevantShots = new Set(items.map((item) => item.shot_id));
    const map = new Map(items.map((item) => [item.id, item]));
    for (const item of state?.images ?? []) {
      if (map.has(item.id) || relevantShots.has(item.shot_id)) map.set(item.id, item);
    }
    const order = [...relevantShots];
    return [...map.values()].sort((a, b) => order.indexOf(a.shot_id) - order.indexOf(b.shot_id) || b.version - a.version);
  }, [items, state?.images]);
}

function ImageGrid({ items, state, busy, onAction }: {
  items: OutfitImage[];
  state?: ProjectState;
  busy?: boolean;
  onAction: (action: Action) => void;
}) {
  const images = useImageVersions(items, state);
  const [selection, setSelection] = useState<string[] | null>(null);
  const [editing, setEditing] = useState<OutfitImage | null>(null);
  const [instruction, setInstruction] = useState('');
  const latest = new Map<string, OutfitImage>();
  for (const item of images) {
    const previous = latest.get(item.shot_id);
    if (!previous || item.version > previous.version) latest.set(item.shot_id, item);
  }
  const successful = images.filter((item) => item.status === 'succeeded' && item.url);
  const validIds = new Set(successful.map((item) => item.id));
  const defaults = state?.note?.image_ids ?? [...latest.values()].filter((item) => item.status === 'succeeded' && item.url).map((item) => item.id);
  const selected = (selection ?? defaults).filter((id) => validIds.has(id));
  const isGenerating = images.some((item) => item.status === 'queued' || item.status === 'running');
  const canEdit = !busy && (!state || state.stage === 'images' || state.stage === 'note');
  const canApprove = !busy && !isGenerating && selected.length > 0 && (!state || state.stage === 'images');
  const shotIds = [...new Set(images.map((item) => item.shot_id))];
  const latestDone = [...latest.values()].filter((item) => item.status === 'succeeded').length;

  const toggle = (id: string) => {
    setSelection(selected.includes(id) ? selected.filter((value) => value !== id) : [...selected, id]);
  };
  const move = (id: string, offset: number) => {
    const index = selected.indexOf(id);
    const nextIndex = index + offset;
    if (index < 0 || nextIndex < 0 || nextIndex >= selected.length) return;
    const next = [...selected];
    [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
    setSelection(next);
  };

  return (
    <View style={styles.card}>
      <CardHeading icon="images-outline" title="你的穿搭影像" detail={`${latestDone}/${latest.size} 已完成`} />
      <Text style={styles.intro}>{isGenerating ? '正在把灵感变成画面，完成的图片会陆续出现。' : '点选喜欢的图，再排一下顺序。第一张就是笔记封面。'}</Text>
      <View style={styles.imageGrid}>
        {images.map((item) => {
          const selectedIndex = selected.indexOf(item.id);
          const isLatest = latest.get(item.shot_id)?.id === item.id;
          return (
            <View key={item.id} style={styles.imageTile}>
              <Pressable
                onPress={() => toggle(item.id)}
                disabled={item.status !== 'succeeded' || !item.url || Boolean(busy)}
                accessibilityRole="button"
                accessibilityLabel={`选择镜头 ${shotIds.indexOf(item.shot_id) + 1} 第 ${item.version} 版`}
                accessibilityState={{ selected: selectedIndex >= 0 }}
                testID={`image-select-${item.id}`}
                style={[styles.imageFrame, selectedIndex >= 0 && styles.imageFrameSelected]}
              >
                {item.url && item.status === 'succeeded' ? <Image source={{ uri: item.url }} style={styles.generatedImage} resizeMode="cover" accessibilityLabel={`穿搭镜头 ${shotIds.indexOf(item.shot_id) + 1}`} /> : (
                  <View style={styles.generating}>
                    {item.status === 'failed' ? <Icon name="alert-circle-outline" color={colors.red} size={26} /> : item.status === 'running' ? <ActivityIndicator color={colors.red} /> : <Icon name="hourglass-outline" size={25} color="#B6A89C" />}
                    <Text style={styles.generatingTitle}>{item.status === 'failed' ? '这张暂时没成功' : item.status === 'running' ? '画面生成中' : '等待生成'}</Text>
                    <Text style={styles.generatingDetail}>{item.status === 'failed' ? item.error ?? '在对话里告诉我，我们再试一次' : item.status === 'running' ? '好看的细节，值得等一等' : '马上就轮到这一张'}</Text>
                    {item.status === 'running' ? <View style={styles.progressTrack}><View style={styles.progressFill} /></View> : null}
                  </View>
                )}
                {item.status === 'succeeded' ? <View style={[styles.selectionBadge, selectedIndex >= 0 && styles.selectionBadgeSelected]}><Text style={styles.selectionBadgeText}>{selectedIndex >= 0 ? selectedIndex + 1 : ''}</Text></View> : null}
                <View style={styles.versionBadge}><Text style={styles.versionText}>{isLatest ? `v${item.version}${item.version > 1 ? ' 新版' : ''}` : `v${item.version} 原版`}</Text></View>
                {item.status === 'succeeded' ? <FidelityBadge image={item} /> : null}
              </Pressable>
              <View style={styles.imageCaptionRow}>
                <Text style={styles.imageCaption}>镜头 {String(shotIds.indexOf(item.shot_id) + 1).padStart(2, '0')}{item.script_version ? ` · 脚本 ${item.script_version}` : ''}</Text>
                {item.status === 'succeeded' && canEdit ? <Pressable
                  onPress={() => { setEditing(item); setInstruction(''); }}
                  accessibilityRole="button"
                  accessibilityLabel={`修改镜头 ${shotIds.indexOf(item.shot_id) + 1}`}
                  testID={`edit-image-${item.id}`}
                  hitSlop={8}
                  style={styles.editButton}
                ><Icon name="create-outline" size={13} color={colors.red} /><Text style={styles.editText}>改一改</Text></Pressable> : null}
              </View>
              <ImageRevisionInfo image={item} />
            </View>
          );
        })}
      </View>
      {images.some((item) => item.parent_id) ? <View style={styles.versionHint}><Icon name="layers-outline" size={13} /><Text style={styles.smallText}>新版和原版都在，随时可以重新选。</Text></View> : null}
      {selected.length > 0 ? <View style={styles.sortSection}>
        <View style={styles.rowBetween}><Text style={styles.sortTitle}>笔记图片顺序</Text><Text style={styles.smallText}>已选 {selected.length} 张</Text></View>
        {selected.map((id, index) => {
          const item = successful.find((value) => value.id === id);
          if (!item) return null;
          return <View key={id} style={styles.sortRow}>
            <Text style={[styles.sortNumber, index === 0 && { color: colors.red }]}>{String(index + 1).padStart(2, '0')}</Text>
            <Image source={{ uri: item.url }} style={styles.sortThumbnail} />
            <Text style={styles.sortLabel}>{index === 0 ? '封面 · ' : ''}镜头 {shotIds.indexOf(item.shot_id) + 1} <Text style={styles.smallText}>v{item.version}</Text></Text>
            <Pressable onPress={() => move(id, -1)} disabled={index === 0 || Boolean(busy)} accessibilityRole="button" accessibilityLabel={`第 ${index + 1} 张向前移`} testID={`move-up-${id}`} style={[styles.sortArrow, index === 0 && styles.dimmed]}><Icon name="arrow-up" size={15} color={colors.ink} /></Pressable>
            <Pressable onPress={() => move(id, 1)} disabled={index === selected.length - 1 || Boolean(busy)} accessibilityRole="button" accessibilityLabel={`第 ${index + 1} 张向后移`} testID={`move-down-${id}`} style={[styles.sortArrow, index === selected.length - 1 && styles.dimmed]}><Icon name="arrow-down" size={15} color={colors.ink} /></Pressable>
          </View>;
        })}
      </View> : null}
      <Button title={state && state.stage !== 'images' ? '图片已确认' : `选好了，生成笔记${selected.length ? `（${selected.length} 张）` : ''}`} icon="checkmark" onPress={() => onAction({ type: 'approve_images', image_ids: selected })} disabled={!canApprove} testID="approve-images" />
      <Modal visible={Boolean(editing)} transparent animationType="fade" onRequestClose={() => setEditing(null)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.modalShade}>
          <View style={styles.modal}>
            <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} style={{ flexShrink: 1 }}>
            <View style={styles.rowBetween}><Text style={styles.modalTitle}>让这张更合心意</Text><Pressable onPress={() => setEditing(null)} accessibilityLabel="关闭修改图片" accessibilityRole="button" hitSlop={10}><Icon name="close" size={22} color={colors.ink} /></Pressable></View>
            <Text style={styles.intro}>说说想改哪里，原版会为你保留。</Text>
            {editing?.url ? <Image source={{ uri: editing.url }} style={styles.editPreview} /> : null}
            <TextInput value={instruction} onChangeText={setInstruction} placeholder="比如：把衬衫塞进裤腰，背景再亮一点" placeholderTextColor="#A39B94" multiline maxLength={1000} style={styles.editInput} accessibilityLabel="图片修改要求" testID="edit-instruction" />
            <View style={styles.quickEdits}>{['衬衫塞进裤腰', '背景亮一点', '换个角度', '换个姿势'].map((suggestion, index) => <Pressable key={suggestion} accessibilityRole="button" accessibilityLabel={suggestion} testID={`edit-suggestion-${index}`} onPress={() => setInstruction(suggestion)} style={styles.quickEdit}><Text style={styles.quickEditText}>{suggestion}</Text></Pressable>)}</View>
            <Button title="按这个想法改一版" icon="sparkles-outline" disabled={!instruction.trim() || Boolean(busy)} testID="submit-edit" onPress={() => { if (editing && instruction.trim()) { onAction({ type: 'edit_image', image_id: editing.id, instruction: instruction.trim() }); setEditing(null); } }} />
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

function NoteCard({ card, state, busy, onAction, onPreview }: {
  card: Extract<Card, { type: 'note' }>;
  state?: ProjectState;
  busy?: boolean;
  onAction: (action: Action) => void;
  onPreview: () => void;
}) {
  const note = state?.note ?? card;
  const [videoImageId, setVideoImageId] = useState<string | null>(null);
  const selectedImageId = videoImageId && note.image_ids.includes(videoImageId) ? videoImageId : note.image_ids[0];
  const mayMakeVideo = !state?.video && (!state || state.pending_action?.type === 'confirm_video' || (state.pending_action === undefined && state.stage === 'note'));
  return <View style={styles.card}>
    <CardHeading icon="document-text-outline" title="笔记写好了" detail="READY TO POST" />
    <Text style={styles.noteTitle}>{note.title}</Text>
    <Text numberOfLines={6} style={styles.noteBody}>{note.body}</Text>
    <View style={styles.tags}>{note.tags.map((tag) => <Text key={tag} style={styles.noteTag}>#{tag.replace(/^#/, '')}</Text>)}</View>
    <NoteDisclosure note={note} projectCost={state?.cost_cny} testIDPrefix="card-note" />
    <Button title="打开笔记预览" onPress={onPreview} testID="preview-note" icon="open-outline" />
    {mayMakeVideo && note.image_ids.length > 0 ? <View style={styles.videoPrompt}>
      <View style={styles.rowBetween}><Text style={styles.sortTitle}>再让穿搭动起来？</Text><Text style={styles.optional}>可选 · 5 秒短视频</Text></View>
      <Text style={styles.intro}>选一张作为视频画面，确认后开始生成。</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.videoSources}>
        {note.image_ids.map((id, index) => {
          const image = state?.images.find((item) => item.id === id);
          return <Pressable key={id} onPress={() => setVideoImageId(id)} accessibilityRole="button" accessibilityLabel={`选择第 ${index + 1} 张生成视频`} accessibilityState={{ selected: id === selectedImageId }} testID={`video-source-${id}`} style={[styles.videoSource, id === selectedImageId && styles.videoSourceSelected]}>
            {image?.url ? <Image source={{ uri: image.url }} style={styles.videoSourceImage} /> : <View style={[styles.videoSourceImage, styles.sourcePlaceholder]}><Icon name="image-outline" size={20} /></View>}
            {id === selectedImageId ? <View style={styles.sourceCheck}><Icon name="checkmark" size={12} color="#FFFFFF" /></View> : null}
          </Pressable>;
        })}
      </ScrollView>
      <Button title="确认生成短视频" secondary icon="videocam-outline" disabled={Boolean(busy) || !selectedImageId} onPress={() => { if (selectedImageId) onAction({ type: 'confirm_video', image_id: selectedImageId }); }} testID="confirm-video" />
    </View> : null}
  </View>;
}

function VideoRetry({ state, busy, onAction }: {
  state?: ProjectState;
  busy?: boolean;
  onAction: (action: Action) => void;
}) {
  const [chosen, setChosen] = useState<string | null>(null);
  const images = (state?.note?.image_ids ?? []).flatMap((id) => {
    const image = state?.images.find((item) => item.id === id && item.status === 'succeeded' && item.url);
    return image ? [image] : [];
  });
  const selected = images.some((image) => image.id === chosen) ? chosen : images[0]?.id;
  const awaitingConfirmation = state?.pending_action?.type === 'confirm_video' || (state?.pending_action === undefined && state?.stage === 'note');
  if (!awaitingConfirmation) return null;
  return <View style={styles.videoRetry}>
    <Text style={styles.sortTitle}>选一张图片，再试一次</Text>
    <Text style={styles.intro}>图文笔记已经保留，确认后只重新制作短片。</Text>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.videoSources}>
      {images.map((image, index) => <Pressable
        key={image.id}
        onPress={() => setChosen(image.id)}
        disabled={Boolean(busy)}
        accessibilityRole="button"
        accessibilityLabel={`选择第 ${index + 1} 张重试视频`}
        accessibilityState={{ selected: image.id === selected }}
        testID={`retry-video-source-${image.id}`}
        style={[styles.videoSource, image.id === selected && styles.videoSourceSelected]}
      >
        <Image source={{ uri: image.url }} style={styles.videoSourceImage} />
        {image.id === selected ? <View style={styles.sourceCheck}><Icon name="checkmark" size={12} color="#FFFFFF" /></View> : null}
      </Pressable>)}
    </ScrollView>
    <Button title="确认重试短视频" secondary icon="refresh" disabled={Boolean(busy) || !selected} testID="retry-video" onPress={() => { if (selected) onAction({ type: 'confirm_video', image_id: selected }); }} />
  </View>;
}

export function Cards({ cards, state, busy, onAction, onPreview }: CardsProps) {
  return <View style={styles.cards}>{cards.map((card) => {
    if (card.type === 'images') return <ImageGrid key={card.id} items={card.items} state={state} busy={busy} onAction={onAction} />;
    if (card.type === 'note') return <NoteCard key={card.id} card={card} state={state} busy={busy} onAction={onAction} onPreview={onPreview} />;
    if (card.type === 'garments') return <View key={card.id} style={styles.card}>
      <CardHeading icon="shirt-outline" title="先认识一下这件衣服" detail={`${card.items.length} 件单品`} />
      {card.items.map((item) => <View key={item.asset_id} style={styles.garmentRow}>
        <Image source={{ uri: item.url }} style={styles.garmentImage} resizeMode="cover" accessibilityLabel={`${item.color}${item.category}`} />
        <View style={styles.garmentInfo}><Text style={styles.garmentTitle}>{item.color} · {item.category}</Text><Text style={styles.garmentMaterial}>{item.material}</Text><View style={styles.tags}>{item.style_tags.map((tag) => <View key={tag} style={styles.garmentTag}><Text style={styles.garmentTagText}>{tag}</Text></View>)}</View></View>
      </View>)}
    </View>;
    if (card.type === 'directions') {
      const enabled = !busy && (!state || (!state.chosen_direction_id && (state.pending_action?.type === 'choose_direction' || (state.pending_action === undefined && state.stage === 'direction'))));
      return <View key={card.id} style={styles.card}>
        <CardHeading icon="compass-outline" title="找一个心动的方向" detail={`${card.options.length} 个提案`} />
        <Text style={styles.intro}>选一个最像你的，也可以在对话里聊聊想法。</Text>
        {card.options.map((option) => <DirectionOption key={option.id} direction={option} selected={state?.chosen_direction_id === option.id} enabled={enabled} onPress={() => onAction({ type: 'choose_direction', direction_id: option.id })} />)}
      </View>;
    }
    if (card.type === 'script') {
      const confirmed = state?.script?.status === 'confirmed' || card.status === 'confirmed';
      const canConfirm = !busy && !confirmed && (!state || state.pending_action?.type === 'confirm_script' || (state.pending_action === undefined && state.stage === 'script'));
      return <View key={card.id} style={styles.card}>
        <CardHeading icon="reader-outline" title="这次，我们这样拍" detail={confirmed ? '已确认' : '脚本草稿'} />
        <ScriptHistory versions={state?.script_versions} busy={busy} generating={Boolean(state?.active_jobs.length)} onAction={onAction} />
        <Text style={styles.sectionLabel}>标题灵感</Text>
        {card.title_ideas.map((title, index) => <Text key={`${index}-${title}`} style={styles.scriptTitle}><Text style={styles.scriptNumber}>{String(index + 1).padStart(2, '0')}  </Text>{title}</Text>)}
        <View style={styles.coverBrief}><Text style={styles.coverHeading}>封面计划</Text><Text style={styles.coverBody}>{card.cover.scene} · {card.cover.pose}</Text>{card.cover.text_overlay ? <Text style={styles.coverOverlay}>封面字：{card.cover.text_overlay}</Text> : null}</View>
        <Text style={styles.sectionLabel}>分镜与画面</Text>
        {card.shots.map((shot, index) => <View key={shot.id} style={styles.shotRow}><View style={styles.shotNumber}><Text style={styles.shotNumberText}>{String(index + 1).padStart(2, '0')}</Text></View><View style={styles.shotContent}><Text style={styles.shotScene}>{shot.scene}</Text><Text style={styles.shotDetail}>{shot.pose} · {shot.camera}</Text><Text style={styles.shotCaption}>{shot.caption}</Text></View></View>)}
        {card.video?.prompt ? <View style={styles.scriptVideo}><Icon name="videocam-outline" size={14} color="#9A806D" /><View style={styles.shotContent}><Text style={styles.coverHeading}>{card.video.duration} 秒短片灵感</Text><Text style={styles.shotDetail}>{card.video.prompt}</Text></View></View> : null}
        <View style={styles.scriptFooter}><Icon name="information-circle-outline" size={14} /><Text style={styles.smallText}>{confirmed ? '脚本已确认，画面正在按计划制作。' : '确认后开始生成图片，想调整也可以继续聊。'}</Text></View>
        <Button title={confirmed ? '脚本已确认' : '确认脚本，开始出图'} icon="checkmark" onPress={() => onAction({ type: 'confirm_script' })} disabled={!canConfirm} testID="confirm-script" />
      </View>;
    }
    if (card.type === 'video') {
      const video = state?.video ?? card;
      const done = video.status === 'succeeded' && Boolean(video.url);
      return <View key={card.id} style={styles.card}>
        <CardHeading icon="videocam-outline" title={done ? '穿搭，会动了' : '你的穿搭短片'} detail="5s" />
        {done && video.url ? <VideoPlayer uri={video.url} posterUrl={video.poster_url} /> : <View style={styles.videoWaiting}>
          {video.poster_url ? <Image source={{ uri: video.poster_url }} style={styles.videoPoster} /> : null}
          <View style={styles.videoWaitingContent}>{video.status === 'failed' ? <Icon name="alert-circle-outline" size={28} color={colors.red} /> : <ActivityIndicator color={colors.red} />}<Text style={styles.videoWaitingTitle}>{video.status === 'failed' ? '视频这次没能完成' : video.status === 'queued' ? '短片已加入队列' : '正在让画面动起来'}</Text><Text style={styles.smallText}>{video.status === 'failed' ? '别担心，笔记和图片都还在。' : '可以先看笔记，视频好了会出现在这里。'}</Text></View>
        </View>}
        {video.status === 'failed' ? <VideoRetry state={state} busy={busy} onAction={onAction} /> : null}
        {done ? <Text style={styles.videoReadyHint}>点击播放，看看这份灵感的另一面。</Text> : null}
      </View>;
    }
    return null;
  })}</View>;
}

const styles = StyleSheet.create({
  cards: { gap: 14 },
  card: { backgroundColor: '#FFFFFF', borderRadius: 16, padding: 16, borderWidth: 1, borderColor: '#EFEAE6', overflow: 'hidden' },
  heading: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 14 },
  headingIcon: { width: 29, height: 29, backgroundColor: colors.pink, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  headingTitle: { fontSize: 15, fontWeight: '700', color: colors.ink, flex: 1 },
  headingDetail: { fontSize: 10, color: colors.muted, letterSpacing: 0.6 },
  intro: { fontSize: 12, color: colors.muted, lineHeight: 20, marginBottom: 13 },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  button: { minHeight: 45, borderRadius: 12, backgroundColor: colors.red, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 7, paddingHorizontal: 12 },
  buttonText: { color: '#FFFFFF', fontSize: 13, fontWeight: '700' },
  secondaryButton: { backgroundColor: '#FFFFFF', borderColor: '#E8E1DB', borderWidth: 1 },
  secondaryButtonText: { color: colors.ink },
  disabledButton: { opacity: 0.38 },
  pressed: { opacity: 0.78 },
  garmentRow: { flexDirection: 'row', gap: 12, marginBottom: 10, alignItems: 'center' },
  garmentImage: { width: 82, height: 98, borderRadius: 11, backgroundColor: colors.cream },
  garmentInfo: { flex: 1 },
  garmentTitle: { color: colors.ink, fontSize: 14, fontWeight: '600', marginBottom: 5 },
  garmentMaterial: { color: colors.muted, fontSize: 12, lineHeight: 20, marginBottom: 7 },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  garmentTag: { backgroundColor: colors.cream, paddingHorizontal: 7, paddingVertical: 4, borderRadius: 5 },
  garmentTagText: { fontSize: 10, color: '#817466' },
  direction: { borderWidth: 1, borderColor: colors.line, backgroundColor: '#FDFCFB', padding: 13, borderRadius: 12, marginBottom: 10 },
  directionSelected: { borderColor: '#FBA9B4', backgroundColor: '#FFF7F8' },
  directionPreview: { height: 142, borderRadius: 8, overflow: 'hidden', backgroundColor: '#F3EDE5', marginBottom: 13 },
  previewImage: { width: '100%', height: '100%' },
  previewPlaceholder: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 12, gap: 9 },
  previewStatus: { fontSize: 11, lineHeight: 18, color: '#A18B78', textAlign: 'center' },
  previewLabel: { position: 'absolute', bottom: 8, left: 8, backgroundColor: '#FFFFFFE8', borderRadius: 4, paddingHorizontal: 7, paddingVertical: 4 },
  previewLabelText: { fontSize: 9, color: '#8F7965' },
  directionName: { fontSize: 15, fontWeight: '700', color: colors.ink, flex: 1 },
  directionScene: { fontSize: 11, color: '#9A7A68', marginTop: 7, marginBottom: 8 },
  directionWhy: { fontSize: 12, lineHeight: 20, color: '#746F6A' },
  radio: { width: 19, height: 19, borderRadius: 10, borderWidth: 1, borderColor: '#DFD8D1', alignItems: 'center', justifyContent: 'center' },
  radioSelected: { borderColor: colors.red, backgroundColor: colors.red },
  palette: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 9 },
  paletteText: { flex: 1, fontSize: 10, color: colors.muted },
  sampleTitle: { fontSize: 11, color: '#9B8F85', lineHeight: 18, marginTop: 8 },
  directionAction: { fontSize: 11, fontWeight: '600', color: colors.red, marginTop: 12 },
  sectionLabel: { color: '#A08D7D', fontSize: 10, letterSpacing: 1.3, marginBottom: 10 },
  scriptTitle: { fontSize: 13, lineHeight: 22, color: colors.ink, marginBottom: 7, fontWeight: '500' },
  scriptNumber: { fontSize: 10, color: '#BBAC9E' },
  coverBrief: { backgroundColor: colors.cream, padding: 12, borderRadius: 10, marginVertical: 14 },
  coverHeading: { fontSize: 11, color: '#8F7865', fontWeight: '600', marginBottom: 5 },
  coverBody: { fontSize: 12, lineHeight: 20, color: '#696057' },
  coverOverlay: { fontSize: 11, color: '#9A8C7F', marginTop: 7, lineHeight: 18 },
  shotRow: { flexDirection: 'row', gap: 10, marginBottom: 15 },
  shotNumber: { width: 25, height: 25, borderRadius: 8, backgroundColor: '#F8F5F1', justifyContent: 'center', alignItems: 'center' },
  shotNumberText: { color: '#AD9B89', fontSize: 10, fontWeight: '600' },
  shotContent: { flex: 1 },
  shotScene: { fontSize: 12, fontWeight: '600', color: colors.ink, marginBottom: 4 },
  shotDetail: { fontSize: 11, color: colors.muted, lineHeight: 18 },
  shotCaption: { fontSize: 11, color: '#A18D7B', lineHeight: 18, marginTop: 3 },
  scriptFooter: { flexDirection: 'row', gap: 5, marginBottom: 13, alignItems: 'center' },
  scriptVideo: { flexDirection: 'row', gap: 8, backgroundColor: '#FAF8F5', padding: 11, borderRadius: 10, marginBottom: 15 },
  smallText: { color: colors.muted, fontSize: 10, lineHeight: 16, flexShrink: 1 },
  imageGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  imageTile: { width: '48%', flexGrow: 1, maxWidth: '49%', marginBottom: 8 },
  imageFrame: { width: '100%', aspectRatio: 0.73, backgroundColor: colors.cream, borderRadius: 11, overflow: 'hidden', borderWidth: 2, borderColor: 'transparent' },
  imageFrameSelected: { borderColor: colors.red },
  generatedImage: { width: '100%', height: '100%' },
  generating: { alignItems: 'center', justifyContent: 'center', flex: 1, padding: 9 },
  generatingTitle: { fontSize: 11, fontWeight: '600', color: '#817366', marginTop: 11 },
  generatingDetail: { fontSize: 9, lineHeight: 15, textAlign: 'center', color: '#B0A193', marginTop: 5 },
  progressTrack: { backgroundColor: '#EAE0D7', height: 3, borderRadius: 3, width: '65%', marginTop: 13 },
  progressFill: { backgroundColor: '#D2B7A1', width: '60%', height: 3, borderRadius: 3 },
  selectionBadge: { position: 'absolute', top: 7, right: 7, width: 22, height: 22, borderRadius: 11, borderWidth: 1.5, borderColor: '#FFFFFF', backgroundColor: '#00000022', alignItems: 'center', justifyContent: 'center' },
  selectionBadgeSelected: { backgroundColor: colors.red, borderColor: colors.red },
  selectionBadgeText: { color: '#FFFFFF', fontSize: 11, fontWeight: '700' },
  versionBadge: { position: 'absolute', bottom: 7, left: 7, paddingHorizontal: 6, paddingVertical: 3, backgroundColor: '#FFFFFFE8', borderRadius: 4 },
  versionText: { fontSize: 8, color: '#776A61', fontWeight: '600' },
  imageCaptionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 9 },
  imageCaption: { fontSize: 10, color: '#726A63', fontWeight: '500' },
  editButton: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingVertical: 3 },
  editText: { color: colors.red, fontSize: 10 },
  instruction: { color: '#A3968A', fontSize: 9, lineHeight: 15, marginTop: 4 },
  versionHint: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 12 },
  sortSection: { borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 13, marginTop: 4, marginBottom: 13 },
  sortTitle: { fontSize: 11, color: colors.ink, fontWeight: '600' },
  sortRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 9 },
  sortNumber: { fontSize: 10, color: '#B6A89B', width: 15 },
  sortThumbnail: { width: 30, height: 36, borderRadius: 5, backgroundColor: colors.cream },
  sortLabel: { fontSize: 11, color: '#736B64', flex: 1 },
  sortArrow: { width: 28, height: 30, borderRadius: 7, backgroundColor: '#F8F5F1', alignItems: 'center', justifyContent: 'center' },
  dimmed: { opacity: 0.25 },
  modalShade: { flex: 1, backgroundColor: '#241C1959', alignItems: 'center', justifyContent: 'center', padding: 24 },
  modal: { backgroundColor: '#FFFFFF', borderRadius: 20, padding: 20, width: '100%', maxWidth: 430, maxHeight: '95%', flexShrink: 1 },
  modalTitle: { fontSize: 17, fontWeight: '700', color: colors.ink, marginBottom: 12 },
  editPreview: { width: 74, height: 94, borderRadius: 10, backgroundColor: colors.cream, marginBottom: 13 },
  editInput: { minHeight: 110, borderRadius: 12, padding: 13, paddingTop: 13, backgroundColor: '#F9F6F3', borderColor: '#EFE9E3', borderWidth: 1, fontSize: 13, color: colors.ink, textAlignVertical: 'top', lineHeight: 22, marginBottom: 16 },
  quickEdits: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginBottom: 16 },
  quickEdit: { borderWidth: 1, borderColor: '#E9DFD5', borderRadius: 14, paddingHorizontal: 10, paddingVertical: 8, backgroundColor: '#FCFAF7' },
  quickEditText: { color: '#8B7562', fontSize: 11 },
  noteTitle: { fontSize: 19, color: colors.ink, fontWeight: '700', lineHeight: 29, marginBottom: 12 },
  noteBody: { fontSize: 12, color: '#7E756F', lineHeight: 22, marginBottom: 12 },
  noteTag: { color: '#B28F73', fontSize: 11, lineHeight: 19, marginBottom: 10 },
  videoPrompt: { borderTopColor: colors.line, borderTopWidth: 1, marginTop: 18, paddingTop: 17 },
  videoRetry: { marginTop: 16, gap: 8 },
  optional: { color: '#A89C90', fontSize: 9 },
  videoSources: { gap: 8, paddingBottom: 12 },
  videoSource: { borderWidth: 2, borderColor: 'transparent', padding: 2, borderRadius: 9 },
  videoSourceSelected: { borderColor: colors.red },
  videoSourceImage: { width: 61, height: 79, borderRadius: 5, backgroundColor: colors.cream },
  sourcePlaceholder: { alignItems: 'center', justifyContent: 'center' },
  sourceCheck: { position: 'absolute', bottom: 6, right: 6, backgroundColor: colors.red, width: 16, height: 16, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  videoWaiting: { minHeight: 215, borderRadius: 12, overflow: 'hidden', backgroundColor: colors.cream, justifyContent: 'center', alignItems: 'center' },
  videoPoster: { position: 'absolute', width: '100%', height: '100%', opacity: 0.16 },
  videoWaitingContent: { padding: 22, alignItems: 'center' },
  videoWaitingTitle: { fontSize: 14, fontWeight: '600', color: '#7B6D61', marginTop: 14, marginBottom: 8 },
  videoReadyHint: { fontSize: 11, color: colors.muted, marginTop: 12, textAlign: 'center' },
});
