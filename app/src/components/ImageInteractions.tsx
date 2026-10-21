import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown, FadeOutDown, ReduceMotion } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { Action, NoteData, OutfitImage, PendingAction, ScriptData, Stage } from '../api/types';
import { ApiError } from '../api/client';
import { approveImages, defaultImageIds, isUnverified, isUsable, replaceShotVersion } from '../lib/imageSelection';
import { coverFirstImageIds } from '../lib/images';
import { rejectedResult } from '../lib/editAttempt';
import { feedback } from '../lib/haptics';
import { saveImages } from '../lib/media';
import { colors, layout, motion, radius, space, type as typography } from '../theme';
import { previewUrl } from '../lib/previewUrl';
import { ImageViewer } from './ImageViewer';
import { Badge, Button, FadeImage, Toast, errorText } from './ui';

type Mode = 'view' | 'local' | 'whole' | 'compare';
type Interaction = {
  open: (id: string, mode?: Mode) => void;
  menu: (id: string) => void;
  selectedIds: string[];
  setSelected: (ids: string[]) => void;
  confirmImage: (image: OutfitImage) => Promise<boolean>;
  approve: (ids: string[]) => Promise<unknown>;
};
const ImageContext = createContext<Interaction>({ open: () => {}, menu: () => {}, selectedIds: [], setSelected: () => {}, confirmImage: async () => false, approve: async () => false });
export const useImageInteractions = () => useContext(ImageContext);

export function ImageInteractions({ images, editActions, busy, canEdit = true, stage, note, script, pendingAction, onAction, onReference, onVisibilityChange, onStartNew, children }: {
  images: OutfitImage[];
  editActions?: Extract<Action, { type: 'edit_image' }>[];
  busy?: boolean;
  canEdit?: boolean;
  stage?: Stage;
  note?: NoteData;
  script?: ScriptData;
  pendingAction?: PendingAction | null;
  onAction: (action: Action) => Promise<unknown> | void;
  onReference: (image: OutfitImage) => void;
  onVisibilityChange?: (visible: boolean) => void;
  onStartNew?: () => void;
  children: ReactNode;
}) {
  const [viewer, setViewer] = useState<{ id: string; mode: Mode }>();
  const [menuId, setMenuId] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const source = `${stage ?? 'images'}:${JSON.stringify(note?.image_ids ?? [])}`;
  const [selection, setSelection] = useState<{ source: string; ids: string[] }>();
  const selectedIds = coverFirstImageIds((selection?.source === source ? selection.ids : defaultImageIds(images, note)).filter(id => images.some(image => image.id === id && isUsable(image))), images, script);
  const accepted = useRef(new Set<string>());
  const [confirmation, setConfirmation] = useState<{ reason: string; resolve: (value: boolean) => void }>();
  const confirmationRef = useRef(confirmation);
  useEffect(() => { confirmationRef.current = confirmation; }, [confirmation]);
  useEffect(() => () => { confirmationRef.current?.resolve(false); }, []);
  const setSelected = (ids: string[]) => setSelection({ source, ids: coverFirstImageIds(ids, images, script) });
  const confirm = (reason: string) => new Promise<boolean>(resolve => setConfirmation({ reason, resolve }));
  const finishConfirmation = (value: boolean) => { confirmation?.resolve(value); setConfirmation(undefined); };
  async function confirmImage(image: OutfitImage) {
    if (!isUnverified(image) || accepted.current.has(image.id) || note?.accepted_unverified_ids?.includes(image.id)) return true;
    if (!await confirm(image.edit_check?.reason || '这一版还没核对通过。')) return false;
    accepted.current.add(image.id);
    return true;
  }
  async function submitAction(action: Action): Promise<unknown> {
    try { return await onAction(action); }
    catch (error) {
      if (action.type !== 'approve_images' || !(error instanceof ApiError) || error.code !== 'unverified_image') throw error;
      if (!await confirm(error.message)) return false;
      const ids = [...new Set([...(action.accept_unverified ?? []), ...action.image_ids])];
      ids.forEach(id => accepted.current.add(id));
      return onAction({ ...action, accept_unverified: ids });
    }
  }
  async function approve(ids: string[]) {
    for (const id of ids) {
      const image = images.find(item => item.id === id);
      if (image && !await confirmImage(image)) return false;
    }
    return submitAction(approveImages(coverFirstImageIds(ids, images, script), images, [...accepted.current, ...(note?.accepted_unverified_ids ?? [])]));
  }
  async function adopt(image: OutfitImage) {
    if (!canEdit || busy || !await confirmImage(image)) return false;
    // 笔记写好以后（含短片阶段）改图：直接换进笔记；更早的阶段只是先选上。
    const inNote = ['note', 'video', 'done'].includes(stage ?? '');
    const ids = replaceShotVersion(inNote ? note?.image_ids ?? [] : selectedIds, image, images);
    if (inNote) {
      const result = await approve(ids);
      if (!rejectedResult(result)) setNotice('已采用到笔记');
      return result;
    }
    setSelected(ids);
    setNotice('已选这版，选好后生成笔记');
    return true;
  }
  const menuImage = images.find(image => image.id === menuId);
  const visible = Boolean(viewer || menuId || confirmation);
  useEffect(() => { onVisibilityChange?.(visible); }, [visible, onVisibilityChange]);
  const open = (id: string, mode: Mode = 'view') => {
    if (!images.some(image => image.id === id && image.url && image.status === 'succeeded')) return;
    feedback(); setMenuId(undefined); setViewer({ id, mode });
  };
  const reference = (image: OutfitImage) => {
    feedback(); onReference(image); setMenuId(undefined); setViewer(undefined);
  };
  async function save() {
    if (!menuImage?.url || saving) return;
    feedback(); setSaving(true); setNotice('');
    try {
      const result = await saveImages([{ id: menuImage.id, url: menuImage.url }]);
      if (result.failed.length) throw new Error(result.failed[0].message);
      feedback('success'); setNotice('图片已保存'); setMenuId(undefined);
    } catch (error) { setNotice(errorText(error)); feedback('warning'); }
    finally { setSaving(false); }
  }
  const confirmationOverlay = confirmation ? <View style={[styles.shade, StyleSheet.absoluteFill, styles.confirmationOverlay]}>
    <View testID="unverified-confirmation" accessibilityViewIsModal style={[styles.sheet, { padding: space.xl, gap: space.lg, paddingBottom: space.xxl }]}>
      <Text style={styles.title}>这版未改到位，仍然采用？</Text>
      <Text testID="unverified-reason" style={styles.confirmationReason}>{confirmation.reason}</Text>
      <Text style={styles.detail}>确认后，这张会用来写笔记和发布。</Text>
      <Button title="仍然采用" testID="confirm-unverified" onPress={() => finishConfirmation(true)} />
      <Button title="先不采用" variant="secondary" testID="cancel-unverified" onPress={() => finishConfirmation(false)} />
    </View>
  </View> : undefined;
  return <ImageContext.Provider value={{ open, menu: id => { feedback(); setNotice(''); setMenuId(id); }, selectedIds, setSelected, confirmImage, approve }}>
    {children}
    {notice ? <Pressable testID="image-feedback" accessibilityRole="button" accessibilityLabel="关闭图片提示" onPress={() => setNotice('')} style={styles.toast}><Toast text={notice} tone={notice.startsWith('已') || notice === '图片已保存' ? 'success' : 'danger'} onDismiss={() => setNotice('')} /></Pressable> : null}
    {viewer ? <ImageViewer images={images} script={script} editActions={editActions} initialImageId={viewer.id} initialMode={viewer.mode} busy={busy} canEdit={canEdit} stage={stage} pendingAction={pendingAction} onStartNew={onStartNew ? () => { setViewer(undefined); onStartNew(); } : undefined} adoptedImageIds={stage === 'note' ? note?.image_ids : selectedIds} onAdopt={canEdit && (stage === 'images' || stage === 'note' || !stage) ? adopt : undefined} confirmationOverlay={confirmationOverlay} onDismissConfirmation={() => finishConfirmation(false)} onClose={() => setViewer(undefined)} onAction={submitAction} onReference={reference} /> : null}
    <Modal transparent visible={Boolean(menuImage)} animationType="fade" onRequestClose={() => setMenuId(undefined)}>
      <View style={styles.shade}>
        <Pressable accessibilityRole="button" accessibilityLabel="关闭图片菜单" style={StyleSheet.absoluteFill} onPress={() => { if (!saving) setMenuId(undefined); }} />
        <Animated.View entering={FadeInDown.duration(motion.normal).reduceMotion(ReduceMotion.System)} exiting={FadeOutDown.duration(motion.fast).reduceMotion(ReduceMotion.System)} style={styles.sheet}>
        <SafeAreaView edges={['bottom']} testID="image-menu">
          <View style={styles.handle} />
          <View style={styles.titleRow}>{menuImage?.url ? <FadeImage source={{ uri: previewUrl(menuImage.url, 360) }} style={styles.thumbnail} /> : null}<View style={styles.heading}><Text style={styles.title}>这张图，接着怎么改？</Text><View style={styles.metadata}><Badge label={`v${menuImage?.version ?? 1}`} /><Text style={styles.detail}>原版和新版本都会保留</Text></View></View></View>
          {(['local', 'whole', 'reference', 'compare', 'save'] as const).map(key => {
            const labels = { local: '局部改', whole: '整张改', reference: '引用到对话', compare: '对比版本', save: saving ? '正在保存…' : '保存到相册' };
            const icons = { local: 'brush-outline', whole: 'color-wand-outline', reference: 'chatbubble-ellipses-outline', compare: 'git-compare-outline', save: 'download-outline' } as const;
            const disabled = saving || ((key === 'local' || key === 'whole') && (!canEdit || Boolean(busy))) || (key === 'compare' && !menuImage?.parent_id);
            return <Pressable key={key} testID={`image-menu-${key}`} accessibilityRole="button" accessibilityLabel={labels[key]} accessibilityState={{ disabled }} disabled={disabled} onPress={() => {
              if (!menuImage) return;
              if (key === 'reference') reference(menuImage);
              else if (key === 'save') void save();
              else open(menuImage.id, key);
            }} style={({ pressed }) => [styles.option, disabled && styles.disabled, pressed && styles.optionPressed]}>{key === 'save' && saving ? <ActivityIndicator size="small" color={colors.red} /> : <View style={styles.optionIcon}><Ionicons name={icons[key]} size={20} color={colors.ink} /></View>}<Text style={styles.optionText}>{labels[key]}</Text><Ionicons name="chevron-forward" size={16} color={colors.muted} /></Pressable>;
          })}
          {notice ? <Toast text={notice} tone="danger" onDismiss={() => setNotice('')} /> : null}
          <Pressable accessibilityRole="button" accessibilityLabel="取消图片菜单" disabled={saving} onPress={() => setMenuId(undefined)} style={({ pressed }) => [styles.cancelButton, pressed && styles.optionPressed]}><Text style={styles.cancel}>取消</Text></Pressable>
        </SafeAreaView>
        </Animated.View>
      </View>
    </Modal>
    {confirmation && !viewer ? <Modal visible transparent animationType="fade" onRequestClose={() => finishConfirmation(false)}>
      {confirmationOverlay}
    </Modal> : null}
  </ImageContext.Provider>;
}

const styles = StyleSheet.create({
  shade: { flex: 1, justifyContent: 'flex-end', backgroundColor: colors.overlay },
  sheet: { backgroundColor: colors.white, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, paddingHorizontal: space.lg, width: '100%', maxWidth: layout.maxWidth, alignSelf: 'center' },
  handle: { width: 36, height: space.xs, borderRadius: radius.sm, backgroundColor: colors.border, alignSelf: 'center', marginTop: space.md, marginBottom: space.lg },
  titleRow: { flexDirection: 'row', gap: space.md, alignItems: 'center', paddingBottom: space.lg },
  thumbnail: { width: 48, aspectRatio: layout.thumbnailRatio, borderRadius: radius.sm, backgroundColor: colors.imagePlaceholder },
  heading: { flex: 1, gap: space.sm },
  title: { ...typography.subtitle, fontWeight: '700', color: colors.ink },
  metadata: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, alignItems: 'center' },
  detail: { ...typography.caption, color: colors.muted },
  confirmationReason: { ...typography.body, color: colors.ink },
  confirmationOverlay: { zIndex: 1000 },
  option: { minHeight: 56, flexDirection: 'row', gap: space.md, alignItems: 'center', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, paddingVertical: space.sm, paddingHorizontal: space.xs, borderRadius: radius.sm },
  optionIcon: { width: 32, height: 32, backgroundColor: colors.paper, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm },
  optionText: { ...typography.body, color: colors.ink, flex: 1 },
  optionPressed: { backgroundColor: colors.paper, transform: [{ scale: .99 }] },
  disabled: { opacity: .35 },
  cancelButton: { minHeight: 52, alignItems: 'center', justifyContent: 'center', marginVertical: space.sm, backgroundColor: colors.paper, borderRadius: radius.sm },
  cancel: { ...typography.label, textAlign: 'center', color: colors.muted },
  toast: { position: 'absolute', bottom: 100, left: space.lg, right: space.lg, zIndex: 50, minHeight: layout.touch },
});
