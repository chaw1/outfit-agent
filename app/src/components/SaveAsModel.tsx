import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { ApiError } from '../api/client';
import type { OutfitImage } from '../api/types';
import { useSession } from '../context/Session';
import { hideAssetLibrary, isSavedModel, rememberSavedModel, useLibraryModels } from '../lib/assets';
import { layout, radius, space, studio, type } from '../theme';
import { errorText } from './ui';

export function SaveAsModel({ image }: { image: OutfitImage }) {
  const { api, token, baseUrl, refreshUser, cacheProfilePhoto, isCurrentSession } = useSession();
  const library = useLibraryModels();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!library.supported || image.status !== 'succeeded' || !image.url) return null;
  const saved = isSavedModel(library, image);
  async function save() {
    if (busy || saved) return;
    setBusy(true); setError('');
    try {
      const result = await api.saveModelFromImage(image.id);
      if (!isCurrentSession(token, baseUrl)) return;
      rememberSavedModel(api, result, image.id);
      await Promise.allSettled([refreshUser(), cacheProfilePhoto(result.asset, result.asset.url)]);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 404) hideAssetLibrary(api);
      else setError(errorText(failure));
    } finally { setBusy(false); }
  }
  const title = saved ? '已在我的模特' : busy ? '正在保存…' : '存为我的模特';
  return <View style={local.group}>
    <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ disabled: busy || saved, busy }} disabled={busy || saved} testID={`save-model-${image.id}`} onPress={() => void save()} style={({ pressed }) => [local.button, pressed && local.pressed]}>
      {busy && <ActivityIndicator color={studio.ink} size="small" />}<Text style={local.label}>{title}</Text>
    </Pressable>
    {!!error && <Text accessibilityRole="alert" style={local.error}>{error}</Text>}
  </View>;
}

const local = StyleSheet.create({
  group: { gap: space.xs },
  button: { minHeight: layout.touch, minWidth: layout.touch, paddingHorizontal: space.sm, paddingVertical: space.sm, borderWidth: 1, borderColor: studio.line, borderRadius: radius.sm, backgroundColor: studio.surface, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.sm },
  pressed: { backgroundColor: studio.softAccent },
  label: { ...type.caption, color: studio.ink, textAlign: 'center', flexShrink: 1 },
  error: { ...type.caption, color: studio.accent },
});
