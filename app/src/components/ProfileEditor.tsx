import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import React, { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { ApiError } from '../api/client';
import type { User, UserProfile } from '../api/types';
import { useSession } from '../context/Session';
import { parseHeight, profilePhotos, setDefaultPhoto } from '../lib/profile';
import { Badge, Button, FadeImage, Field, Notice, Toast, errorText, styles } from './ui';
import { colors, radius, space, type } from '../theme';

export function ProfileEditor({ user }: { user: User & { profile: UserProfile } }) {
  const { api, photos, updateMe, cacheProfilePhoto } = useSession();
  const [nickname, setNickname] = useState(user.nickname);
  const [ids, setIds] = useState(user.profile.model_asset_ids);
  const [height, setHeight] = useState(user.profile.height_cm?.toString() || '');
  const [body, setBody] = useState(user.profile.body_notes || '');
  const [style, setStyle] = useState(user.profile.style_notes || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const changed = () => setSaved(false);

  async function upload() {
    setError(''); changed();
    try {
      if (Platform.OS !== 'web' && !(await ImagePicker.requestMediaLibraryPermissionsAsync()).granted) {
        setError('请允许访问选中的照片，再添加本人照片。'); return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: true, selectionLimit: 9, quality: 0.9 });
      if (result.canceled) return;
      setBusy(true);
      for (const item of result.assets) {
        const native = { uri: item.uri, name: item.fileName || `portrait-${Date.now()}.jpg`, type: item.mimeType || 'image/jpeg' };
        const file = Platform.OS === 'web' ? item.file || new File([await (await fetch(item.uri)).blob()], native.name, { type: native.type }) : native;
        const asset = await api.uploadAsset(file, 'model');
        await cacheProfilePhoto(asset, item.uri);
        setIds(previous => [...previous, asset.id]);
      }
    } catch (e) { setError(`照片没传好：${errorText(e)}`); }
    finally { setBusy(false); }
  }

  async function save() {
    setError(''); setSaved(false);
    try {
      if (!nickname.trim()) throw new Error('给自己起一个昵称吧。');
      const parsedHeight = parseHeight(height);
      setBusy(true);
      await updateMe({ nickname: nickname.trim(), profile: { model_asset_ids: ids, height_cm: parsedHeight ?? null, body_notes: body.trim(), style_notes: style.trim() } });
      setSaved(true);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setUnavailable(true);
      else setError(errorText(e));
    } finally { setBusy(false); }
  }

  if (unavailable) return <Notice text="当前服务未开通我的形象，其他创作功能可以继续使用。" />;
  return <View style={localStyles.editor}>
    <View style={localStyles.heading}>
      <View style={localStyles.headingIcon}><Ionicons name="person-outline" size={24} color={colors.redText} /></View>
      <View style={{ flex: 1, gap: space.xs }}><Text style={styles.section}>我的形象</Text><Text style={styles.subtitle}>保存你的照片和偏好，下次合作从熟悉的你开始。</Text></View>
    </View>
    <Field label="昵称" value={nickname} maxLength={40} onChangeText={value => { setNickname(value); changed(); }} />
    <View style={{ gap: space.md }}><Text style={styles.label}>本人照片 · 第一张为默认</Text>
      <View style={localStyles.photoGrid}>{profilePhotos(ids, photos).map((photo, index) => <View key={photo.id} style={localStyles.photoCard}>
        <View>
          {photo.url ? <FadeImage accessibilityLabel={`本人照片 ${index + 1}`} source={{ uri: photo.url }} style={localStyles.portrait} /> : <View style={[localStyles.portrait, localStyles.placeholder]}><Ionicons name="person-outline" size={30} color={colors.muted} /><Text style={localStyles.placeholderText}>照片已保存{ '\n' }本机暂无预览</Text></View>}
          {index === 0 && <View style={localStyles.defaultBadge}><Badge label="默认形象" tone="brand" /></View>}
        </View>
        <View style={localStyles.photoActions}>
          <Pressable accessibilityRole="button" accessibilityLabel={index === 0 ? `默认照片 ${index + 1}` : `设照片 ${index + 1} 为默认`} disabled={busy || index === 0} onPress={() => { setIds(previous => setDefaultPhoto(previous, photo.id)); changed(); }} style={({ pressed }) => [localStyles.defaultAction, pressed && localStyles.pressed]}><Text style={{ ...type.caption, color: index === 0 ? colors.green : colors.redText, fontWeight: '600' }}>{index === 0 ? '✓ 默认' : '设为默认'}</Text></Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel={`删除本人照片 ${index + 1}`} disabled={busy} onPress={() => { setIds(previous => previous.filter(id => id !== photo.id)); changed(); }} style={({ pressed }) => [localStyles.removeAction, pressed && localStyles.pressed]}><Ionicons name="trash-outline" size={18} color={colors.danger} /></Pressable>
        </View>
      </View>)}</View>
      <Button title="添加本人照片" variant="secondary" icon="images-outline" disabled={busy} onPress={() => void upload()} />
    </View>
    <View style={localStyles.preferences}>
      <Text style={styles.section}>你的穿搭偏好</Text>
      <Field label="身高（厘米）" placeholder="选填，例如 168" keyboardType="decimal-pad" value={height} maxLength={5} onChangeText={value => { setHeight(value); changed(); }} />
      <Field label="体型描述" placeholder="例如：肩宽、梨形，想突出腰线" value={body} maxLength={500} multiline onChangeText={value => { setBody(value); changed(); }} />
      <Field label="风格偏好" placeholder="例如：喜欢松弛感，不穿高跟鞋" value={style} maxLength={1000} multiline onChangeText={value => { setStyle(value); changed(); }} />
    </View>
    {!!error && <Notice text={error} />}
    {saved && <Toast text="形象已保存，新建合作会默认带上你的照片。" tone="success" onDismiss={() => setSaved(false)} />}
    <Button title="保存我的形象" loading={busy} onPress={() => void save()} />
  </View>;
}

const localStyles = StyleSheet.create({
  editor: { gap: space.xl },
  heading: { flexDirection: 'row', gap: space.md, alignItems: 'flex-start' },
  headingIcon: { width: 48, height: 48, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.blush },
  photoGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.md },
  photoCard: { width: 136, gap: space.xs, backgroundColor: colors.paper, borderRadius: radius.md, padding: space.xs, borderWidth: 1, borderColor: colors.border },
  portrait: { width: '100%', aspectRatio: 3 / 4, borderRadius: radius.sm, backgroundColor: colors.imagePlaceholder },
  placeholder: { alignItems: 'center', justifyContent: 'center', padding: space.sm, gap: space.sm },
  placeholderText: { ...type.caption, color: colors.muted, textAlign: 'center' },
  defaultBadge: { position: 'absolute', left: space.sm, top: space.sm },
  photoActions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  defaultAction: { flex: 1, minHeight: 44, justifyContent: 'center', alignItems: 'center', borderRadius: radius.sm },
  removeAction: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm },
  pressed: { opacity: 0.6, backgroundColor: colors.blush },
  preferences: { gap: space.xl, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: space.xl },
});
