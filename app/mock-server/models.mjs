import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const presetDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../server/app/fixtures/models');
const angles = ['face', 'full', 'three-quarter', 'half'];
const labels = ['正脸特写', '全身正面', '四分之三侧身', '半身微笑'];
const descriptions = [
  '成年女性，约22至28岁，鹅蛋脸，自然平眉、杏眼、直鼻梁、唇形饱满，自然冷白肤色，黑色中长直发中分，约168厘米、身形匀称，气质清冷干净。',
  '成年女性，约24至30岁，椭圆脸偏瘦，细眉、笑眼、鼻梁挺直、唇形清晰，自然暖白肤色，黑色低马尾，约166厘米、体态轻盈，气质亲切明朗。',
  '成年男性，约24至30岁，椭圆脸，平直浓眉、细长眼、直鼻梁、薄唇，自然中性肤色，黑色短发微分层，约180厘米、体型修长，气质干净松弛。',
];
const stableId = (value) => `model_${createHash('sha256').update(value).digest('hex').slice(0, 32)}`;

export function createModelLibrary({ db, options, now, clock, publicAsset, persist, sign, equal, failure, readJson, json, dataDir, assetPath, requireBudget }) {
  db.models ??= [];
  for (const [index, code] of ['a', 'b', 'c'].entries()) {
    const id = `preset-${code}`;
    if (db.models.some(model => model.id === id)) continue;
    const ids = angles.map(angle => {
      const assetId = `preset-${code}-${angle}`;
      if (!db.assets.some(asset => asset.id === assetId)) db.assets.push({ id: assetId, ownerId: null, kind: 'model', source: 'generated', mime: 'image/jpeg', width: 768, height: 1024, created_at: now(), presetFile: path.join(presetDirectory, `${assetId}.jpg`) });
      return assetId;
    });
    db.models.push({ id, user_id: null, name: `衣序模特 ${code.toUpperCase()}`, kind: 'preset', status: 'ready', identity_text: descriptions[index], face_asset_id: ids[0], sheet_asset_ids: ids, created_at: now() });
  }
  function migrate(user) {
    const profileIds = user.profile?.model_asset_ids || [];
    for (const asset of db.assets.filter(asset => asset.ownerId === user.id && asset.kind === 'model' && !asset.libraryHidden && !asset.identityModelId && (profileIds.includes(asset.id) || asset.source === 'generated'))) {
      if (db.models.some(model => model.user_id === user.id && model.face_asset_id === asset.id)) continue;
      db.models.push({ id: stableId(`legacy:${user.id}:${asset.id}`), user_id: user.id, name: asset.analysis?.name || '我的模特', kind: asset.source === 'generated' ? 'generated' : 'own', status: 'ready', identity_text: '', face_asset_id: asset.id, sheet_asset_ids: [asset.id], created_at: asset.created_at });
    }
  }
  function serialize(model, base) {
    const face = db.assets.find(asset => asset.id === model.face_asset_id);
    const sheets = angles.map((angle, index) => {
      const asset = db.assets.find(asset => asset.id === model.sheet_asset_ids[index]);
      return { angle, label: labels[index], status: asset ? 'ready' : 'missing', asset: asset ? publicAsset(asset, base) : null };
    });
    const job = db.jobs.find(job => job.kind === 'identity' && job.payload?.model_id === model.id);
    return { ...model, sheet_asset_ids: [...model.sheet_asset_ids], face: face ? publicAsset(face, base) : null, sheets, missing: sheets.filter(sheet => sheet.status === 'missing').map(sheet => sheet.angle), job_id: job?.id || null, error: job?.error || null };
  }
  function validateInput(body, user) {
    const ids = body.asset_ids;
    if (!Array.isArray(ids) || !ids.length || ids.length > 4 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !db.assets.some(asset => asset.id === id && asset.ownerId === user.id && asset.kind === 'model')) || (body.name != null && (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 200))) throw failure(422, 'INVALID_ASSET', '选择 1–4 张本人的模特照片，名称最多 200 字');
    return { asset_ids: [...ids], name: body.name || null };
  }
  function available(user, id) {
    const model = db.models.find(model => model.id === id && (model.user_id === user.id || (model.user_id === null && model.kind === 'preset')) && model.status !== 'deleted');
    if (!model) throw failure(404, 'NOT_FOUND', '模特不存在或无权使用');
    if (model.status !== 'ready') throw failure(409, 'MODEL_NOT_READY', '身份卡还没准备好，请完成后再选择');
    return model;
  }
  async function handle(req, res, url, user, base) {
    const exact = url.pathname === '/api/me/models';
    const quotePath = url.pathname === '/api/me/models/quote';
    const deleteMatch = url.pathname.match(/^\/api\/me\/models\/([^/]+)$/);
    if (!exact && !quotePath && !(deleteMatch && req.method === 'DELETE')) return false;
    if (options.legacyProfile || options.legacyAssets) throw failure(404, 'NOT_FOUND', '当前服务未开通模特库');
    if (exact && req.method === 'GET') {
      migrate(user); await persist();
      const items = db.models.filter(model => (model.user_id === user.id || model.kind === 'preset') && model.status !== 'deleted').map(model => serialize(model, base));
      json(res, 200, { items, total: items.length }); return true;
    }
    if ((exact || quotePath) && req.method === 'POST') {
      const body = await readJson(req);
      const input = validateInput(body, user);
      const generated = 4 - input.asset_ids.length;
      const estimate = Math.round((generated * 0.5 + (16384 * input.asset_ids.length * 3 + 800 * 30 + 3000) / 1000000) * 100) / 10;
      if (quotePath) {
        const payload = Buffer.from(JSON.stringify({ sub: user.id, purpose: 'identity', ...input, exp: clock() + 15 * 60 * 1000 })).toString('base64url');
        json(res, 200, { estimate_points: estimate, generated_count: generated, confirmation_token: `${payload}.${sign(payload)}`, breakdown: [{ label: '补齐身份卡角度', points: generated * 5 }, { label: '人物身份描述（上限）', points: Math.round((estimate - generated * 5) * 10) / 10 }] }); return true;
      }
      const [payload, signature] = typeof body.confirmation_token === 'string' ? body.confirmation_token.split('.') : [];
      let quote;
      try { quote = JSON.parse(Buffer.from(payload || '', 'base64url').toString()); } catch { /* Invalid confirmation is rejected below. */ }
      if (!payload || !equal(signature, sign(payload)) || quote?.sub !== user.id || quote.purpose !== 'identity' || quote.exp <= clock() || JSON.stringify(quote.asset_ids) !== JSON.stringify(input.asset_ids) || quote.name !== input.name) throw failure(409, 'CONFIRMATION_REQUIRED', '请重新预估点数并确认建卡');
      const id = stableId(`identity:${user.id}:${body.confirmation_token}`);
      let model = db.models.find(model => model.id === id);
      if (!model) {
        requireBudget({ ownerId: user.id }, estimate / 10);
        model = { id, user_id: user.id, name: input.name || '我的身份卡', kind: 'own', status: 'queued', identity_text: '', face_asset_id: input.asset_ids[0], sheet_asset_ids: [...input.asset_ids], created_at: now() };
        db.models.push(model);
        db.jobs.push({ id: stableId(`identity-job:${id}`), project_id: null, ownerId: user.id, kind: 'identity', status: 'queued', payload: { model_id: id, input_asset_ids: input.asset_ids }, estimate_cny: estimate / 10, created_at: now(), updated_at: now(), runningAt: clock() + (options.runningDelayMs ?? 800), dueAt: clock() + (options.identityDelayMs ?? 4000) });
        await persist();
      }
      json(res, 202, serialize(model, base)); return true;
    }
    if (deleteMatch && req.method === 'DELETE') {
      const model = db.models.find(model => model.id === decodeURIComponent(deleteMatch[1]) && model.user_id === user.id);
      if (!model) throw failure(404, 'NOT_FOUND', '模特不存在或不能删除预置模特');
      if (['queued', 'building'].includes(model.status) || db.projects.some(project => project.modelId === model.id)) throw failure(409, 'MODEL_IN_USE', '这位模特正在被片场使用或建立身份卡');
      model.status = 'deleted';
      if (user.profile) user.profile.model_asset_ids = user.profile.model_asset_ids.filter(id => id !== model.face_asset_id);
      await persist(); res.writeHead(204); res.end(); return true;
    }
    return false;
  }
  async function advance() {
    let changed = false;
    for (const job of db.jobs.filter(job => job.kind === 'identity' && ['queued', 'running'].includes(job.status))) {
      const model = db.models.find(model => model.id === job.payload.model_id);
      const user = db.users.find(user => user.id === job.ownerId && !user.deleted_at);
      if (!model || !user) { job.status = 'failed'; job.error = '身份卡或账号已失效'; changed = true; continue; }
      if (clock() >= job.dueAt) {
        try {
          const source = db.assets.find(asset => asset.id === model.face_asset_id);
          while (model.sheet_asset_ids.length < 4) {
            const id = stableId(`${model.id}:${model.sheet_asset_ids.length}`);
            const filename = `${id}.bin`;
            await copyFile(assetPath(source), path.join(dataDir, 'uploads', filename));
            db.assets.push({ ...source, id, filename, ownerId: user.id, source: 'generated', projectId: undefined, fixture: undefined, presetFile: undefined, identityModelId: model.id, created_at: now() });
            model.sheet_asset_ids.push(id);
          }
          model.identity_text = '成年人物，约25至35岁，鹅蛋脸、自然平眉、杏眼、直鼻梁、唇形清晰，自然肤色、黑色中长发，身高体态以本人照片为准，无法判断处保留未知。';
          model.status = 'ready'; job.status = 'succeeded';
          // Local placeholders are free, matching the server Mock provider ledger.
          job.result = { model_id: model.id, generated_count: 4 - job.payload.input_asset_ids.length, cost_points: 0 };
        } catch { model.status = 'failed'; job.status = 'failed'; job.error = '身份卡照片暂时不可用，请重新上传'; }
        job.updated_at = now(); changed = true;
      } else if (clock() >= job.runningAt && job.status === 'queued') {
        job.status = 'running'; model.status = 'building'; job.updated_at = now(); changed = true;
      }
    }
    return changed;
  }
  return { handle, advance, available, migrate };
}
