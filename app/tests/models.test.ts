import assert from 'node:assert/strict';
import test from 'node:test';
import type { Asset } from '../src/api/types';
import { ApiClient } from '../src/api/client';
import { defaultModelId, groupModels, identityIsPending, modelStatusText, type ModelCard } from '../src/lib/models';

const face: Asset = { id: 'face', kind: 'model', url: 'http://localhost/face', width: 60, height: 90, mime: 'image/jpeg', source: 'upload', created_at: '' };
function card(id: string, kind: ModelCard['kind'] = 'own', status: ModelCard['status'] = 'ready'): ModelCard {
  return { id, user_id: kind === 'preset' ? null : 'me', name: id === 'a' ? '衣序模特 A' : id, kind, status, identity_text: '固定人物', face_asset_id: 'face', sheet_asset_ids: ['face'], face, sheets: [], missing: ['full', 'three-quarter', 'half'], job_id: null, error: null, created_at: '' };
}

test('selector keeps three explicit groups and excludes tombstones without mutating input', () => {
  const models = [card('a', 'preset'), card('mine'), card('saved', 'generated'), card('deleted', 'own', 'deleted'), card('busy', 'own', 'building')];
  const before = structuredClone(models);
  const groups = groupModels(models, face);
  assert.deepEqual(groups.map(group => group.title), ['衣序模特', '我的模特', '本次上传']);
  assert.deepEqual(groups[0].items.map(item => item.id), ['a']);
  assert.deepEqual(groups[1].items.map(item => item.id), ['mine', 'saved', 'busy']);
  assert.deepEqual(groups[2].items.map(item => item.id), ['face']);
  assert.deepEqual(models, before);
  assert.deepEqual(groupModels([], null).map(group => group.items.length), [0, 0, 0]);
});

test('model status copy distinguishes queued, building, complete, missing and failed', () => {
  assert.equal(modelStatusText(card('a', 'own', 'queued')), '等待建卡');
  assert.equal(modelStatusText(card('a', 'own', 'building')), '正在建身份卡');
  assert.equal(modelStatusText(card('a', 'own', 'failed')), '建卡未完成');
  assert.equal(modelStatusText(card('a', 'own', 'deleted')), '已移除');
  assert.equal(modelStatusText(card('a')), '可用 · 缺 3 个角度');
  assert.equal(modelStatusText({ status: 'ready', missing: [] }), '身份卡已就绪');
  assert.equal(identityIsPending('queued'), true);
  assert.equal(identityIsPending('building'), true);
  assert.equal(identityIsPending('ready'), false);
  assert.equal(identityIsPending(undefined), false);
});

test('default choice respects personal default then preset A and never picks pending cards', () => {
  const models = [card('b', 'preset'), card('a', 'preset'), card('mine')];
  assert.equal(defaultModelId(models, 'face'), 'mine');
  assert.equal(defaultModelId(models), 'a');
  assert.equal(defaultModelId([card('pending', 'own', 'queued')]), undefined);
  assert.equal(defaultModelId([], 'face'), undefined);
});

test('identity API carries exact confirmation body and model deletion escapes ids', async () => {
  const calls: { url: string; body?: string; method?: string }[] = [];
  const api = new ApiClient({ baseUrl: 'http://localhost:19361', token: 'local', fetchImpl: (async (url, init) => {
    calls.push({ url: String(url), body: init?.body as string | undefined, method: init?.method });
    return new Response(init?.method === 'DELETE' ? null : '{}', { status: init?.method === 'DELETE' ? 204 : 200 });
  }) as typeof fetch });
  const input = { asset_ids: ['face', 'full'], name: '本人' };
  await api.myModels();
  await api.quoteIdentity(input);
  await api.createIdentity({ ...input, confirmation_token: 'confirmed' });
  await api.deleteModel('a/b');
  assert.deepEqual(calls.map(call => call.url), ['/api/me/models', '/api/me/models/quote', '/api/me/models', '/api/me/models/a%2Fb'].map(path => `http://localhost:19361${path}`));
  assert.deepEqual(JSON.parse(calls[1].body!), input);
  assert.deepEqual(JSON.parse(calls[2].body!), { ...input, confirmation_token: 'confirmed' });
  assert.equal(calls[3].method, 'DELETE');
});

test('a complete identity card takes precedence over the legacy photo with the same face', () => {
  const legacy = card('legacy');
  const identity = { ...card('identity'), missing: [] };
  assert.equal(defaultModelId([legacy, identity], 'face'), 'identity');
});
