import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Image, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { Action, OutfitImage } from '../api/types';
import { feedback } from '../lib/haptics';
import { saveImages } from '../lib/media';
import { ImageViewer } from './ImageViewer';
import { colors, errorText } from './ui';

type Mode = 'view' | 'local' | 'whole' | 'compare';
type Interaction = { open: (id: string, mode?: Mode) => void; menu: (id: string) => void };
const ImageContext = createContext<Interaction>({ open: () => {}, menu: () => {} });
export const useImageInteractions = () => useContext(ImageContext);

export function ImageInteractions({ images, editActions, busy, canEdit = true, onAction, onReference, onVisibilityChange, children }: {
  images: OutfitImage[];
  editActions?: Extract<Action, { type: 'edit_image' }>[];
  busy?: boolean;
  canEdit?: boolean;
  onAction: (action: Action) => Promise<unknown> | void;
  onReference: (image: OutfitImage) => void;
  onVisibilityChange?: (visible: boolean) => void;
  children: ReactNode;
}) {
  const [viewer, setViewer] = useState<{ id: string; mode: Mode }>();
  const [menuId, setMenuId] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const menuImage = images.find(image => image.id === menuId);
  const visible = Boolean(viewer || menuId);
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
  return <ImageContext.Provider value={{ open, menu: id => { feedback(); setNotice(''); setMenuId(id); } }}>
    {children}
    {notice ? <Pressable testID="image-feedback" accessibilityRole="button" accessibilityLabel="关闭图片提示" onPress={() => setNotice('')} style={styles.toast}><Text style={styles.toastText}>{notice}</Text></Pressable> : null}
    {viewer ? <ImageViewer images={images} editActions={editActions} initialImageId={viewer.id} initialMode={viewer.mode} busy={busy} canEdit={canEdit} onClose={() => setViewer(undefined)} onAction={onAction} onReference={reference} /> : null}
    <Modal transparent visible={Boolean(menuImage)} animationType="fade" onRequestClose={() => setMenuId(undefined)}>
      <View style={styles.shade}>
        <Pressable accessibilityLabel="关闭图片菜单" style={StyleSheet.absoluteFill} onPress={() => { if (!saving) setMenuId(undefined); }} />
        <SafeAreaView edges={['bottom']} style={styles.sheet} testID="image-menu">
          <View style={styles.titleRow}>{menuImage?.url ? <Image source={{ uri: menuImage.url }} style={styles.thumbnail} /> : null}<View><Text style={styles.title}>这张图，接着怎么改？</Text><Text style={styles.detail}>v{menuImage?.version} · 原版和新版本都会保留</Text></View></View>
          {(['local', 'whole', 'reference', 'compare', 'save'] as const).map(key => {
            const labels = { local: '局部改', whole: '整张改', reference: '引用到对话', compare: '对比版本', save: saving ? '正在保存…' : '保存到相册' };
            const disabled = saving || ((key === 'local' || key === 'whole') && (!canEdit || Boolean(busy))) || (key === 'compare' && !menuImage?.parent_id);
            return <Pressable key={key} testID={`image-menu-${key}`} accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={() => {
              if (!menuImage) return;
              if (key === 'reference') reference(menuImage);
              else if (key === 'save') void save();
              else open(menuImage.id, key);
            }} style={[styles.option, disabled && { opacity: 0.35 }]}><Text style={styles.optionText}>{labels[key]}</Text></Pressable>;
          })}
          {notice ? <Text style={styles.error}>{notice}</Text> : null}
          <Pressable accessibilityRole="button" accessibilityLabel="取消图片菜单" disabled={saving} onPress={() => setMenuId(undefined)} style={styles.option}><Text style={styles.cancel}>取消</Text></Pressable>
        </SafeAreaView>
      </View>
    </Modal>
  </ImageContext.Provider>;
}

const styles = StyleSheet.create({
  shade: { flex: 1, justifyContent: 'flex-end', backgroundColor: '#17141170' },
  sheet: { backgroundColor: 'white', borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: 22, paddingTop: 20, width: '100%', maxWidth: 520, alignSelf: 'center' },
  titleRow: { flexDirection: 'row', gap: 12, alignItems: 'center', paddingBottom: 14 },
  thumbnail: { width: 42, height: 52, borderRadius: 7 },
  title: { fontSize: 15, fontWeight: '700', color: colors.ink },
  detail: { fontSize: 11, color: colors.muted, marginTop: 6 },
  option: { minHeight: 49, justifyContent: 'center', borderTopWidth: 1, borderTopColor: colors.border },
  optionText: { fontSize: 15, color: colors.ink },
  cancel: { textAlign: 'center', color: colors.muted, fontSize: 14 },
  error: { color: '#AE2940', fontSize: 12, lineHeight: 20 },
  toast: { position: 'absolute', bottom: 100, alignSelf: 'center', maxWidth: '90%', borderRadius: 12, padding: 14, backgroundColor: '#252522', zIndex: 50 },
  toastText: { color: 'white', fontSize: 12, lineHeight: 19 },
});
