import type { Asset } from '../api/types';

export type ModelStatus = 'queued' | 'building' | 'ready' | 'failed' | 'deleted';
export interface ModelCard {
  id: string;
  user_id: string | null;
  name: string;
  kind: 'preset' | 'own' | 'generated' | 'trained';
  status: ModelStatus;
  identity_text: string;
  face_asset_id: string | null;
  sheet_asset_ids: string[];
  face: Asset | null;
  sheets: { angle: string; label: string; status: 'ready' | 'missing'; asset: Asset | null }[];
  missing: string[];
  job_id: string | null;
  error: string | null;
  created_at: string;
}
export interface ModelPage { items: ModelCard[]; total: number }
export interface IdentityInput { asset_ids: string[]; name?: string }
export interface IdentityQuote {
  estimate_points: number;
  generated_count: number;
  confirmation_token: string;
  breakdown: { label: string; points: number }[];
}

export function groupModels(models: readonly ModelCard[], uploaded: Asset | null) {
  return [
    { key: 'preset' as const, title: '衣序模特', items: models.filter(model => model.kind === 'preset' && model.status !== 'deleted') },
    { key: 'own' as const, title: '我的模特', items: models.filter(model => model.kind !== 'preset' && model.status !== 'deleted') },
    { key: 'upload' as const, title: '本次上传', items: uploaded ? [uploaded] : [] },
  ];
}
export function modelStatusText(model: Pick<ModelCard, 'status' | 'missing'>): string {
  switch (model.status) {
    case 'queued': return '等待建卡';
    case 'building': return '正在建身份卡';
    case 'failed': return '建卡未完成';
    case 'deleted': return '已移除';
    case 'ready': return !model.missing.length ? '身份卡已就绪' : model.missing.length >= 3 ? '可用 · 单张照片' : `可用 · 已备 ${4 - model.missing.length} 个角度`;
  }
}
export function defaultModelId(models: readonly ModelCard[], profileFace?: string): string | undefined {
  const ready = models.filter(model => model.status === 'ready');
  const personal = ready.filter(model => model.kind !== 'preset' && model.face_asset_id === profileFace)
    .sort((a, b) => a.missing.length - b.missing.length || b.created_at.localeCompare(a.created_at));
  return personal[0]?.id
    || ready.find(model => model.kind === 'preset' && model.name === '衣序模特 A')?.id
    || ready[0]?.id;
}
export function identityIsPending(status?: ModelStatus): boolean {
  return status === 'queued' || status === 'building';
}
