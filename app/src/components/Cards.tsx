import { Ionicons } from '@expo/vector-icons';
import { useMemo, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { colors, space, radius, layout, type as typography } from '../theme';
import type { Action, Card, Direction, OutfitImage, ProjectState } from '../api/types';
import { feedback } from '../lib/haptics';
import { confirmationCost, formatPoints, pointsValue, REGENERATE_DIRECTIONS_TEXT } from '../lib/transparency';
import { isUnverified, replaceShotVersion } from '../lib/imageSelection';
import { previewUrl } from '../lib/previewUrl';
import { AnimatedEntry, Badge, Button as ActionButton, FadeImage, ProgressStrip, Skeleton } from './ui';
import { VideoPlayer } from './VideoPlayer';
import { FidelityBadge, ImageRevisionInfo, NoteDisclosure } from './GenerationInfo';
import { ScriptHistory } from './ScriptHistory';
import { useImageInteractions } from './ImageInteractions';
import { CostEstimate } from './CostEstimate';
import { SaveAsModel } from './SaveAsModel';

type CardsProps = {
  cards: Card[];
  state?: ProjectState;
  busy?: boolean;
  onAction: (action: Action) => void;
  onText: (text: string) => void;
  onPreview: () => void;
};

type IconName = React.ComponentProps<typeof Ionicons>['name'];
function Icon({ name, size = 16, color = colors.muted }: { name: IconName; size?: number; color?: string }) {
  return <Ionicons name={name} size={size} color={color} />;
}

function CardHeading({ icon, title, detail }: { icon: IconName; title: string; detail?: string }) {
  return (
    <View style={styles.heading}>
      <View style={styles.headingIcon}><Icon name={icon} color={colors.red} size={17} /></View>
      <Text style={styles.headingTitle}>{title}</Text>
      {detail ? <Badge label={detail} /> : null}
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
  return <ActionButton title={title} onPress={onPress} disabled={disabled} testID={testID} variant={secondary ? 'secondary' : 'primary'} icon={icon} />;
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
          {selected ? <Icon name="checkmark" size={12} color={colors.white} /> : null}
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
      <FadeImage source={{ uri: previewUrl(url) }} style={styles.previewImage} resizeMode="cover" accessibilityLabel={`${direction.name}灵感预览`} testID={`preview-image-${direction.id}`} onLoad={() => setLoadedUrl(url)} onError={() => setFailedUrl(url)} />
      {loadedUrl !== url ? <View style={StyleSheet.absoluteFill}><Skeleton width="100%" height="100%" /></View> : null}
      <View style={styles.previewLabel}><Badge label="灵感预览" /></View>
    </> : <View style={styles.previewPlaceholder} testID={`preview-placeholder-${direction.id}`}>
      {failed || !direction.preview_status ? <Icon name={failed ? 'image-outline' : 'color-palette-outline'} color={colors.muted} size={24} /> : null}
      {!failed && direction.preview_status ? <ProgressStrip title={running ? '正在描绘这份灵感…' : '灵感图已排队，马上开始'} /> : <Text style={styles.previewStatus}>{failed ? '灵感图暂时没成功，可先按文字选方向' : '灵感预览暂未提供'}</Text>}
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

function ImageGrid({ items, state, busy }: {
  items: OutfitImage[];
  state?: ProjectState;
  busy?: boolean;
  onAction: (action: Action) => void;
}) {
  const images = useImageVersions(items, state);
  const interaction = useImageInteractions();
  const latest = new Map<string, OutfitImage>();
  for (const item of images) {
    const previous = latest.get(item.shot_id);
    if (!previous || item.version > previous.version) latest.set(item.shot_id, item);
  }
  const successful = images.filter((item) => item.status === 'succeeded' && item.url);
  const validIds = new Set(successful.map((item) => item.id));
  const selected = interaction.selectedIds.filter((id) => validIds.has(id));
  const isGenerating = images.some((item) => item.status === 'queued' || item.status === 'running');
  const automatic = state?.mode === 'auto';
  const canEdit = !automatic && !busy && (!state || state.stage === 'images' || state.stage === 'note');
  const canApprove = !automatic && !busy && !isGenerating && selected.length > 0 && (!state || state.stage === 'images' || state.stage === 'note');
  const shotIds = [...new Set(images.map((item) => item.shot_id))];
  const latestDone = [...latest.values()].filter((item) => item.status === 'succeeded').length;

  const toggle = async (id: string) => {
    feedback();
    const image = images.find(item => item.id === id);
    if (!selected.includes(id) && image && !await interaction.confirmImage(image)) return;
    interaction.setSelected(selected.includes(id) ? selected.filter((value) => value !== id)
      : image && state?.stage === 'note' ? replaceShotVersion(selected, image, images) : [...selected, id]);
  };
  const move = (id: string, offset: number) => {
    const index = selected.indexOf(id);
    const nextIndex = index + offset;
    if (!canEdit || index < 0 || nextIndex < 0 || nextIndex >= selected.length) return;
    feedback();
    const next = [...selected];
    [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
    interaction.setSelected(next);
  };

  return (
    <View style={styles.card}>
      <CardHeading icon="images-outline" title="你的穿搭影像" detail={`${latestDone}/${latest.size} 已完成`} />
      <Text style={styles.intro}>{isGenerating ? '正在把灵感变成画面，完成的图片会陆续出现。' : automatic ? '画面已出好，点图放大看细节。' : '点图放大看细节，长按可修改或引用。点右上角选图，再排发布顺序。'}</Text>
      <View style={styles.imageGrid}>
        {images.map((item) => {
          const selectedIndex = selected.indexOf(item.id);
          const isLatest = latest.get(item.shot_id)?.id === item.id;
          return (
            <View key={item.id} style={styles.imageTile}>
              <Pressable
                onPress={() => interaction.open(item.id)}
                onLongPress={automatic ? undefined : () => interaction.menu(item.id)}
                delayLongPress={400}
                disabled={item.status !== 'succeeded' || !item.url}
                accessibilityRole="button"
                accessibilityLabel={`查看镜头 ${shotIds.indexOf(item.shot_id) + 1} 第 ${item.version} 版`}
                testID={`image-select-${item.id}`}
                style={({ pressed }) => [styles.imageFrame, selectedIndex >= 0 && styles.imageFrameSelected, pressed && styles.pressed]}
              >
                {item.url && item.status === 'succeeded' ? <FadeImage source={{ uri: previewUrl(item.url) }} style={styles.generatedImage} resizeMode="cover" accessibilityLabel={`穿搭镜头 ${shotIds.indexOf(item.shot_id) + 1}`} /> : (
                  <View style={styles.generating}>
                    {item.status === 'failed' ? <><Icon name="alert-circle-outline" color={colors.danger} size={26} /><Text style={styles.generatingTitle}>这张暂时没成功</Text><Text style={styles.generatingDetail}>{item.error ?? '在对话里告诉我，我们再试一次'}</Text></> : <ProgressStrip title={item.status === 'running' ? '画面生成中' : '等待生成'} detail={item.status === 'running' ? '好看的细节，值得等一等' : '马上就轮到这一张'} />}
                  </View>
                )}
                {item.status === 'succeeded' && !automatic ? <Pressable accessibilityRole="button" accessibilityLabel={`选择镜头 ${shotIds.indexOf(item.shot_id) + 1} 第 ${item.version} 版`} accessibilityState={{ selected: selectedIndex >= 0 }} testID={`image-toggle-${item.id}`} disabled={busy || !canEdit} onPress={event => { event.stopPropagation(); void toggle(item.id); }} hitSlop={space.sm} style={[styles.selectionBadge, selectedIndex >= 0 && styles.selectionBadgeSelected]}><Text style={styles.selectionBadgeText}>{selectedIndex >= 0 ? selectedIndex + 1 : ''}</Text></Pressable> : null}
                <View style={styles.versionBadge}><Badge label={isLatest ? `v${item.version}${item.version > 1 ? ' 新版' : ''}` : `v${item.version} 原版`} />{isUnverified(item) ? <Badge label="未改到位" tone="danger" /> : null}</View>
                {item.status === 'succeeded' ? <FidelityBadge image={item} /> : null}
              </Pressable>
              <View style={styles.imageCaptionRow}>
                <Text style={styles.imageCaption}>镜头 {String(shotIds.indexOf(item.shot_id) + 1).padStart(2, '0')}{item.script_version ? ` · 脚本 ${item.script_version}` : ''}</Text>
                {item.status === 'succeeded' && canEdit ? <Pressable
                  onPress={() => interaction.open(item.id, 'whole')}
                  accessibilityRole="button"
                  accessibilityLabel={`修改镜头 ${shotIds.indexOf(item.shot_id) + 1}`}
                  testID={`edit-image-${item.id}`}
                  hitSlop={space.sm}
                  style={styles.editButton}
                ><Icon name="create-outline" size={13} color={colors.red} /><Text style={styles.editText}>改一改</Text></Pressable> : null}
              </View>
              <ImageRevisionInfo image={item} />
              <SaveAsModel image={item} />
            </View>
          );
        })}
      </View>
      {images.some((item) => item.parent_id) ? <View style={styles.versionHint}><Icon name="layers-outline" size={13} /><Text style={styles.smallText}>新版和原版都在，随时可以重新选。</Text></View> : null}
      {!automatic && selected.length > 0 ? <View style={styles.sortSection}>
        <View style={styles.rowBetween}><Text style={styles.sortTitle}>笔记图片顺序</Text><Text style={styles.smallText}>已选 {selected.length} 张</Text></View>
        {selected.map((id, index) => {
          const item = successful.find((value) => value.id === id);
          if (!item) return null;
          return <View key={id} style={styles.sortRow}>
            <Text style={[styles.sortNumber, index === 0 && { color: colors.redText }]}>{String(index + 1).padStart(2, '0')}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="查看已选图片" onPress={() => interaction.open(item.id)} onLongPress={() => interaction.menu(item.id)}><FadeImage source={{ uri: item.url }} style={styles.sortThumbnail} /></Pressable>
            <Text style={styles.sortLabel}>{index === 0 ? '封面 · ' : ''}镜头 {shotIds.indexOf(item.shot_id) + 1} <Text style={styles.smallText}>v{item.version}</Text></Text>
            <Pressable onPress={() => move(id, -1)} disabled={index === 0 || !canEdit} accessibilityRole="button" accessibilityLabel={`第 ${index + 1} 张向前移`} testID={`move-up-${id}`} style={[styles.sortArrow, index === 0 && styles.dimmed]}><Icon name="arrow-up" size={15} color={colors.ink} /></Pressable>
            <Pressable onPress={() => move(id, 1)} disabled={index === selected.length - 1 || !canEdit} accessibilityRole="button" accessibilityLabel={`第 ${index + 1} 张向后移`} testID={`move-down-${id}`} style={[styles.sortArrow, index === selected.length - 1 && styles.dimmed]}><Icon name="arrow-down" size={15} color={colors.ink} /></Pressable>
          </View>;
        })}
      </View> : null}
      {!automatic ? <Button title={state?.stage === 'note' ? '采用选图到笔记' : state && state.stage !== 'images' ? '图片已确认' : `选好了，生成笔记${selected.length ? `（${selected.length} 张）` : ''}`} icon="checkmark" onPress={() => { void interaction.approve(selected); }} disabled={!canApprove} testID="approve-images" /> : null}
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
  const interaction = useImageInteractions();
  const [videoImageId, setVideoImageId] = useState<string | null>(null);
  const [reselecting, setReselecting] = useState(false);
  const selectedImageId = videoImageId && note.image_ids.includes(videoImageId) ? videoImageId : note.image_ids[0];
  // 已有短片时，只要服务端把确认挂起来（用户说“再做一条”），同样显示选图确认。
  const mayMakeVideo = state?.pending_action?.type === 'confirm_video' || (state?.mode !== 'auto' && !state?.video && (!state || (state.pending_action === undefined && state.stage === 'note')));
  return <View style={styles.card}>
    <CardHeading icon="document-text-outline" title="笔记写好了" detail="READY TO POST" />
    <Text style={styles.noteTitle}>{note.title}</Text>
    <Text numberOfLines={3} style={styles.noteBody}>{note.body}</Text>
    <View style={styles.tags}>{note.tags.map((tag) => <View key={tag} style={styles.noteTag}><Text style={styles.noteTagText}>#{tag.replace(/^#/, '')}</Text></View>)}</View>
    <NoteDisclosure note={note} projectCost={state?.cost_cny} projectPoints={state?.cost_points} testIDPrefix="card-note" />
    <Button title="打开笔记预览" onPress={onPreview} testID="preview-note" icon="open-outline" />
    {state?.mode !== 'auto' && state?.stage === 'note' ? <>
      <Button title={reselecting ? '收起选图' : '重新选图'} secondary icon="images-outline" disabled={busy} testID="reselect-images" onPress={() => setReselecting(value => !value)} />
      {reselecting ? <ImageGrid items={state.images} state={state} busy={busy} onAction={onAction} /> : null}
    </> : null}
    {mayMakeVideo && note.image_ids.length > 0 ? <View style={styles.videoPrompt}>
      <View style={styles.rowBetween}><Text style={styles.sortTitle}>{state?.video ? '再做一条短片？' : '再让穿搭动起来？'}</Text><Text style={styles.optional}>可选 · 5 秒短视频</Text></View>
      <Text style={styles.intro}>选一张作为视频画面，确认后开始生成。</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.videoSources}>
        {note.image_ids.map((id, index) => {
          const image = state?.images.find((item) => item.id === id);
          return <View key={id} style={[styles.videoSource, id === selectedImageId && styles.videoSourceSelected]}>
            <Pressable accessibilityRole="button" accessibilityLabel={`查看第 ${index + 1} 张视频源图`} testID={`video-source-view-${id}`} onPress={() => interaction.open(id)} onLongPress={() => interaction.menu(id)}>{image?.url ? <FadeImage source={{ uri: previewUrl(image.url, 360) }} style={styles.videoSourceImage} /> : <View style={[styles.videoSourceImage, styles.sourcePlaceholder]}><Icon name="image-outline" size={20} /></View>}</Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel={`选择第 ${index + 1} 张生成视频`} accessibilityState={{ selected: id === selectedImageId }} testID={`video-source-${id}`} onPress={() => { feedback(); setVideoImageId(id); }} style={styles.sourceChoice}><Text style={styles.sourceChoiceText}>{id === selectedImageId ? '✓ 已选' : '选这张'}</Text></Pressable>
          </View>;
        })}
      </ScrollView>
      <CostEstimate state={state} action="confirm_video" />
      <Button title="确认生成短视频" secondary icon="videocam-outline" disabled={Boolean(busy) || !selectedImageId || confirmationCost(state, 'confirm_video')?.insufficient} onPress={() => { if (selectedImageId) onAction({ type: 'confirm_video', image_id: selectedImageId }); }} testID="confirm-video" />
    </View> : null}
  </View>;
}

function VideoRetry({ state, busy, onAction }: {
  state?: ProjectState;
  busy?: boolean;
  onAction: (action: Action) => void;
}) {
  const [chosen, setChosen] = useState<string | null>(null);
  const interaction = useImageInteractions();
  const images = (state?.note?.image_ids ?? []).flatMap((id) => {
    const image = state?.images.find((item) => item.id === id && item.status === 'succeeded' && item.url);
    return image ? [image] : [];
  });
  const selected = images.some((image) => image.id === chosen) ? chosen : images[0]?.id;
  const awaitingConfirmation = state?.pending_action?.type === 'confirm_video' || (state?.pending_action === undefined && state?.stage === 'note');
  if (state?.mode === 'auto' || !awaitingConfirmation) return null;
  return <View style={styles.videoRetry}>
    <Text style={styles.sortTitle}>选一张图片，再试一次</Text>
    <Text style={styles.intro}>图文笔记已经保留，确认后只重新制作短片。</Text>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.videoSources}>
      {images.map((image, index) => <View key={image.id} style={[styles.videoSource, image.id === selected && styles.videoSourceSelected]}>
        <Pressable accessibilityRole="button" accessibilityLabel={`查看第 ${index + 1} 张视频源图`} onPress={() => interaction.open(image.id)} onLongPress={() => interaction.menu(image.id)}><FadeImage source={{ uri: previewUrl(image.url, 360) }} style={styles.videoSourceImage} /></Pressable>
        <Pressable onPress={() => { feedback(); setChosen(image.id); }} disabled={busy} accessibilityRole="button" accessibilityLabel={`选择第 ${index + 1} 张重试视频`} accessibilityState={{ selected: image.id === selected }} testID={`retry-video-source-${image.id}`} style={styles.sourceChoice}><Text style={styles.sourceChoiceText}>{image.id === selected ? '✓ 已选' : '选这张'}</Text></Pressable>
      </View>)}
    </ScrollView>
    <CostEstimate state={state} action="confirm_video" />
    <Button title="确认重试短视频" secondary icon="refresh" disabled={Boolean(busy) || !selected || confirmationCost(state, 'confirm_video')?.insufficient} testID="retry-video" onPress={() => { if (selected) onAction({ type: 'confirm_video', image_id: selected }); }} />
  </View>;
}

function VideoCard({ card, state, busy, onAction }: {
  card: Extract<Card, { type: 'video' }>;
  state?: ProjectState;
  busy?: boolean;
  onAction: (action: Action) => void;
}) {
  const video = state?.video ?? card;
  const done = video.status === 'succeeded' && Boolean(video.url);
  // 对话里只放一行紧凑卡，点了才展开播放，不把聊天内容顶出屏幕。
  const [playing, setPlaying] = useState(false);
  return <View style={styles.card}>
    <CardHeading icon="videocam-outline" title={done ? '穿搭，会动了' : '你的穿搭短片'} detail="5s" />
    {done && video.url ? (playing ? <VideoPlayer uri={video.url} posterUrl={video.poster_url} autoPlay /> : <Pressable
      accessibilityRole="button"
      accessibilityLabel="播放穿搭短视频"
      testID="play-video"
      onPress={() => { feedback(); setPlaying(true); }}
      style={({ pressed }) => [styles.videoCompact, pressed && styles.videoCompactPressed]}
    >
      {video.poster_url ? <FadeImage source={{ uri: previewUrl(video.poster_url, 360) }} style={styles.videoThumb} resizeMode="cover" /> : <View style={styles.videoThumb} />}
      <View style={styles.videoCompactBody}><Text style={styles.videoCompactTitle}>5 秒穿搭短片已出好</Text><Text style={styles.smallText}>轻点播放，完整版在笔记预览里。</Text></View>
      <View style={styles.videoPlayIcon}><Icon name="play" size={18} color={colors.white} /></View>
    </Pressable>) : <View style={styles.videoWaiting}>
      {video.poster_url ? <FadeImage source={{ uri: previewUrl(video.poster_url) }} style={styles.videoPoster} /> : null}
      <View style={styles.videoWaitingContent}>{video.status === 'failed' ? <><Icon name="alert-circle-outline" size={28} color={colors.danger} /><Text style={styles.videoWaitingTitle}>视频这次没能完成</Text><Text style={styles.smallText}>别担心，笔记和图片都还在。</Text></> :
 <ProgressStrip title={video.status === 'queued' ? '短片已加入队列' : '正在让画面动起来'} detail="可以先看笔记，视频好了会出现在这里。" />}</View>
        </View>}
    {video.status === 'failed' ? <VideoRetry state={state} busy={busy} onAction={onAction} /> : null}
  </View>;
}

export function Cards({ cards, state, busy, onAction, onText, onPreview }: CardsProps) {
  return <View style={styles.cards}>{cards.map((card) => {
    if (card.type === 'images') return <ImageGrid key={card.id} items={card.items} state={state} busy={busy} onAction={onAction} />;
    if (card.type === 'note') return <NoteCard key={card.id} card={card} state={state} busy={busy} onAction={onAction} onPreview={onPreview} />;
    if (card.type === 'references') return card.items.length ? <View key={card.id} testID={`references-card-${card.id}`} style={styles.card}>
      <CardHeading icon="images-outline" title="这次的风格参考" detail={`${card.items.length} 张参考图`} />
      <Text style={styles.intro}>从场景、光线和构图里，找到这组画面的氛围。</Text>
      {card.items.map((item, index) => <View key={item.asset_id} testID={`reference-item-${item.asset_id}`} style={styles.garmentRow}>
        <FadeImage source={{ uri: previewUrl(item.url, 360) }} style={styles.garmentImage} resizeMode="cover" accessibilityLabel={`风格参考图 ${index + 1}`} />
        <View style={styles.garmentInfo}><Text style={styles.garmentTitle}>参考图 {String(index + 1).padStart(2, '0')}</Text><View style={styles.tags}>{item.style_tags.map((tag, tagIndex) => <View key={`${tagIndex}-${tag}`} style={styles.garmentTag}><Text style={styles.garmentTagText}>{tag}</Text></View>)}</View></View>
      </View>)}
    </View> : null;
    if (card.type === 'garments') return <View key={card.id} style={styles.card}>
      <CardHeading icon="shirt-outline" title="先认识一下这件衣服" detail={`${card.items.length} 件单品`} />
      {card.items.map((item) => <View key={item.asset_id} style={styles.garmentRow}>
        <FadeImage source={{ uri: previewUrl(item.url, 360) }} style={styles.garmentImage} resizeMode="cover" accessibilityLabel={`${item.color}${item.category}`} />
        <View style={styles.garmentInfo}><Text style={styles.garmentTitle}>{item.color} · {item.category}</Text><Text style={styles.garmentMaterial}>{item.material}</Text><View style={styles.tags}>{item.style_tags.map((tag) => <View key={tag} style={styles.garmentTag}><Text style={styles.garmentTagText}>{tag}</Text></View>)}</View></View>
      </View>)}
    </View>;
    if (card.type === 'directions') {
      const regeneratePoints = pointsValue(card.regenerate_estimate_points, card.regenerate_estimate_cny);
      const enabled = state?.mode !== 'auto' && !busy && (!state || (!state.chosen_direction_id && (state.pending_action?.type === 'choose_direction' || (state.pending_action === undefined && state.stage === 'direction'))));
      return <View key={card.id} style={styles.card}>
        <CardHeading icon="compass-outline" title="找一个心动的方向" detail={`${card.options.length} 个提案`} />
        <Text style={styles.intro}>{state?.mode === 'auto' ? '正在为这组片选出最合适的方向，也可以在对话里聊聊想法。' : '选一个最像你的，也可以在对话里聊聊想法。'}</Text>
        {card.options.map((option) => <DirectionOption key={option.id} direction={option} selected={state?.chosen_direction_id === option.id} enabled={enabled} onPress={() => onAction({ type: 'choose_direction', direction_id: option.id })} />)}
        {state?.mode !== 'auto' ? <Button title="换一组" secondary icon="refresh-outline" disabled={!enabled} testID="regenerate-directions" onPress={() => onText(REGENERATE_DIRECTIONS_TEXT)} /> : null}
        {regeneratePoints !== undefined ? <Text testID="regenerate-estimate" style={styles.intro}>约 {formatPoints(regeneratePoints)} · 含 2–3 张预览</Text> : null}
      </View>;
    }
    if (card.type === 'script') {
      const confirmed = state?.script?.status === 'confirmed' || card.status === 'confirmed';
      const canConfirm = !busy && !confirmed && !confirmationCost(state, 'confirm_script')?.insufficient && (!state || state.pending_action?.type === 'confirm_script' || (state.pending_action === undefined && state.stage === 'script'));
      return <View key={card.id} style={styles.card}>
        <CardHeading icon="reader-outline" title="这次，我们这样拍" detail={confirmed ? '已确认' : '脚本草稿'} />
        {state?.mode !== 'auto' ? <ScriptHistory versions={state?.script_versions} busy={busy} generating={Boolean(state?.active_jobs.length)} onAction={onAction} /> : null}
        <Text style={styles.sectionLabel}>标题灵感</Text>
        {card.title_ideas.map((title, index) => <Text key={`${index}-${title}`} style={styles.scriptTitle}><Text style={styles.scriptNumber}>{String(index + 1).padStart(2, '0')}  </Text>{title}</Text>)}
        <View style={styles.coverBrief}><Text style={styles.coverHeading}>封面计划</Text><Text style={styles.coverBody}>{card.cover.scene} · {card.cover.pose}</Text>{card.cover.text_overlay ? <Text style={styles.coverOverlay}>封面字：{card.cover.text_overlay}</Text> : null}</View>
        <Text style={styles.sectionLabel}>分镜与画面</Text>
        {card.shots.map((shot, index) => <View key={shot.id} style={styles.shotRow}><View style={styles.shotNumber}><Text style={styles.shotNumberText}>{String(index + 1).padStart(2, '0')}</Text></View><View style={styles.shotContent}><Text style={styles.shotScene}>{shot.scene}</Text><Text style={styles.shotDetail}>{shot.pose} · {shot.camera}</Text><Text style={styles.shotCaption}>{shot.caption}</Text></View></View>)}
        {card.video?.prompt ? <View style={styles.scriptVideo}><Icon name="videocam-outline" size={14} color={colors.muted} /><View style={styles.shotContent}><Text style={styles.coverHeading}>{card.video.duration} 秒短片灵感</Text><Text style={styles.shotDetail}>{card.video.prompt}</Text></View></View> : null}
        <View style={styles.scriptFooter}><Icon name="information-circle-outline" size={14} /><Text style={styles.smallText}>{confirmed ? '脚本已确认，画面正在按计划制作。' : state?.mode === 'auto' ? '脚本写好后会接着出图，整套好了会通知你。' : '确认后开始生成图片，想调整也可以继续聊。'}</Text></View>
        {state?.mode !== 'auto' && !confirmed ? <CostEstimate state={state} action="confirm_script" /> : null}
        {state?.mode !== 'auto' ? <Button title={confirmed ? '脚本已确认' : '确认脚本，开始出图'} icon="checkmark" onPress={() => onAction({ type: 'confirm_script' })} disabled={!canConfirm} testID="confirm-script" /> : null}
      </View>;
    }
    if (card.type === 'video') return <VideoCard key={card.id} card={card} state={state} busy={busy} onAction={onAction} />;
    return null;
  }).map((content, index) => content ? <AnimatedEntry key={cards[index].id} delay={index * 50}><View testID={`card-${cards[index].id}`}>{content}</View></AnimatedEntry> : null)}</View>;
}

const styles = StyleSheet.create({
  cards: { gap: space.lg },
  card: { backgroundColor: colors.white, borderRadius: radius.lg, padding: space.lg, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' },
  heading: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginBottom: space.lg, flexWrap: 'wrap' },
  headingIcon: { width: 32, height: 32, backgroundColor: colors.blush, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' },
  headingTitle: { ...typography.subtitle, fontWeight: '700', color: colors.ink, flex: 1, minWidth: 120 },
  intro: { ...typography.caption, color: colors.muted, marginBottom: space.md },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.sm, flexWrap: 'wrap' },
  pressed: { opacity: 0.8, transform: [{ scale: 0.98 }] },
  garmentRow: { flexDirection: 'row', gap: space.md, marginBottom: space.md, alignItems: 'center' },
  garmentImage: { width: 84, aspectRatio: layout.thumbnailRatio, borderRadius: radius.sm, backgroundColor: colors.imagePlaceholder },
  garmentInfo: { flex: 1 },
  garmentTitle: { ...typography.body, color: colors.ink, fontWeight: '600', marginBottom: space.xs },
  garmentMaterial: { ...typography.caption, color: colors.muted, marginBottom: space.sm },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginBottom: space.md },
  garmentTag: { backgroundColor: colors.paper, paddingHorizontal: space.sm, paddingVertical: space.xs, borderRadius: radius.sm },
  garmentTagText: { ...typography.badge, color: colors.muted },
  direction: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, padding: space.md, borderRadius: radius.md, marginBottom: space.md },
  directionSelected: { borderColor: colors.red, backgroundColor: colors.blush },
  directionPreview: { aspectRatio: 1.7, borderRadius: radius.sm, overflow: 'hidden', backgroundColor: colors.imagePlaceholder, marginBottom: space.md },
  previewImage: { width: '100%', height: '100%' },
  previewPlaceholder: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: space.md, gap: space.sm },
  previewStatus: { ...typography.caption, color: colors.muted, textAlign: 'center' },
  previewLabel: { position: 'absolute', bottom: space.sm, left: space.sm },
  directionName: { ...typography.subtitle, fontWeight: '700', color: colors.ink, flex: 1 },
  directionScene: { ...typography.caption, color: colors.redText, marginTop: space.sm, marginBottom: space.sm },
  directionWhy: { ...typography.caption, color: colors.muted },
  radio: { width: 24, height: 24, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  radioSelected: { borderColor: colors.red, backgroundColor: colors.red },
  palette: { flexDirection: 'row', alignItems: 'center', gap: space.xs, marginTop: space.sm },
  paletteText: { flex: 1, ...typography.badge, color: colors.muted },
  sampleTitle: { ...typography.caption, color: colors.muted, marginTop: space.sm },
  directionAction: { ...typography.caption, fontWeight: '600', color: colors.redText, marginTop: space.md },
  sectionLabel: { ...typography.caption, color: colors.muted, fontWeight: '700', marginBottom: space.md },
  scriptTitle: { ...typography.body, color: colors.ink, marginBottom: space.sm, fontWeight: '500' },
  scriptNumber: { ...typography.badge, color: colors.muted },
  coverBrief: { backgroundColor: colors.paper, padding: space.lg, borderRadius: radius.sm, marginVertical: space.lg, borderWidth: 1, borderColor: colors.border },
  coverHeading: { ...typography.caption, color: colors.ink, fontWeight: '700', marginBottom: space.xs },
  coverBody: { ...typography.caption, color: colors.muted },
  coverOverlay: { ...typography.caption, color: colors.redText, marginTop: space.sm },
  shotRow: { flexDirection: 'row', gap: space.md, marginBottom: space.lg, paddingBottom: space.lg, borderBottomWidth: 1, borderBottomColor: colors.border },
  shotNumber: { width: 32, height: 32, borderRadius: radius.sm, backgroundColor: colors.blush, justifyContent: 'center', alignItems: 'center' },
  shotNumberText: { ...typography.badge, color: colors.redText, fontWeight: '700' },
  shotContent: { flex: 1 },
  shotScene: { ...typography.body, fontWeight: '600', color: colors.ink, marginBottom: space.xs },
  shotDetail: { ...typography.caption, color: colors.muted },
  shotCaption: { ...typography.caption, color: colors.muted, marginTop: space.sm, paddingLeft: space.sm, borderLeftWidth: 2, borderLeftColor: colors.border },
  scriptFooter: { flexDirection: 'row', gap: space.sm, marginBottom: space.lg, alignItems: 'center' },
  scriptVideo: { flexDirection: 'row', gap: space.sm, backgroundColor: colors.paper, padding: space.md, borderRadius: radius.sm, marginBottom: space.lg },
  smallText: { ...typography.badge, color: colors.muted, flexShrink: 1 },
  imageGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.md },
  imageTile: { width: '47%', flexGrow: 1, maxWidth: '49%', marginBottom: space.sm },
  imageFrame: { width: '100%', aspectRatio: layout.thumbnailRatio, backgroundColor: colors.imagePlaceholder, borderRadius: radius.sm, overflow: 'hidden', borderWidth: 2, borderColor: 'transparent' },
  imageFrameSelected: { borderColor: colors.red },
  generatedImage: { width: '100%', height: '100%' },
  generating: { alignItems: 'center', justifyContent: 'center', flex: 1, padding: space.sm },
  generatingTitle: { ...typography.caption, fontWeight: '600', color: colors.ink, marginTop: space.md },
  generatingDetail: { ...typography.badge, textAlign: 'center', color: colors.muted, marginTop: space.xs },
  selectionBadge: { position: 'absolute', top: 0, right: 0, width: 44, height: 44, borderBottomLeftRadius: radius.sm, backgroundColor: colors.overlay, alignItems: 'center', justifyContent: 'center' },
  selectionBadgeSelected: { backgroundColor: colors.redText },
  selectionBadgeText: { ...typography.caption, color: colors.white, fontWeight: '700' },
  versionBadge: { position: 'absolute', bottom: space.sm, left: space.sm },
  imageCaptionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.xs },
  imageCaption: { ...typography.badge, color: colors.muted, fontWeight: '500', flex: 1 },
  editButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.xs, minHeight: 44, minWidth: 44 },
  editText: { ...typography.badge, color: colors.redText },
  versionHint: { flexDirection: 'row', alignItems: 'center', gap: space.xs, marginBottom: space.md },
  sortSection: { borderTopWidth: 1, borderTopColor: colors.border, paddingTop: space.lg, marginTop: space.xs, marginBottom: space.lg },
  sortTitle: { ...typography.caption, color: colors.ink, fontWeight: '700' },
  sortRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.sm },
  sortNumber: { ...typography.badge, color: colors.muted, width: 16 },
  sortThumbnail: { width: 44, aspectRatio: layout.thumbnailRatio, borderRadius: radius.sm, backgroundColor: colors.imagePlaceholder },
  sortLabel: { ...typography.caption, color: colors.muted, flex: 1 },
  sortArrow: { width: 44, height: 44, borderRadius: radius.sm, backgroundColor: colors.paper, alignItems: 'center', justifyContent: 'center' },
  dimmed: { opacity: 0.35 },
  noteTitle: { ...typography.heading, color: colors.ink, fontWeight: '700', marginBottom: space.md },
  noteBody: { ...typography.body, color: colors.muted, marginBottom: space.md },
  noteTag: { backgroundColor: colors.blush, borderRadius: radius.sm, paddingHorizontal: space.sm, paddingVertical: space.xs },
  noteTagText: { ...typography.caption, color: colors.redText },
  videoPrompt: { borderTopColor: colors.border, borderTopWidth: 1, marginTop: space.lg, paddingTop: space.lg },
  videoRetry: { marginTop: space.lg, gap: space.sm },
  optional: { ...typography.badge, color: colors.muted },
  videoSources: { gap: space.sm, paddingBottom: space.md },
  videoSource: { borderWidth: 2, borderColor: 'transparent', padding: space.xs, borderRadius: radius.md },
  videoSourceSelected: { borderColor: colors.red },
  videoSourceImage: { width: 72, aspectRatio: layout.thumbnailRatio, borderRadius: radius.sm, backgroundColor: colors.imagePlaceholder },
  sourcePlaceholder: { alignItems: 'center', justifyContent: 'center' },
  sourceChoice: { minHeight: 44, justifyContent: 'center', alignItems: 'center' },
  sourceChoiceText: { ...typography.caption, color: colors.redText },
  videoWaiting: { minHeight: 216, borderRadius: radius.sm, overflow: 'hidden', backgroundColor: colors.paper, justifyContent: 'center', alignItems: 'center' },
  videoPoster: { position: 'absolute', width: '100%', height: '100%', opacity: 0.16 },
  videoWaitingContent: { padding: space.lg, alignItems: 'center', width: '100%' },
  videoWaitingTitle: { ...typography.body, fontWeight: '600', color: colors.ink, marginTop: space.lg, marginBottom: space.sm },
  videoCompact: { flexDirection: 'row', alignItems: 'center', gap: space.md, backgroundColor: colors.paper, borderRadius: radius.md, padding: space.sm },
  videoCompactPressed: { opacity: .85 },
  videoThumb: { width: 64, height: 86, borderRadius: radius.sm, backgroundColor: colors.imagePlaceholder },
  videoCompactBody: { flex: 1, gap: space.xs },
  videoCompactTitle: { ...typography.body, fontWeight: '600', color: colors.ink },
  videoPlayIcon: { width: 40, height: 40, borderRadius: radius.lg, backgroundColor: colors.red, alignItems: 'center', justifyContent: 'center', paddingLeft: space.xs },
});
