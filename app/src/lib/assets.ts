import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { ApiClient, ApiError } from '../api/client';
import type { Asset, OutfitImage, User } from '../api/types';
import { useSession } from '../context/Session';

export type LibraryKind = 'model' | 'garment' | 'image' | 'video';
export interface LibraryAsset extends Omit<Asset, 'kind'> {
  kind: LibraryKind | 'reference';
  project_id: string | null;
  project_title: string | null;
  name?: string;
  analysis?: { name?: string };
  in_profile: boolean;
  /** 短片的封面图（首帧），只在 kind=video 时出现。 */
  poster_url?: string | null;
}
export interface AssetPage { items: LibraryAsset[]; total: number }
export interface SavedModel { asset: Asset & { analysis?: { name?: string } }; user: User }

interface Snapshot {
  supported: boolean | null;
  models: LibraryAsset[] | null;
  savedImageIds: string[];
  error: string;
}
interface Store { value: Snapshot; listeners: Set<() => void>; revision: number; pending?: Promise<void> }
const stores = new WeakMap<ApiClient, Store>();
function storeFor(api: ApiClient): Store {
  let store = stores.get(api);
  if (!store) {
    store = { value: { supported: null, models: null, savedImageIds: [], error: '' }, listeners: new Set(), revision: 0 };
    stores.set(api, store);
  }
  return store;
}
function publish(api: ApiClient, changes: Partial<Snapshot>) {
  const store = storeFor(api);
  store.value = { ...store.value, ...changes };
  store.listeners.forEach(listener => listener());
}
export function hideAssetLibrary(api: ApiClient) {
  storeFor(api).revision += 1;
  publish(api, { supported: false, models: null, savedImageIds: [], error: '' });
}
export function loadLibraryModels(api: ApiClient, refresh = false): Promise<void> {
  const store = storeFor(api);
  if (store.pending) {
    if (!refresh) return store.pending;
    store.revision += 1;
    return store.pending.then(() => loadLibraryModels(api, true));
  }
  if (!refresh && (store.value.models !== null || store.value.supported === false)) return Promise.resolve();
  const revision = store.revision;
  store.pending = (async () => {
    try {
      const models: LibraryAsset[] = [];
      let total = 0;
      do {
        const page = await api.myAssets('model', 100, models.length);
        models.push(...page.items); total = page.total;
        if (!page.items.length) break;
      } while (models.length < total);
      if (revision === store.revision) publish(api, { supported: true, models, savedImageIds: [], error: '' });
    } catch (error) {
      if (revision !== store.revision) return;
      if (error instanceof ApiError && error.status === 404) hideAssetLibrary(api);
      else publish(api, { error: error instanceof Error ? error.message : '素材库暂时没取到，请重试。' });
    } finally { store.pending = undefined; }
  })();
  return store.pending;
}
export function rememberSavedModel(api: ApiClient, saved: SavedModel, imageId: string) {
  storeFor(api).revision += 1;
  const state = storeFor(api).value;
  const asset: LibraryAsset = { ...saved.asset, project_id: null, project_title: null, name: saved.asset.analysis?.name, in_profile: true };
  publish(api, { supported: true, models: [asset, ...(state.models || []).filter(item => item.id !== asset.id)], savedImageIds: [...new Set([...state.savedImageIds, imageId])] });
}
export function isSavedModel(state: Snapshot, image: OutfitImage): boolean {
  if (state.savedImageIds.includes(image.id)) return true;
  let mediaId: string | undefined;
  try { mediaId = image.url ? decodeURIComponent(new URL(image.url).pathname.split('/').at(-1) || '') : undefined; } catch { /* Signed URLs may use a different media path. */ }
  return !!state.models?.some(model => model.parent_id === image.id || (!!mediaId && model.parent_id === mediaId));
}
export function useLibraryModels() {
  const { api, token } = useSession();
  const subscribe = useCallback((listener: () => void) => {
    const store = storeFor(api); store.listeners.add(listener);
    return () => { store.listeners.delete(listener); };
  }, [api]);
  const snapshot = useCallback(() => storeFor(api).value, [api]);
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => { if (token) void loadLibraryModels(api); }, [api, token]);
  return state;
}
