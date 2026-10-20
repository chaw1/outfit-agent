import http from 'node:http';
import { Buffer } from 'node:buffer';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import bcrypt from 'bcryptjs';
import sharp from 'sharp';

const here = path.dirname(fileURLToPath(import.meta.url));
const DAY = 86_400;
const activeStatuses = new Set(['queued', 'running']);
const newId = (prefix) => `${prefix}_${randomUUID()}`;
const failure = (status, code, message) => Object.assign(new Error(message), { status, code });

function dimensions(bytes, mime) {
  if (mime === 'image/png' && bytes.length >= 24) return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  if (mime === 'image/jpeg') {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) break;
      const marker = bytes[offset + 1];
      const length = bytes.readUInt16BE(offset + 2);
      if ([0xc0, 0xc1, 0xc2, 0xc3].includes(marker)) return [bytes.readUInt16BE(offset + 7), bytes.readUInt16BE(offset + 5)];
      if (length < 2) break;
      offset += length + 2;
    }
  }
  return [1024, 1024];
}

const normalizedCoordinate = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
function editSelection(action) {
  if (action.region !== undefined && action.mask_strokes !== undefined) throw failure(400, 'INVALID_SELECTION', '框选和涂抹只能选一种');
  if (action.region !== undefined) {
    const region = action.region;
    if (!region || typeof region !== 'object' || Array.isArray(region) || !['x', 'y', 'w', 'h'].every((key) => normalizedCoordinate(region[key])) || region.w <= 0 || region.h <= 0 || region.x + region.w > 1 + Number.EPSILON || region.y + region.h > 1 + Number.EPSILON) throw failure(400, 'INVALID_REGION', '框选区域需要在图片内，宽高不能为零');
    return { region: { x: region.x, y: region.y, w: region.w, h: region.h } };
  }
  if (action.mask_strokes !== undefined) {
    const mask = action.mask_strokes;
    if (!mask || typeof mask !== 'object' || Array.isArray(mask) || !normalizedCoordinate(mask.brush) || mask.brush <= 0 || !Array.isArray(mask.strokes) || !mask.strokes.length || mask.strokes.length > 128 || mask.strokes.some((stroke) => !Array.isArray(stroke) || !stroke.length || stroke.length > 2048 || stroke.some((point) => !point || typeof point !== 'object' || Array.isArray(point) || !normalizedCoordinate(point.x) || !normalizedCoordinate(point.y))) || mask.strokes.reduce((count, stroke) => count + stroke.length, 0) > 8192) throw failure(400, 'INVALID_MASK', '请在图片内涂抹，并使用有效的笔刷粗细');
    return { mask_strokes: { brush: mask.brush, strokes: mask.strokes.map((stroke) => stroke.map(({ x, y }) => ({ x, y }))) } };
  }
  return {};
}

function selectionBounds(selection, width, height) {
  if (selection.region) return selection.region;
  if (!selection.mask_strokes) return undefined;
  const { brush, strokes } = selection.mask_strokes;
  const radius = brush * Math.min(width, height) / 2;
  const points = strokes.flat();
  const x = Math.max(0, Math.min(...points.map((point) => point.x)) - radius / width);
  const y = Math.max(0, Math.min(...points.map((point) => point.y)) - radius / height);
  const right = Math.min(1, Math.max(...points.map((point) => point.x)) + radius / width);
  const bottom = Math.min(1, Math.max(...points.map((point) => point.y)) + radius / height);
  return { x, y, w: right - x, h: bottom - y };
}

/** Local-only fake backend. Timings and clock can be shortened in integration tests. */
export async function createMockServer(options = {}) {
  const dataDir = options.dataDir || path.join(here, '.data');
  const fixtures = options.fixturesDir || path.resolve(here, '../../docs/spike');
  const clock = options.clock || Date.now;
  const now = () => new Date(clock()).toISOString();
  const timings = { preview: options.previewDelayMs ?? 2_200, image: options.imageDelayMs ?? 7_000, edit: options.editDelayMs ?? 5_000, video: options.videoDelayMs ?? 7_000 };
  const runningDelay = options.runningDelayMs ?? 800;
  await mkdir(path.join(dataDir, 'uploads'), { recursive: true });
  let db;
  try { db = JSON.parse(await readFile(path.join(dataDir, 'db.json'), 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    db = { users: [], assets: [], projects: [], jobs: [], secret: randomBytes(48).toString('hex') };
  }
  // Keep first-round local projects readable when the fake service is restarted.
  for (const project of db.projects) {
    project.state.cost_cny ??= 0;
    project.scriptHistory ??= [];
    project.notifiedGroups ??= [];
    if (project.state.script && !project.scriptHistory.length) {
      project.scriptHistory.push({ version: 1, checkpoint_id: newId('checkpoint'), created_at: project.updated_at, summary: '已有拍摄脚本', script: structuredClone(project.state.script) });
      project.currentScriptVersion = 1;
    }
  }
  let pendingWrite = Promise.resolve();
  function persist() {
    const snapshot = JSON.stringify(db);
    pendingWrite = pendingWrite.then(async () => {
      const temporary = path.join(dataDir, 'db.json.tmp');
      await writeFile(temporary, snapshot, { mode: 0o600 });
      await rename(temporary, path.join(dataDir, 'db.json'));
    });
    return pendingWrite;
  }
  await persist();

  const passwordInput = (password) => Buffer.byteLength(password) > 72 ? createHash('sha256').update(password).digest('base64') : password;
  const sign = (value) => createHmac('sha256', db.secret).update(value).digest('base64url');
  const publicUser = ({ id, username, nickname, created_at }) => ({ id, username, nickname, created_at });
  function tokenFor(user) {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: user.id, iat: Math.floor(clock() / 1000), exp: Math.floor(clock() / 1000) + 7 * DAY })).toString('base64url');
    return `${header}.${payload}.${sign(`${header}.${payload}`)}`;
  }
  function equal(a, b) {
    const left = Buffer.from(a || '');
    const right = Buffer.from(b || '');
    return left.length === right.length && timingSafeEqual(left, right);
  }
  function authenticate(req) {
    const value = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if (!value) throw failure(401, 'UNAUTHORIZED', '请先登录，再继续这次创作');
    const segments = value.split('.');
    const [header, payload, signature] = segments;
    try {
      if (segments.length !== 3 || !header || !payload || !signature || !equal(signature, sign(`${header}.${payload}`))) throw new Error();
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
      const decodedHeader = JSON.parse(Buffer.from(header, 'base64url').toString());
      const user = db.users.find((item) => item.id === claims.sub);
      if (decodedHeader.alg !== 'HS256' || !user || !Number.isFinite(claims.exp) || claims.exp <= clock() / 1000) throw new Error();
      return user;
    } catch { throw failure(401, 'UNAUTHORIZED', '登录已失效，请重新登录'); }
  }
  function mediaUrl(assetId, base) {
    const exp = Math.floor(clock() / 1000) + DAY;
    return `${base}/media/${assetId}?exp=${exp}&sig=${sign(`${assetId}:${exp}`)}`;
  }
  function publicAsset(asset, base) {
    const { id, kind, width, height, mime, created_at, source, parent_id, prompt } = asset;
    return { id, kind, url: mediaUrl(id, base), width, height, mime, created_at, source, ...(parent_id ? { parent_id } : {}), ...(prompt ? { prompt } : {}) };
  }
  function publicImage(image, base) {
    const { assetId, autoFixAttempted: _autoFixAttempted, automatic: _automatic, editSelection: _editSelection, ...result } = image;
    return { ...result, ...(assetId ? { url: mediaUrl(assetId, base) } : {}) };
  }
  function publicDirection(direction, base) {
    const { previewAssetId, ...result } = direction;
    return { ...result, ...(previewAssetId ? { preview_url: mediaUrl(previewAssetId, base) } : {}) };
  }
  function publicJob(job, base) {
    const { id, project_id, kind, status, result_asset_id, error, created_at, updated_at } = job;
    return { id, project_id, kind, status, ...(result_asset_id ? { result_asset_id, url: mediaUrl(result_asset_id, base) } : {}), ...(error ? { error } : {}), created_at, updated_at };
  }
  function publicProject(project, base) {
    const { id, title, brand, brief, stage, created_at, updated_at, coverAssetId } = project;
    return { id, title, brand, brief, stage, ...(coverAssetId ? { cover_url: mediaUrl(coverAssetId, base) } : {}), created_at, updated_at };
  }
  function publicVideo(project, base) {
    if (!project.state.video) return undefined;
    const { assetId, posterAssetId, ...rest } = project.state.video;
    return { ...rest, ...(assetId ? { url: mediaUrl(assetId, base) } : {}), ...(posterAssetId ? { poster_url: mediaUrl(posterAssetId, base) } : {}) };
  }
  function publicState(project, base) {
    const { stage, directions, chosen_direction_id, script, note, pending_action } = project.state;
    return {
      stage,
      garments: project.state.garments.map((item) => ({ ...item, url: mediaUrl(item.asset_id, base) })),
      directions: directions.map((item) => publicDirection(item, base)),
      ...(chosen_direction_id ? { chosen_direction_id } : {}),
      ...(script ? { script } : {}),
      images: project.state.images.map((item) => publicImage(item, base)),
      ...(note ? { note } : {}),
      ...(project.state.video ? { video: publicVideo(project, base) } : {}),
      active_jobs: db.jobs.filter((job) => job.project_id === project.id && activeStatuses.has(job.status)).map((job) => publicJob(job, base)),
      pending_action: pending_action || null,
      cost_cny: project.state.cost_cny || 0,
      last_message_id: project.messages.at(-1)?.id || null,
      script_versions: (project.scriptHistory || []).map(({ version, checkpoint_id, created_at, summary }) => ({ version, checkpoint_id, created_at, summary, current: version === project.currentScriptVersion })),
    };
  }
  function card(project, type, base) {
    const state = publicState(project, base);
    const contents = {
      garments: { items: state.garments },
      directions: { options: state.directions },
      script: state.script,
      images: { items: state.images },
      note: state.note,
      video: state.video,
    };
    return { id: `${project.id}_${type}`, type, ...contents[type] };
  }
  function refreshedMediaUrl(value, base) {
    if (!value) return value;
    try {
      const id = new URL(value).pathname.match(/^\/media\/([^/]+)$/)?.[1];
      return id && db.assets.some((asset) => asset.id === id) ? mediaUrl(id, base) : value;
    } catch { return value; }
  }
  function publicMessages(project, base) {
    return project.messages.map((message) => ({
      ...message,
      cards: message.cards.map((item) => {
        if (['note', 'script', 'video'].includes(item.type) && !project.state[item.type]) {
          if (item.type === 'video') return { ...item, ...(item.url ? { url: refreshedMediaUrl(item.url, base) } : {}), ...(item.poster_url ? { poster_url: refreshedMediaUrl(item.poster_url, base) } : {}) };
          return item;
        }
        return card(project, item.type, base);
      }),
    }));
  }
  function getProject(id, user) {
    const project = db.projects.find((item) => item.id === id && item.ownerId === user.id);
    if (!project) throw failure(404, 'PROJECT_NOT_FOUND', '没有找到这个项目');
    return project;
  }
  const touch = (project) => { project.updated_at = now(); project.stage = project.state.stage; };
  function saveScriptVersion(project, summary) {
    project.scriptHistory ||= [];
    const version = Math.max(0, ...project.scriptHistory.map((item) => item.version)) + 1;
    project.scriptHistory.push({ version, checkpoint_id: newId('checkpoint'), created_at: now(), summary, script: structuredClone(project.state.script) });
    project.currentScriptVersion = version;
  }
  function announce(project, text, types, base) {
    project.messages.push({ id: newId('message'), role: 'assistant', text, cards: types.map((type) => card(project, type, base)), created_at: now() });
  }
  const assetPath = (asset) => asset.fixture ? path.join(fixtures, asset.fixture) : path.join(dataDir, 'uploads', asset.filename);
  async function addGeneratedAsset(project, job, image) {
    const isVideo = job.kind === 'video';
    const parentImage = image?.parent_id ? project.state.images.find((item) => item.id === image.parent_id) : undefined;
    const asset = {
      id: newId('asset'), ownerId: project.ownerId, kind: 'reference', source: 'generated',
      width: isVideo ? 830 : 675, height: isVideo ? 1108 : 900,
      mime: isVideo ? 'video/mp4' : 'image/jpeg', created_at: now(), fixture: isVideo ? 'v-wan.mp4' : 't-wan-v.jpg',
      ...(parentImage?.assetId ? { parent_id: parentImage.assetId } : {}),
      prompt: image?.instruction || project.brief,
    };
    if (job.kind === 'edit' && parentImage?.assetId) {
      const originalAsset = db.assets.find((item) => item.id === parentImage.assetId);
      const { data, info } = await sharp(assetPath(originalAsset)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const { width, height, channels } = info;
      const selection = image.editSelection || {};
      const region = selectionBounds(selection, width, height);
      if (region) image.region = region;
      let mask;
      if (selection.mask_strokes) {
        const { brush, strokes } = selection.mask_strokes;
        const thickness = brush * Math.min(width, height);
        const paths = strokes.map((stroke) => stroke.length === 1
          ? `<circle cx="${stroke[0].x * width}" cy="${stroke[0].y * height}" r="${thickness / 2}" fill="white"/>`
          : `<path d="${stroke.map((point, index) => `${index ? 'L' : 'M'}${point.x * width},${point.y * height}`).join(' ')}" fill="none" stroke="white" stroke-width="${thickness}" stroke-linecap="round" stroke-linejoin="round"/>`).join('');
        mask = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${paths}</svg>`)).ensureAlpha().raw().toBuffer();
      }
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const pixel = y * width + x;
          const selected = mask ? mask[pixel * 4 + 3] > 0 : !region || ((x + 0.5) / width >= region.x && (x + 0.5) / width < region.x + region.w && (y + 0.5) / height >= region.y && (y + 0.5) / height < region.y + region.h);
          if (!selected) continue;
          const offset = pixel * channels;
          data[offset] = Math.round(data[offset] * 0.3 + 255 * 0.7);
          data[offset + 1] = Math.round(data[offset + 1] * 0.3 + 105 * 0.7);
          data[offset + 2] = Math.round(data[offset + 2] * 0.3 + 55 * 0.7);
        }
      }
      asset.width = width; asset.height = height; asset.mime = 'image/png'; asset.filename = `${asset.id}.png`;
      delete asset.fixture;
      await sharp(data, { raw: { width, height, channels } }).png().toFile(assetPath(asset));
    }
    db.assets.push(asset);
    return asset;
  }
  let advancing;
  function advanceJobs(base) {
    if (!advancing) advancing = runAdvanceJobs(base).finally(() => { advancing = undefined; });
    return advancing;
  }
  async function runAdvanceJobs(base) {
    let changed = false;
    const changedProjects = new Set();
    for (const job of db.jobs) {
      if (!activeStatuses.has(job.status)) continue;
      const project = db.projects.find((item) => item.id === job.project_id);
      if (!project) continue;
      const image = project.state.images.find((item) => item.id === job.imageId);
      const direction = job.directionId ? project.state.directions.find((item) => item.id === job.directionId) : undefined;
      let jobChanged = false;
      if (clock() >= job.dueAt) {
        try {
          const fixture = await stat(path.join(fixtures, job.kind === 'video' ? 'v-wan.mp4' : 't-wan-v.jpg'));
          if (!fixture.isFile() || !fixture.size) throw new Error('Missing fixture');
          const asset = await addGeneratedAsset(project, job, image);
          job.status = 'succeeded';
          job.result_asset_id = asset.id;
          if (direction) { direction.preview_status = 'succeeded'; direction.previewAssetId = asset.id; }
          if (image) {
            image.status = 'succeeded'; image.assetId = asset.id;
            if (job.kind === 'edit') image.edit_check = job.editCheckShouldFail
              ? { passed: false, reason: '演示检查：选区细节仍未改到位，请再试一次或换个说法。' }
              : { passed: true, reason: image.region ? '圈选区域已按指令完成处理，区域外保持原图。' : '已完成整张图片的修改，并保留上一版。' };
            const needsFix = job.kind === 'image' && image.shot_id === 'shot_3' && !image.autoFixAttempted;
            image.fidelity = needsFix
              ? { score: 54, diffs: ['左侧胸袋缺失', '纽扣位置与原衣服不一致'], auto_fixed: false }
              : { score: image.automatic ? 92 : 96, diffs: [], auto_fixed: Boolean(image.automatic) };
            if (needsFix) {
              image.autoFixAttempted = true;
              const repaired = {
                id: newId('image'), shot_id: image.shot_id, status: 'queued',
                version: Math.max(...project.state.images.filter((item) => item.shot_id === image.shot_id).map((item) => item.version)) + 1,
                parent_id: image.id, script_version: image.script_version, automatic: true,
                instruction: '自动修复：补回左侧胸袋，恢复原衣服的纽扣位置，保持面料和颜色一致',
              };
              project.state.images.push(repaired);
              queueJob(project, 'edit', repaired, 0, { groupId: job.groupId });
            }
          }
          project.state.cost_cny = Math.round(((project.state.cost_cny || 0) + (job.directionId ? 0.5 : job.kind === 'video' ? 1.5 : 1.2)) * 100) / 100;
          if (project.state.note) project.state.note.cost_cny = project.state.cost_cny;
          if (job.kind === 'video') {
            project.state.video.status = 'succeeded';
            project.state.video.assetId = asset.id;
            if (project.state.stage === 'video') project.state.stage = 'done';
          } else if (!job.directionId && (!project.coverAssetId || project.garmentAssetIds.includes(project.coverAssetId))) project.coverAssetId = asset.id;
        } catch {
          job.status = 'failed';
          job.error = '演示素材暂时不可用，请恢复素材后重试';
          if (direction) direction.preview_status = 'failed';
          if (image) { image.status = 'failed'; image.error = job.error; }
          if (job.kind === 'video') {
            project.state.video.status = 'failed';
            if (project.state.stage === 'video') {
              project.state.stage = 'note';
              project.state.pending_action = { type: 'confirm_video', prompt: '视频没有生成成功，可以再确认一次重试' };
            }
          }
        }
        jobChanged = true;
      } else if (clock() >= job.runningAt && job.status === 'queued') {
        job.status = 'running';
        if (direction) direction.preview_status = 'running';
        if (image) image.status = 'running';
        if (job.kind === 'video') project.state.video.status = 'running';
        jobChanged = true;
      }
      if (jobChanged) {
        job.updated_at = now(); touch(project); changed = true;
        changedProjects.add(project);
        const type = job.directionId ? 'directions' : job.kind === 'video' ? 'video' : 'images';
        for (const message of project.messages) message.cards = message.cards.map((item) => item.type === type ? card(project, type, base) : item);
      }
    }
    for (const project of changedProjects) {
      project.notifiedGroups ||= [];
      const groups = new Set(db.jobs.filter((job) => job.project_id === project.id && job.groupId).map((job) => job.groupId));
      for (const groupId of groups) {
        if (project.notifiedGroups.includes(groupId)) continue;
        const jobs = db.jobs.filter((job) => job.project_id === project.id && job.groupId === groupId);
        if (jobs.some((job) => activeStatuses.has(job.status))) continue;
        project.notifiedGroups.push(groupId);
        const first = jobs[0];
        const failed = jobs.filter((job) => job.status === 'failed').length;
        const type = first.directionId ? 'directions' : first.kind === 'video' ? 'video' : 'images';
        const autoFixed = jobs.some((job) => project.state.images.find((image) => image.id === job.imageId)?.automatic);
        const text = failed
          ? `${first.directionId ? '方向预览' : first.kind === 'video' ? '视频' : '图片'}有 ${failed} 个任务未完成，演示素材暂时不可用，可以恢复素材后重试。`
          : first.directionId ? '三个方向的灵感预览图都准备好了，看看哪种感觉更像你。'
          : first.kind === 'video' ? '5 秒穿搭短视频做好啦，可以打开预览播放。'
          : jobs.some((job) => project.state.images.find((image) => image.id === job.imageId)?.edit_check?.passed === false) ? '这版已经生成，但可能没改到位。查看检查原因后，可以再试一次或换个说法。'
          : autoFixed ? '3 张都好了，第 3 张的胸袋和纽扣位置偏了，我已经自动补了一版。'
          : first.kind === 'edit' ? '这张图改好了，原图也保留着，可以对比后再选。'
          : '这批穿搭图片都好了，可以挑选笔记用图了。';
        announce(project, text, [type], base);
      }
    }
    return changed;
  }
  function queueJob(project, kind, image, delayOffset = 0, details = {}) {
    const created_at = now();
    const job = {
      id: newId('job'), project_id: project.id, ownerId: project.ownerId, kind, status: 'queued', created_at, updated_at: created_at,
      runningAt: clock() + runningDelay, dueAt: clock() + timings[details.directionId ? 'preview' : kind] + delayOffset,
      groupId: details.groupId || newId('group'), ...details, ...(image ? { imageId: image.id } : {}),
    };
    db.jobs.push(job);
    return job;
  }
  function queuePreviews(project) {
    for (const job of db.jobs.filter((item) => item.project_id === project.id && item.directionId && activeStatuses.has(item.status))) {
      job.status = 'failed'; job.error = '方向已调整，已替换为新版预览任务'; job.updated_at = now();
      project.notifiedGroups ||= [];
      project.notifiedGroups.push(job.groupId);
    }
    const groupId = newId('group');
    return project.state.directions.map((direction, index) => {
      direction.preview_status = 'queued';
      return queueJob(project, 'image', undefined, index * (options.previewStaggerMs ?? 150), { directionId: direction.id, groupId });
    });
  }
  function makeDirections(project, revision = '') {
    const result = [
      { id: 'direction_city', name: '周末城市漫步', scene: '街角咖啡馆、梧桐树下的安静街道', mood: '自然、松弛、有日常感', palette: '奶白 / 浅卡其 / 牛仔蓝', why: `把${project.brand}的单品穿进真实生活，边走边拍也很出片。`, sample_title: '周末不赶时间，穿得舒服也很有风格' },
      { id: 'direction_work', name: '轻松通勤日', scene: '明亮办公楼外、窗边咖啡桌', mood: '利落、干净、轻盈', palette: '白 / 灰 / 深蓝', why: '用简洁搭配突出衣服质感，上班和下班见朋友都合适。', sample_title: '早八也能轻松出门的质感穿搭' },
      { id: 'direction_nature', name: '出走去公园', scene: '公园长椅、开阔草地和树影', mood: '清新、温柔、随性', palette: '米白 / 草绿 / 浅棕', why: '自然光让衣服颜色和面料更清楚，适合分享舒服的周末状态。', sample_title: '把周末交给阳光和舒服的衣服' },
    ];
    const request = `${project.brief} ${revision}`;
    const preferred = /通勤|上班|办公室/.test(request) ? 'direction_work' : /公园|户外|露营/.test(request) ? 'direction_nature' : 'direction_city';
    result.sort((a, b) => Number(b.id === preferred) - Number(a.id === preferred));
    if (revision) {
      for (const option of result) {
        option.why += ` 已参考你的想法：${revision}`;
        if (/松弛|自然一点|随性|舒服/.test(revision)) option.mood = `更松弛自然，${option.mood}`;
        if (/夜景|晚上|傍晚/.test(revision)) option.scene = `傍晚的${option.scene}`;
      }
      result[0].name = `${result[0].name} · 调整版`;
    }
    return result;
  }
  function makeScript(project, revision = '') {
    const direction = project.state.directions.find((item) => item.id === project.state.chosen_direction_id);
    const result = {
      status: 'draft', title_ideas: [direction.sample_title, `和${project.brand}一起，把日常穿得更好看`, '今天这套，被朋友问了好几次'],
      cover: { scene: direction.scene, pose: '侧身自然站立，回头看向镜头', text_overlay: '今日份松弛感穿搭' },
      shots: [
        { id: 'shot_1', scene: direction.scene.split('、')[0], outfit_asset_ids: project.garmentAssetIds, pose: '自然走向镜头，轻轻整理衣角', camera: '全身竖构图，平视，自然光', caption: '舒服又有精神，出门不需要想太多' },
        { id: 'shot_2', scene: '明亮的窗边', outfit_asset_ids: project.garmentAssetIds, pose: '坐在窗边，手里拿一杯咖啡', camera: '半身近景，柔和侧光，突出衣服纹理', caption: '喜欢这种不费力的日常质感' },
        { id: 'shot_3', scene: '有树影的街道', outfit_asset_ids: project.garmentAssetIds, pose: '侧身回头微笑，展示整体搭配', camera: '全身竖构图，稍远景，干净背景', caption: '好穿的单品，会想一直重复穿' },
      ],
      video: { prompt: '模特在自然光中缓缓走动，镜头轻轻推进，衣服细节清晰，保持人物与穿搭一致', duration: 5 },
    };
    if (direction.id === 'direction_work') {
      result.shots[1].scene = '办公室窗边';
      result.shots[2].scene = '明亮的办公楼外';
    } else if (direction.id === 'direction_nature') {
      result.shots[1].scene = '公园长椅';
      result.shots[2].scene = '有树影的草地';
    }
    if (!revision) return result;
    const draft = structuredClone(project.state.script || result);
    const shotNumber = revision.match(/第([123一二三])张/);
    const shotIndex = shotNumber ? ({ 一: 0, 二: 1, 三: 2, 1: 0, 2: 1, 3: 2 })[shotNumber[1]] : 0;
    const shot = draft.shots[shotIndex];
    if (/通勤|上班/.test(revision) && !shotNumber && !/封面/.test(revision)) {
      draft.cover.scene = '明亮的办公楼外';
      draft.shots[0].scene = '明亮的办公楼外';
      draft.shots[1].scene = '办公室窗边';
      draft.shots[2].scene = '下班路上的安静街道';
      draft.title_ideas[0] = '早八也能轻松出门的质感穿搭';
    } else if (/封面/.test(revision)) {
      if (/标题|文字|字样/.test(revision)) draft.cover.text_overlay = revision;
      else { draft.cover.scene = `${draft.cover.scene}；${revision}`; draft.cover.pose = `${draft.cover.pose}；${revision}`; }
    } else if (/标题/.test(revision)) draft.title_ideas[0] = revision.replace(/^.*?标题[改换为成：:]*\s*/, '') || revision;
    else if (/视频/.test(revision)) draft.video.prompt = `${draft.video.prompt}；${revision}`;
    else if (/背景|场景|办公室|公园|咖啡/.test(revision)) shot.scene = `${shot.scene}；${revision}`;
    else if (/姿势|动作|站|坐|走|塞|裤腰/.test(revision)) shot.pose = `${shot.pose}；${revision}`;
    else if (/镜头|构图|光线|明亮|暗/.test(revision)) shot.camera = `${shot.camera}；${revision}`;
    else shot.caption = `${shot.caption}；${revision}`;
    draft.status = 'draft';
    return draft;
  }
  function normalizedAction(action) {
    const fields = { choose_direction: ['direction_id'], confirm_script: [], edit_image: ['image_id', 'instruction'], approve_images: ['image_ids'], confirm_video: ['image_id'], restore_script: ['checkpoint_id'] };
    return { type: action.type, ...Object.fromEntries(fields[action.type].map((key) => [key, action[key]])), ...(action.type === 'edit_image' ? editSelection(action) : {}) };
  }
  function processMessage(project, body, base) {
    const action = body.action;
    if ((body.text !== undefined && typeof body.text !== 'string') || (action != null && (typeof action !== 'object' || Array.isArray(action)))) throw failure(400, 'INVALID_MESSAGE', '消息内容需要是文字或有效操作');
    const state = project.state;
    const refs = body.refs;
    if (refs !== undefined && (!Array.isArray(refs) || refs.length > 20 || new Set(refs).size !== refs.length || refs.some((id) => typeof id !== 'string' || !state.images.some((image) => image.id === id && image.status === 'succeeded')))) throw failure(400, 'INVALID_REFS', '引用的图片需要来自当前项目，并且已经生成完成');
    const jobs = [];
    let types = [];
    let reply = '';
    if (action) {
      switch (action.type) {
        case 'choose_direction': {
          if (!['direction', 'script'].includes(state.stage)) throw failure(409, 'INVALID_STAGE', '先和我聊聊需求，再选择一个方向吧');
          if (!state.directions.some((item) => item.id === action.direction_id)) throw failure(400, 'INVALID_DIRECTION', '这个方向不存在，请重新选择');
          state.chosen_direction_id = action.direction_id;
          state.script = makeScript(project);
          saveScriptVersion(project, `按“${state.directions.find((item) => item.id === action.direction_id).name}”创建脚本`);
          state.stage = 'script';
          state.pending_action = { type: 'confirm_script', prompt: '看看这份拍摄脚本，确认后就开始生成图片' };
          types = ['script'];
          reply = '好，就按这个方向来。我把封面、每张图的动作和配文都写好了，看看有没有想调整的地方。确认脚本后再开始出图。';
          break;
        }
        case 'confirm_script': {
          if (state.stage !== 'script' || state.script?.status !== 'draft') throw failure(409, 'SCRIPT_NOT_READY', '请先选择方向，确认拍摄脚本后再生成');
          if (db.jobs.some((job) => job.project_id === project.id && !job.directionId && activeStatuses.has(job.status))) throw failure(409, 'JOBS_RUNNING', '已有图片或视频仍在生成，完成后再确认这版脚本');
          state.script.status = 'confirmed';
          const images = state.script.shots.map((shot) => ({ id: newId('image'), shot_id: shot.id, status: 'queued', version: Math.max(0, ...state.images.filter((item) => item.shot_id === shot.id).map((item) => item.version)) + 1, script_version: project.currentScriptVersion }));
          state.images.push(...images);
          const groupId = newId('group');
          images.forEach((image, index) => jobs.push(queueJob(project, 'image', image, index * (options.imageStaggerMs ?? 500), { groupId })));
          state.stage = 'images';
          state.pending_action = null;
          delete state.note;
          delete state.video;
          types = ['script', 'images'];
          reply = '脚本确认了，开始准备这三张图。你可以先看生成进度，完成后挑喜欢的图片，也可以点某一张让我修改。';
          break;
        }
        case 'restore_script': {
          const saved = project.scriptHistory?.find((item) => item.checkpoint_id === action.checkpoint_id);
          if (!saved) throw failure(400, 'INVALID_CHECKPOINT', '没有找到这个脚本版本，请刷新历史后重试');
          state.script = structuredClone(saved.script);
          state.script.status = 'draft';
          project.currentScriptVersion = saved.version;
          state.stage = 'script';
          state.pending_action = { type: 'confirm_script', prompt: `已恢复第 ${saved.version} 版脚本，确认后再生成新图片；已有图片会保留` };
          types = ['script', ...(state.images.length ? ['images'] : [])];
          reply = `已恢复到第 ${saved.version} 版脚本，之前的图片都保留着。看看这版是否合适，确认后再开始生成。`;
          break;
        }
        case 'edit_image': {
          if (!['images', 'note', 'done'].includes(state.stage)) throw failure(409, 'INVALID_STAGE', '等图片生成完成后，就可以告诉我怎么改');
          const original = state.images.find((item) => item.id === action.image_id && item.status === 'succeeded');
          const instruction = typeof action.instruction === 'string' ? action.instruction.trim() : '';
          if (!original || !instruction) throw failure(400, 'INVALID_EDIT', '请选择一张已完成的图片，并写下修改想法');
          const selection = editSelection(action);
          const isLocal = Boolean(selection.region || selection.mask_strokes);
          const source = db.assets.find((item) => item.id === original.assetId);
          const region = selectionBounds(selection, source.width, source.height);
          const editCheckShouldFail = isLocal && !project.localEditCheckDemonstrated;
          if (isLocal) project.localEditCheckDemonstrated = true;
          const image = { id: newId('image'), shot_id: original.shot_id, status: 'queued', version: Math.max(...state.images.filter((item) => item.shot_id === original.shot_id).map((item) => item.version)) + 1, parent_id: original.id, instruction, script_version: original.script_version, ...(region ? { region } : {}), editSelection: selection };
          state.images.push(image);
          jobs.push(queueJob(project, 'edit', image, 0, { editCheckShouldFail }));
          types = ['images'];
          reply = `收到，我按“${instruction}”修改这张，原图会保留，你可以对比后再选。`;
          break;
        }
        case 'approve_images': {
          if (!['images', 'note', 'done'].includes(state.stage)) throw failure(409, 'INVALID_STAGE', '请先生成图片，再选择笔记用图');
          const ids = action.image_ids;
          if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length || ids.some((id) => !state.images.some((item) => item.id === id && item.status === 'succeeded'))) throw failure(400, 'INVALID_IMAGES', '请选择已生成完成的图片，每张只选一次');
          state.note = {
            title: state.script.title_ideas[0],
            body: `最近喜欢把穿搭做减法，舒服自在就很好。\n\n这次和${project.brand}一起，把喜欢的单品穿进日常。干净的颜色、舒服的版型，随手一搭就能出门。\n\n${state.script.shots.map((shot) => shot.caption).join('。')}。\n\n你们更喜欢哪一张？欢迎一起聊聊今日穿搭。`,
            tags: ['今日穿搭', '穿搭灵感', '日常穿搭', project.brand], image_ids: [...ids],
            cost_cny: state.cost_cny || 0,
            ai_label: '本篇图片和视频含 AI 生成内容，发布时请勾选平台的 AI 内容声明。',
          };
          state.stage = 'note';
          delete state.video;
          state.pending_action = { type: 'confirm_video', prompt: '图文已经准备好了，要不要再做一条 5 秒穿搭短视频？' };
          types = ['images', 'note'];
          reply = '选好了！我按你选的顺序排好图片，也把标题、正文和话题写好了。你可以直接预览笔记，想要短视频的话，再选一张图确认生成。';
          break;
        }
        case 'confirm_video': {
          if (!['note', 'done'].includes(state.stage) || !state.note) throw failure(409, 'NOTE_NOT_READY', '先选好笔记图片，再生成短视频');
          const image = state.images.find((item) => item.id === action.image_id && item.status === 'succeeded' && state.note.image_ids.includes(item.id));
          if (!image) throw failure(400, 'INVALID_IMAGE', '请选择一张笔记中已完成的图片');
          const job = queueJob(project, 'video');
          jobs.push(job);
          state.video = { status: 'queued', job_id: job.id, posterAssetId: image.assetId };
          state.stage = 'video';
          state.pending_action = null;
          types = ['video'];
          reply = '确认啦，正在把这张图做成 5 秒短视频，完成后就可以在笔记预览里播放。';
          break;
        }
        default: throw failure(400, 'INVALID_ACTION', '暂时不支持这个操作');
      }
    } else {
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text) throw failure(400, 'EMPTY_MESSAGE', '写一句你的想法再发送吧');
      if (['brief', 'direction'].includes(state.stage)) {
        state.directions = makeDirections(project, text);
        jobs.push(...queuePreviews(project));
        state.stage = 'direction';
        state.pending_action = { type: 'choose_direction', prompt: '选一个喜欢的方向，也可以继续告诉我你的想法' };
        types = ['garments', 'directions'];
        reply = `我看过衣服和${project.brand}的合作需求了，整体适合自然、舒服的日常表达。给你整理了三个场景方向，你喜欢哪一种？也可以继续告诉我想调整的感觉。`;
      } else if (state.stage === 'script') {
        state.script = makeScript(project, text);
        saveScriptVersion(project, text);
        types = ['script'];
        reply = `可以，我按“${text}”调整了脚本。再看看这版，确认后我们就开始出图。`;
      } else if (['note', 'done'].includes(state.stage)) {
        state.note.body = `${state.note.body}\n\n${text}`;
        types = ['note'];
        reply = '我已经把你的想法补进笔记里了，打开预览就能看到。';
      } else if (state.stage === 'images' && /重试|重新生成|再试/.test(text) && state.images.some((image) => image.status === 'failed')) {
        const groupId = newId('group');
        for (const image of state.images.filter((item) => item.status === 'failed')) {
          image.status = 'queued';
          delete image.error;
          jobs.push(queueJob(project, image.parent_id ? 'edit' : 'image', image, 0, { groupId }));
        }
        types = ['images'];
        reply = '我把没有完成的图片重新排队了，已经成功的图片会保留。';
      } else {
        types = state.stage === 'video' ? ['video'] : ['images'];
        reply = '我在这里。生成任务还在继续，图片完成后可以点“改这张”写下具体想法，或者按喜欢的顺序选图。';
      }
    }
    touch(project);
    const userMessage = { id: newId('message'), role: 'user', text: typeof body.text === 'string' ? body.text.trim() : '', cards: [], ...(action ? { action: normalizedAction(action) } : {}), ...(refs !== undefined ? { refs: [...refs] } : {}), created_at: now() };
    const assistant = { id: newId('message'), role: 'assistant', text: reply, cards: types.map((type) => card(project, type, base)), created_at: now() };
    project.messages.push(userMessage, assistant);
    return { reply, cards: types.map((type) => card(project, type, base)), jobs: jobs.map((job) => publicJob(job, base)), message_id: assistant.id };
  }
  async function readBody(req) {
    const chunks = [];
    let length = 0;
    for await (const chunk of req) {
      length += chunk.length;
      if (length > 20 * 1024 * 1024) throw failure(413, 'FILE_TOO_LARGE', '图片请控制在 20 MB 以内');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  async function readJson(req) {
    try {
      const value = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      return value;
    } catch (error) {
      if (error.status) throw error;
      throw failure(400, 'INVALID_JSON', '请求内容格式有误');
    }
  }
  function json(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  }
  async function sendSse(res, result) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const event = (type, value) => { if (!res.destroyed) res.write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`); };
    if (result.error) { event('error', result.error); res.end(); return; }
    const chunks = result.reply.match(/.{1,8}/gu) || [];
    for (const delta of chunks) {
      if (res.destroyed) return;
      event('token', { delta });
      if (options.tokenDelayMs !== 0) await new Promise((resolve) => setTimeout(resolve, options.tokenDelayMs ?? 18));
    }
    for (const value of result.cards) event('card', value);
    for (const value of result.jobs) event('job', value);
    event('done', { message_id: result.message_id });
    res.end();
  }
  function decodeId(value) {
    try { return decodeURIComponent(value); } catch { throw failure(400, 'INVALID_PATH', '请求地址格式有误'); }
  }
  async function serveMedia(req, res, url) {
    const id = decodeId(url.pathname.slice('/media/'.length));
    const exp = url.searchParams.get('exp');
    if (!exp || !/^\d+$/.test(exp) || Number(exp) < clock() / 1000 || !equal(url.searchParams.get('sig'), sign(`${id}:${exp}`))) throw failure(403, 'MEDIA_EXPIRED', '图片链接已过期，请刷新项目');
    const asset = db.assets.find((item) => item.id === id);
    if (!asset) throw failure(404, 'ASSET_NOT_FOUND', '没有找到这个文件');
    const filename = assetPath(asset);
    const info = await stat(filename);
    const common = { 'Content-Type': asset.mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600' };
    let start = 0;
    let end = info.size - 1;
    let status = 200;
    if (req.headers.range) {
      const match = req.headers.range.match(/^bytes=(\d*)-(\d*)$/);
      if (!match || (!match[1] && !match[2])) { res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); res.end(); return; }
      if (!match[1]) start = Math.max(0, info.size - Number(match[2]));
      else { start = Number(match[1]); if (match[2]) end = Math.min(Number(match[2]), end); }
      if (start > end || start >= info.size) { res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); res.end(); return; }
      status = 206;
      common['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
    }
    res.writeHead(status, { ...common, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') res.end();
    else createReadStream(filename, { start, end }).on('error', () => res.destroy()).pipe(res);
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Range');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    try {
      const host = req.headers.host || 'localhost:19301';
      const base = options.publicBase || `http://${host}`;
      const url = new URL(req.url || '/', base);
      if (await advanceJobs(base)) await persist();
      if (url.pathname.startsWith('/media/') && ['GET', 'HEAD'].includes(req.method)) { await serveMedia(req, res, url); return; }
      if (['/api/auth/register', '/api/auth/login'].includes(url.pathname) && req.method === 'POST') {
        const body = await readJson(req);
        const username = typeof body.username === 'string' ? body.username.trim() : '';
        const password = typeof body.password === 'string' ? body.password : '';
        if (username.length < 3 || username.length > 32 || password.length < 8) throw failure(400, 'INVALID_CREDENTIALS', '用户名需要 3–32 位，密码需要至少 8 位');
        let user = db.users.find((item) => item.username.toLowerCase() === username.toLowerCase());
        if (url.pathname.endsWith('register')) {
          if (user) throw failure(409, 'USERNAME_EXISTS', '这个用户名已经有人用了，换一个试试');
          // Hash synchronously so two concurrent registrations cannot reserve the same name.
          user = { id: newId('user'), username, nickname: typeof body.nickname === 'string' && body.nickname.trim() ? body.nickname.trim() : username, created_at: now(), passwordHash: bcrypt.hashSync(passwordInput(password), 10) };
          db.users.push(user);
          await persist();
        } else if (!user || !bcrypt.compareSync(passwordInput(password), user.passwordHash)) throw failure(401, 'INVALID_CREDENTIALS', '用户名或密码不对，再检查一下');
        json(res, 200, { token: tokenFor(user), user: publicUser(user) }); return;
      }
      const user = authenticate(req);
      if (url.pathname === '/api/health' && req.method === 'GET') { json(res, 200, { ok: true, version: 'mock-1.0.0', providers: { text: 'local-mock', vision: 'local-mock', image: 'local-fixture', video: 'local-fixture', mock: true } }); return; }
      if (url.pathname === '/api/me' && req.method === 'GET') { json(res, 200, publicUser(user)); return; }
      if (url.pathname === '/api/assets' && req.method === 'POST') {
        const bytes = await readBody(req);
        let form;
        try { form = await new Request(`${base}/api/assets`, { method: 'POST', headers: { 'Content-Type': req.headers['content-type'] || '' }, body: bytes }).formData(); }
        catch { throw failure(400, 'INVALID_UPLOAD', '请上传一张图片'); }
        const file = form.get('file');
        const kind = form.get('kind');
        if (!['garment', 'model', 'reference'].includes(kind) || !file || typeof file.arrayBuffer !== 'function' || !file.size || !['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif'].includes(file.type)) throw failure(400, 'INVALID_UPLOAD', '请选择图片，并指定正确的图片类型');
        const imageBytes = Buffer.from(await file.arrayBuffer());
        const [width, height] = dimensions(imageBytes, file.type);
        const id = newId('asset');
        const filename = `${id}.bin`;
        await writeFile(path.join(dataDir, 'uploads', filename), imageBytes);
        const asset = { id, ownerId: user.id, kind, width, height, mime: file.type, created_at: now(), source: 'upload', filename };
        db.assets.push(asset); await persist(); json(res, 200, publicAsset(asset, base)); return;
      }
      if (url.pathname === '/api/projects' && req.method === 'GET') { json(res, 200, db.projects.filter((item) => item.ownerId === user.id).sort((a, b) => b.updated_at.localeCompare(a.updated_at)).map((item) => publicProject(item, base))); return; }
      if (url.pathname === '/api/projects' && req.method === 'POST') {
        const body = await readJson(req);
        const title = typeof body.title === 'string' ? body.title.trim() : '';
        const brand = typeof body.brand === 'string' ? body.brand.trim() : '';
        const brief = typeof body.brief === 'string' ? body.brief.trim() : '';
        const ids = body.garment_asset_ids;
        if (!title || !brand || !brief || !Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length) throw failure(400, 'INVALID_PROJECT', '请填写标题、品牌和需求，并上传至少一张衣服图');
        const assets = ids.map((id) => db.assets.find((item) => item.id === id && item.ownerId === user.id && item.kind === 'garment'));
        const model = body.model_asset_id ? db.assets.find((item) => item.id === body.model_asset_id && item.ownerId === user.id && item.kind === 'model') : undefined;
        if (assets.some((item) => !item) || (body.model_asset_id && !model)) throw failure(400, 'INVALID_ASSET', '图片不属于当前账号，或图片类型不正确');
        const created_at = now();
        const project = { id: newId('project'), title, brand, brief, stage: 'brief', ownerId: user.id, garmentAssetIds: ids, ...(model ? { modelAssetId: model.id } : {}), created_at, updated_at: created_at, coverAssetId: ids[0], messages: [], state: { stage: 'brief', garments: assets.map((asset) => ({ asset_id: asset.id, category: '日常上装', color: '浅色', material: '棉混纺', style_tags: ['简约', '日常', '松弛'] })), directions: [], images: [], pending_action: null } };
        db.projects.push(project); await persist(); json(res, 200, publicProject(project, base)); return;
      }
      const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)(?:\/(state|messages))?$/);
      if (projectMatch) {
        const project = getProject(decodeId(projectMatch[1]), user);
        if (!projectMatch[2] && req.method === 'GET') { json(res, 200, publicProject(project, base)); return; }
        if (!projectMatch[2] && req.method === 'DELETE') {
          db.projects = db.projects.filter((item) => item.id !== project.id);
          db.jobs = db.jobs.filter((item) => item.project_id !== project.id);
          await persist(); res.writeHead(204); res.end(); return;
        }
        if (projectMatch[2] === 'state' && req.method === 'GET') { json(res, 200, publicState(project, base)); return; }
        if (projectMatch[2] === 'messages' && req.method === 'GET') { json(res, 200, publicMessages(project, base)); return; }
        if (projectMatch[2] === 'messages' && req.method === 'POST') {
          const body = await readJson(req);
          let result;
          try { result = processMessage(project, body, base); await persist(); }
          catch (error) { if (!error.status) throw error; result = { error: { code: error.code, message: error.message } }; }
          await sendSse(res, result); return;
        }
      }
      const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
      if (jobMatch && req.method === 'GET') {
        const job = db.jobs.find((item) => item.id === jobMatch[1] && item.ownerId === user.id);
        if (!job) throw failure(404, 'JOB_NOT_FOUND', '没有找到这个生成任务');
        json(res, 200, publicJob(job, base)); return;
      }
      throw failure(404, 'NOT_FOUND', '没有找到这个接口');
    } catch (error) {
      if (!res.headersSent) json(res, error.status || 500, { error: { code: error.code || 'INTERNAL_ERROR', message: error.status ? error.message : '服务暂时忙，请稍后重试' } });
      else res.end();
    }
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT || 19301);
  const previewDelayMs = Number(process.env.MOCK_PREVIEW_DELAY_MS);
  const server = await createMockServer({ ...(Number.isFinite(previewDelayMs) && previewDelayMs >= 0 ? { previewDelayMs } : {}) });
  server.listen(port, '0.0.0.0', () => console.log(`本地假服务已启动：http://localhost:${port}/api/health`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
}
