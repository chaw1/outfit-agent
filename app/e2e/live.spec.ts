import { expect, test, type Locator, type Request } from '@playwright/test';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { Message, ProjectState, SendMessageInput } from '../src/api/types';
import { liveDirectory, normalizeLiveBase, performLiveOnce, readLiveCheckpoint, sanitizeLiveEvidence, saveLiveCheckpoint, selectLiveRun } from './live-support';

type SseEvidence = { at: string; url: string; status: number; body: string };

test('App 与真实服务的完整合作流程（断点续跑）', async ({ page }) => {
  test.skip(!process.env.LIVE_API_BASE, '仅设置 LIVE_API_BASE 时运行；默认验收不会调用真实模型。');
  const base = normalizeLiveBase(process.env.LIVE_API_BASE!);
  const checkpoint = selectLiveRun(await readLiveCheckpoint(), base, process.env.LIVE_NEW_RUN === '1');
  const directory = path.join(liveDirectory, `run-${checkpoint.run}`);
  await mkdir(directory, { recursive: true });
  let saving = Promise.resolve();
  const persist = () => { saving = saving.then(() => saveLiveCheckpoint(checkpoint)); return saving; };
  await persist();
  let state: ProjectState | undefined;
  let messages: Message[] = [];
  let network: unknown[] = [];
  let sseEvidence: SseEvidence[] = [];
  try { network = JSON.parse(await readFile(path.join(directory, 'http-evidence.json'), 'utf8')) as unknown[]; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  try { sseEvidence = JSON.parse(await readFile(path.join(directory, 'sse-evidence.json'), 'utf8')) as SseEvidence[]; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  let sseSaving = Promise.resolve();
  function mergeStreams(observed: SseEvidence[]) {
    const streams = new Map(sseEvidence.map(item => [`${item.at}:${item.url}`, item]));
    observed.forEach(item => streams.set(`${item.at}:${item.url}`, item));
    sseEvidence = [...streams.values()];
  }
  function persistStreams() {
    sseSaving = sseSaving.then(async () => {
      const target = path.join(directory, 'sse-evidence.json');
      await writeFile(`${target}.tmp`, `${JSON.stringify(sanitizeLiveEvidence(sseEvidence), null, 2)}\n`);
      await rename(`${target}.tmp`, target);
    });
    return sseSaving;
  }
  await page.exposeBinding('__recordLiveSse', (_source, entry: SseEvidence) => {
    if (typeof entry?.body !== 'string' || !entry.url?.startsWith(`${base}/api/projects/`) || !entry.url.endsWith('/messages')) return;
    mergeStreams([entry]);
    // Persist while the page is still alive; a Ctrl-C may close it before a phase finally runs.
    track(persistStreams());
  });
  const pageErrors: string[] = [];
  const reads: { at: number; ids: string[]; assistants: string[] }[] = [];
  const background = new Set<Promise<void>>();
  let stateKey = '';
  const track = (work: Promise<void>) => { background.add(work); void work.finally(() => background.delete(work)).catch(() => undefined); };
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('request', request => {
    if (!request.url().startsWith(`${base}/api/`) || request.method() === 'GET') return;
    let body: unknown;
    try { body = request.postDataJSON(); } catch { body = '[multipart image upload]'; }
    network.push({ at: new Date().toISOString(), kind: 'request', method: request.method(), url: request.url(), body: sanitizeLiveEvidence(body) });
  });
  page.on('response', response => {
    if (!response.url().startsWith(`${base}/api/`)) return;
    track((async () => {
      const request = response.request();
      let body: unknown;
      const contentType = response.headers()['content-type'] ?? '';
      if (contentType.includes('text/event-stream')) body = '[SSE observed through native XHR getter; see sse-evidence.json]';
      else {
        try { body = contentType.includes('json') ? await response.json() : await response.text(); }
        catch { body = '[response body unavailable]'; }
      }
      if (/\/auth\/(register|login)$/.test(response.url()) && response.ok() && body && typeof body === 'object' && 'token' in body) {
        checkpoint.session = String(body.token); checkpoint.registered = true; await persist();
      }
      if (response.url() === `${base}/api/projects` && request.method() === 'POST' && response.ok() && body && typeof body === 'object' && 'id' in body) {
        checkpoint.projectId = String(body.id); await persist();
      }
      if (response.url().endsWith('/state') && response.ok()) {
        state = body as ProjectState;
        const key = JSON.stringify(sanitizeLiveEvidence(body));
        if (key === stateKey) return;
        stateKey = key;
      }
      if (response.url().endsWith('/messages') && request.method() === 'GET' && response.ok()) {
        messages = body as Message[];
        reads.push({ at: Date.now(), ids: messages.map(item => item.id), assistants: messages.filter(item => item.role === 'assistant').map(item => item.id) });
      }
      network.push({ at: new Date().toISOString(), kind: 'response', method: request.method(), url: response.url(), status: response.status(), body: sanitizeLiveEvidence(body) });
    })());
  });

  async function evidence() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...background]),
        new Promise<void>(resolve => { timer = setTimeout(resolve, 10_000); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
    const observed = await page.evaluate(() => (window as Window & { __liveSseEvidence?: SseEvidence[] }).__liveSseEvidence ?? []).catch(() => [] as SseEvidence[]);
    mergeStreams(observed);
    await persist();
    await writeFile(path.join(directory, 'http-evidence.json'), `${JSON.stringify(sanitizeLiveEvidence(network), null, 2)}\n`);
    await persistStreams();
    await writeFile(path.join(directory, 'evidence.json'), `${JSON.stringify(sanitizeLiveEvidence({
      run: checkpoint.run, base, projectId: checkpoint.projectId, startedAt: checkpoint.startedAt, completedAt: checkpoint.completedAt,
      completed: checkpoint.completed, timingsMs: checkpoint.timings, sentAt: checkpoint.sent, observations: checkpoint.data,
      latestState: state, latestMessages: messages, historyReads: reads, pageErrors,
    }), null, 2)}\n`);
  }
  async function shot(name: string, focus?: Locator) {
    if (focus) {
      await focus.scrollIntoViewIfNeeded();
      await focus.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest' }));
    }
    await page.screenshot({ path: path.join(directory, `${name}.png`), animations: 'disabled' });
  }
  async function phase(name: string, work: () => Promise<void>) {
    if (checkpoint.completed.includes(name)) return;
    const started = Date.now();
    checkpoint.data.currentPhase = name;
    console.info(`[live] run ${checkpoint.run}: ${name}`);
    try { await work(); await shot(name); checkpoint.completed.push(name); }
    finally { checkpoint.timings[name] = (checkpoint.timings[name] ?? 0) + Date.now() - started; await evidence(); console.info(`[live] ${name}: ${Date.now() - started} ms`); }
  }
  async function waitState(predicate: (value: ProjectState) => boolean, timeout = 120_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const alerts = await visibleAlerts();
      const fatal = alerts.filter(item => !item.startsWith('进度暂时没同步：'));
      if (fatal.length) throw new Error(`项目显示错误：${fatal.join('；')}`);
      if (state && predicate(state)) return;
      await page.waitForTimeout(Math.min(1000, Math.max(1, deadline - Date.now())));
    }
    throw new Error(`等待项目状态超时（${timeout} ms，stage=${state?.stage ?? 'unavailable'}，alerts=${(await visibleAlerts()).join('；')}）`);
  }
  async function visibleAlerts() {
    if (page.isClosed()) return [];
    const alerts = page.getByRole('alert');
    const values: string[] = [];
    for (let index = 0; index < await alerts.count().catch(() => 0); index += 1) {
      const item = alerts.nth(index); if (await item.isVisible()) values.push((await item.innerText()).trim());
    }
    return values;
  }
  async function decoded(locator: Locator) {
    await locator.scrollIntoViewIfNeeded();
    await expect.poll(() => locator.evaluate(element => {
      const images = element instanceof HTMLImageElement ? [element] : [...element.querySelectorAll('img')];
      return images.length > 0 && images.every(img => img.complete && img.naturalWidth > 0 && img.naturalHeight > 0);
    }), { timeout: 120_000 }).toBe(true);
    await locator.evaluate(async element => { const images = element instanceof HTMLImageElement ? [element] : [...element.querySelectorAll('img')]; await Promise.all(images.map(img => img.decode())); });
  }
  async function once(key: string, work: () => Promise<void>) {
    const kinds: Record<string, string> = { 'choose-direction': 'choose_direction', 'confirm-script': 'confirm_script', 'brush-edit': 'edit_image', 'approve-images': 'approve_images', 'confirm-video': 'confirm_video' };
    await performLiveOnce(checkpoint, key, persist, work, observed => {
      const listener = (request: Request) => {
        if (request.method() !== 'POST' || request.url() !== `${base}/api/projects/${encodeURIComponent(checkpoint.projectId!)}/messages`) return;
        const body = request.postDataJSON() as SendMessageInput;
        if (kinds[key] ? body.action?.type === kinds[key] : key === 'reference-chat' ? Boolean(body.refs?.length) : !body.action && Boolean(body.text)) observed();
      };
      page.on('request', listener);
      return () => page.off('request', listener);
    });
  }
  async function text(key: string, content: string) {
    await once(key, async () => {
      await page.getByTestId('chat-input').fill(content);
      const request = page.waitForRequest(item => item.url().endsWith('/messages') && item.method() === 'POST' && item.postDataJSON()?.text === content);
      await page.getByTestId('send-message').click();
      await request;
    });
    await waitState(() => conversationCompleted(content));
  }
  function conversationCompleted(content: string, referenceId?: string) {
    const userIndex = messages.findLastIndex(item => item.role === 'user' && item.text === content && (!referenceId || item.refs?.includes(referenceId)));
    if (userIndex < 0) return false;
    const latest = messages.at(-1);
    return messages.slice(userIndex + 1).some(item => item.role === 'assistant' && Boolean(item.text.trim() || item.cards.length)) && latest?.role === 'assistant' && latest.id === state?.last_message_id;
  }
  const actionRequest = (kind: string) => (request: Request) => request.method() === 'POST' && request.url().endsWith('/messages') && request.postDataJSON()?.action?.type === kind;

  try {
    const healthResponse = await page.request.get(`${base}/api/health`);
    const health = await healthResponse.json();
    expect(healthResponse.ok()).toBe(true); expect(health.ok).toBe(true); expect(health.providers.mock).toBe(false);
    checkpoint.data.health = health;
    network.push({ at: new Date().toISOString(), kind: 'response', method: 'GET', url: `${base}/api/health`, status: healthResponse.status(), body: health });
    await page.addInitScript(({ apiBase, session }) => {
      localStorage.setItem('outfit.server', apiBase); if (session) sessionStorage.setItem('outfit.session', session);
      // Observe exactly the string App reads, before its ordinary done/error handler aborts XHR.
      // Calling the native getter first preserves native return values and exception semantics.
      const descriptor = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'responseText');
      if (!descriptor?.get) throw new Error('浏览器没有可观测的原生 responseText getter。');
      const nativeGet = descriptor.get;
      const records = new WeakMap<XMLHttpRequest, SseEvidence>();
      const browser = window as Window & { __liveSseEvidence?: SseEvidence[]; __recordLiveSse?: (entry: SseEvidence) => Promise<void> };
      browser.__liveSseEvidence = [];
      Object.defineProperty(XMLHttpRequest.prototype, 'responseText', {
        ...descriptor,
        get(this: XMLHttpRequest) {
          const value = nativeGet.call(this) as string;
          try {
            if (this.responseURL.startsWith(`${apiBase}/api/projects/`) && this.responseURL.endsWith('/messages') && this.getResponseHeader('content-type')?.includes('text/event-stream')) {
              let record = records.get(this);
              if (!record) { record = { at: new Date().toISOString(), url: this.responseURL, status: this.status, body: value }; records.set(this, record); browser.__liveSseEvidence!.push(record); }
              else { record.status = this.status; record.body = value; }
              void browser.__recordLiveSse?.({ ...record }).catch(() => undefined);
            }
          } catch { /* Evidence collection cannot alter the App transport. */ }
          return value;
        },
      });
    }, { apiBase: base, session: checkpoint.session });
    await page.goto(checkpoint.projectId ? `/projects/${checkpoint.projectId}` : '/');
    await phase('01-register', async () => {
      if (checkpoint.registered && checkpoint.session) return;
      const onboarding = await page.getByTestId('onboarding-1').waitFor({ state: 'visible', timeout: 8000 }).then(() => true, () => false);
      if (onboarding) {
        for (let index = 1; index <= 3; index += 1) {
          await expect(page.getByTestId(`onboarding-${index}`)).toBeVisible();
          await page.getByRole('button', { name: index === 3 ? '开始创作' : '下一步', exact: true }).click();
        }
        await expect(page.getByTestId('onboarding-1')).toHaveCount(0);
      }
      await page.getByRole('button', { name: '注册', exact: true }).click();
      await page.getByLabel('怎么称呼你', { exact: true }).fill('小序');
      await page.getByLabel('用户名', { exact: true }).fill(checkpoint.username);
      await page.getByLabel('密码', { exact: true }).fill(checkpoint.password);
      await page.getByRole('button', { name: '创建账号，开始创作', exact: true }).click();
      await expect(page.getByRole('button', { name: '新建品牌合作', exact: true })).toBeVisible();
      checkpoint.registered = true; checkpoint.session = await page.evaluate(() => sessionStorage.getItem('outfit.session') ?? undefined);
    });
    if (!checkpoint.session && checkpoint.registered) {
      await page.getByLabel('用户名', { exact: true }).fill(checkpoint.username); await page.getByLabel('密码', { exact: true }).fill(checkpoint.password);
      await page.getByRole('button', { name: '登录，继续创作', exact: true }).click();
      checkpoint.session = await page.evaluate(() => sessionStorage.getItem('outfit.session') ?? undefined); await persist();
    }
    await phase('02-upload-project', async () => {
      if (checkpoint.projectId) { await page.goto(`/projects/${checkpoint.projectId}`); return; }
      const fixtures = path.join(liveDirectory, 'fixtures'); await mkdir(fixtures, { recursive: true });
      const montage = path.resolve('../docs/spike/inputs.jpg');
      const paths = ['shirt', 'jeans', 'model'].map(name => path.join(fixtures, `${name}.jpg`));
      for (let index = 0; index < paths.length; index += 1) await sharp(montage).extract({ left: index * 450, top: 0, width: 450, height: 600 }).jpeg({ quality: 95 }).toFile(paths[index]);
      await page.getByRole('button', { name: '新建品牌合作', exact: true }).click();
      await page.getByLabel('项目名称', { exact: true }).fill(checkpoint.projectTitle); await page.getByLabel('合作品牌', { exact: true }).fill('SOFT STUDIO');
      await page.getByLabel('品牌需求', { exact: true }).fill('米白亚麻短袖衬衫和浅蓝牛仔裤，保持面料、纽扣、胸袋和裤型，去掉吊牌。使用上传的本人照片，做松弛自然的秋日咖啡店穿搭笔记。脚本只需 3 张照片，至少有一张看清袖口。');
      let chooser = page.waitForEvent('filechooser'); await page.getByTestId('upload-garments').click(); await (await chooser).setFiles(paths.slice(0, 2));
      await expect(page.getByRole('button', { name: '移除衣服图 2' })).toBeVisible();
      chooser = page.waitForEvent('filechooser'); await page.getByRole('button', { name: '上传我的照片', exact: true }).click(); await (await chooser).setFiles(paths[2]);
      await expect(page.getByRole('button', { name: '更换我的照片', exact: true })).toBeVisible();
      await shot('02-upload-fixtures', page.getByTestId('upload-garments'));
      await page.getByRole('button', { name: '开始聊灵感', exact: true }).click(); await expect.poll(() => checkpoint.projectId).toBeTruthy();
    });
    await waitState(() => true);
    await phase('03-analysis-previews', async () => {
      await waitState(value => value.garments.length >= 2 && value.directions.length >= 2, 180_000);
      await shot('03-garments-analysis', page.getByText('先认识一下这件衣服', { exact: true }));
      // A single worker can serialize previews; budget two minutes per image.
      await waitState(value => value.directions.every(item => item.preview_status === 'succeeded' && Boolean(item.preview_url)), state!.directions.length * 120_000);
      for (const option of state!.directions) await decoded(page.getByTestId(`preview-image-${option.id}`));
      checkpoint.data.directionIds = state!.directions.map(item => item.id);
      await page.getByTestId(`direction-${state!.directions[0].id}`).scrollIntoViewIfNeeded();
    });
    await phase('04-select-direction-script', async () => {
      if (!state!.script) {
        if (process.env.LIVE_DIRECTION_MODE === 'text') {
          await text('choose-direction-text', `我选“${state!.directions[0].name}”这个方向，请写出三张照片的笔记脚本，等我确认后再生成图片。`);
        } else await once('choose-direction', async () => { const direction = state!.directions[0]; await expect(page.getByTestId(`direction-${direction.id}`)).toBeEnabled(); await page.getByTestId(`direction-${direction.id}`).click(); });
      }
      await waitState(value => Boolean(value.script?.shots.length) && value.pending_action?.type === 'confirm_script');
      await expect(page.getByTestId('confirm-script')).toBeEnabled();
      checkpoint.data.initialScript = JSON.stringify(state!.script); checkpoint.data.initialVersions = state!.script_versions?.length ?? 0;
      await page.getByTestId('confirm-script').scrollIntoViewIfNeeded();
    });
    await phase('05-free-text-revise-script', async () => {
      await text('revise-script', '请修改脚本：保持总共 3 张照片，把第二张改成咖啡店窗边的半身特写，手自然放在桌边，让衬衫袖口清晰可见。其他设定保留，先给我修订后的脚本，不要开始生成。');
      await waitState(value => JSON.stringify(value.script) !== checkpoint.data.initialScript && value.script?.status === 'draft' && value.pending_action?.type === 'confirm_script');
      await expect(page.getByTestId('confirm-script')).toBeEnabled(); checkpoint.data.revisedScript = state!.script; checkpoint.data.scriptVersions = state!.script_versions;
      if (state!.script_versions?.length) { await page.getByTestId('script-history').click(); await expect(page.getByTestId(/^script-version-/).first()).toBeVisible(); await shot('05-script-history'); await page.getByRole('button', { name: '关闭历史版本', exact: true }).click(); }
      await page.getByTestId('confirm-script').scrollIntoViewIfNeeded();
    });
    await phase('06-confirm-script', async () => {
      checkpoint.data.expectedShotIds ??= state!.script!.shots.map(item => item.id);
      if (!state!.images.length && state!.stage === 'script') await once('confirm-script', async () => { checkpoint.data.preGenerationHistoryIds = messages.map(item => item.id); checkpoint.data.preGenerationLastMessageId = state!.last_message_id; await page.getByTestId('confirm-script').click(); });
      await waitState(value => value.images.length > 0);
      checkpoint.data.generationObservedAt ??= Date.now();
      checkpoint.data.generationInitialLastMessageId ??= state!.last_message_id;
      checkpoint.data.generationInitiallyPending ??= state!.images.some(item => item.status === 'running' || item.status === 'queued');
      await shot('06-images-generating', page.getByTestId(/^image-select-/).first());
    });
    await phase('07-images-fidelity-proactive', async () => {
      const expectedShotIds = checkpoint.data.expectedShotIds as string[] | undefined
        ?? (checkpoint.data.revisedScript as ProjectState['script'])?.shots.map(item => item.id)
        ?? state!.script!.shots.map(item => item.id);
      checkpoint.data.expectedShotIds = expectedShotIds;
      expect(expectedShotIds.length).toBeGreaterThan(0);
      const count = expectedShotIds.length;
      await waitState(value => expectedShotIds.every(shotId => value.images.some(item => item.shot_id === shotId && item.status === 'succeeded' && Boolean(item.url))) && value.images.every(item => item.status === 'succeeded' && Boolean(item.url)) && !value.active_jobs.some(item => item.kind === 'image'), count * 120_000 + 120_000);
      for (const image of state!.images) await decoded(page.getByTestId(`image-select-${image.id}`));
      await expect(page.getByTestId(/^fidelity-/).first()).toBeVisible();
      const previous = checkpoint.data.preGenerationHistoryIds as string[];
      await expect.poll(() => messages.some(item => item.role === 'assistant' && !previous.includes(item.id) && item.id === state?.last_message_id), { timeout: 30_000 }).toBe(true);
      const proactive = messages.find(item => item.id === state!.last_message_id)!; expect(proactive.role).toBe('assistant');
      const confirmationIndex = messages.findLastIndex(item => item.role === 'user' && item.action?.type === 'confirm_script');
      expect(confirmationIndex).toBeGreaterThanOrEqual(0);
      const confirmationReplies = messages.slice(confirmationIndex + 1).filter(item => item.role === 'assistant');
      expect(confirmationReplies.length).toBeGreaterThanOrEqual(2);
      expect(proactive.id).not.toBe(confirmationReplies[0].id);
      if (checkpoint.data.generationInitiallyPending) expect(proactive.id).not.toBe(checkpoint.data.generationInitialLastMessageId);
      checkpoint.data.proactiveMessage = proactive;
      checkpoint.data.proactiveObservedByHistoryRead = reads.some(item => item.at >= Number(checkpoint.data.generationObservedAt) && item.assistants.includes(proactive.id));
      expect(checkpoint.data.proactiveObservedByHistoryRead).toBe(true);
      checkpoint.data.fidelity = state!.images.map(item => ({ id: item.id, fidelity: item.fidelity }));
      await shot('07-proactive-message', page.getByText(proactive.text, { exact: true }).first()); await page.getByTestId('approve-images').scrollIntoViewIfNeeded();
    });
    await phase('08-brush-cuff-edit', async () => {
      const image = state!.images.find(item => item.id === checkpoint.data.editParentId) ?? state!.images.find(item => item.shot_id === state!.script?.shots[1]?.id && item.status === 'succeeded') ?? state!.images.find(item => item.status === 'succeeded')!;
      checkpoint.data.editParentId = image.id; await persist();
      await page.getByTestId(`image-select-${image.id}`).click(); await expect(page.getByTestId('image-viewer')).toBeVisible(); await decoded(page.getByTestId('viewer-canvas'));
      let cuff = { x: Number(process.env.LIVE_CUFF_X ?? '.34'), y: Number(process.env.LIVE_CUFF_Y ?? '.43') };
      if (!checkpoint.sent['brush-edit'] && process.env.LIVE_INSPECT_CUFF === '1') {
        const openedAt = Date.now();
        await shot('08-cuff-inspect');
        const selectionFile = path.join(liveDirectory, 'cuff-selection.json');
        await expect.poll(async () => {
          try {
            const changed = await stat(selectionFile); if (changed.mtimeMs < openedAt) return false;
            const selected = JSON.parse(await readFile(selectionFile, 'utf8')) as { x: number; y: number };
            if (!Number.isFinite(selected.x) || !Number.isFinite(selected.y) || selected.x < 0 || selected.x > .94 || selected.y < 0 || selected.y > .97) return false;
            cuff = selected; return true;
          } catch { return false; }
        }, { timeout: 180_000, intervals: [1000] }).toBe(true);
      }
      checkpoint.data.cuffSelection = cuff;
      if (!checkpoint.sent['brush-edit']) await once('brush-edit', async () => {
        await page.getByTestId('viewer-mode-local').click(); await page.getByTestId('viewer-mode-brush').click();
        const canvas = page.getByTestId('viewer-canvas'); const box = (await canvas.boundingBox())!;
        const size = await canvas.locator('img').first().evaluate(element => ({ w: (element as HTMLImageElement).naturalWidth, h: (element as HTMLImageElement).naturalHeight }));
        const scale = Math.min(box.width / size.w, box.height / size.h); const width = size.w * scale; const height = size.h * scale;
        const { x, y } = cuff;
        const points = [{ x, y }, { x: x + .035, y: y + .015 }, { x: x + .06, y: y + .03 }];
        for (let index = 0; index < points.length; index += 1) { const point = points[index]; await page.mouse.move(box.x + (box.width - width) / 2 + point.x * width, box.y + (box.height - height) / 2 + point.y * height, { steps: index ? 8 : 1 }); if (!index) await page.mouse.down(); }
        await page.mouse.up(); await expect(page.getByTestId('viewer-region-status')).toContainText('1');
        await page.getByTestId('edit-instruction').fill('把圈出的衬衫袖口放平，保留亚麻面料和原衣颜色，只改涂抹的区域。'); await shot('08-brush-cuff-before-submit');
        const request = page.waitForRequest(actionRequest('edit_image')); await page.getByTestId('submit-edit').click(); const body = (await request).postDataJSON() as SendMessageInput;
        expect(body.action?.type).toBe('edit_image');
        if (body.action?.type === 'edit_image') { expect(body.action.mask_strokes?.strokes.length).toBe(1); expect(body.action.region).toBeUndefined(); for (const point of body.action.mask_strokes!.strokes.flat()) { expect(point.x).toBeGreaterThanOrEqual(0); expect(point.x).toBeLessThanOrEqual(1); expect(point.y).toBeGreaterThanOrEqual(0); expect(point.y).toBeLessThanOrEqual(1); } }
        checkpoint.data.brushRequest = body;
      });
      await waitState(value => value.images.some(item => item.parent_id === image.id && item.status === 'succeeded' && Boolean(item.url)), 240_000);
      const edited = state!.images.filter(item => item.parent_id === image.id && item.status === 'succeeded').sort((a, b) => b.version - a.version)[0];
      checkpoint.data.editedImageId = edited.id; checkpoint.data.editCheck = edited.edit_check;
      await expect(page.getByTestId(`viewer-version-${edited.id}`)).toBeVisible(); await page.getByTestId(`viewer-version-${edited.id}`).click(); await decoded(page.getByTestId('viewer-canvas')); await shot('08-brush-cuff-result'); await page.getByTestId('viewer-close').click();
    });
    await phase('09-reference-chat-only', async () => {
      const imageId = String(checkpoint.data.editedImageId); const beforeIds = state!.images.map(item => item.id);
      const referenceText = '只讨论这张图的穿搭感觉，用一句话点评即可。不要改图、不要调用任何生成工具，也不要生成笔记或视频，我稍后自己点确认。';
      if (!checkpoint.sent['reference-chat']) {
        await page.getByTestId(`image-select-${imageId}`).click(); await page.getByTestId('viewer-reference').click(); await expect(page.getByTestId(`chat-ref-${imageId}`)).toBeVisible();
        await once('reference-chat', async () => {
          await page.getByTestId('chat-input').fill(referenceText);
          const request = page.waitForRequest(item => item.method() === 'POST' && item.url().endsWith('/messages') && item.postDataJSON()?.refs?.includes(imageId));
          await page.getByTestId('send-message').click(); checkpoint.data.referenceRequest = (await request).postDataJSON();
        });
      }
      await waitState(() => conversationCompleted(referenceText, imageId));
      const ref = page.getByTestId(new RegExp(`^message-ref-.*-${imageId}$`)).last(); await expect(ref).toBeVisible(); expect(state!.images.map(item => item.id)).toEqual(beforeIds); await shot('09-reference-message', ref);
    });
    await phase('10-select-images-note', async () => {
      if (!state!.note) await once('approve-images', async () => {
        await expect(page.getByTestId('approve-images')).toBeEnabled(); const selected = await page.getByTestId(/^move-up-/).evaluateAll(nodes => nodes.map(node => node.getAttribute('data-testid')!.replace('move-up-', ''))); expect(selected.length).toBeGreaterThan(0); checkpoint.data.selectedIds = selected;
        const request = page.waitForRequest(actionRequest('approve_images')); await page.getByTestId('approve-images').click(); checkpoint.data.approveRequest = (await request).postDataJSON();
      });
      await waitState(value => Boolean(value.note?.title && value.note.body), 120_000); expect(state!.note!.image_ids).toEqual(checkpoint.data.selectedIds); await expect(page.getByTestId('preview-note')).toBeVisible(); await page.getByTestId('preview-note').scrollIntoViewIfNeeded();
    });
    await phase('11-note-preview-cost-ai', async () => {
      await page.getByTestId('preview-note').click(); await expect(page.getByTestId('note-title')).toBeVisible(); await decoded(page.getByTestId(`preview-image-${state!.note!.image_ids[0]}`)); await shot('11-note-preview-image');
      await expect(page.getByTestId('note-cost')).toContainText('¥'); await expect(page.getByTestId('note-ai-label')).toContainText('AI'); expect(state!.note!.cost_cny ?? state!.cost_cny).toBeGreaterThan(0); expect(state!.note!.ai_label).toBeTruthy(); checkpoint.data.noteCostCny = state!.note!.cost_cny ?? state!.cost_cny; checkpoint.data.aiLabel = state!.note!.ai_label;
      await shot('11-note-disclosure', page.getByTestId('note-cost')); await page.getByRole('button', { name: '返回', exact: true }).click();
    });
    await phase('12-confirm-video', async () => {
      if (!state!.video) await once('confirm-video', async () => { await expect(page.getByTestId('confirm-video')).toBeEnabled(); const request = page.waitForRequest(actionRequest('confirm_video')); await page.getByTestId('confirm-video').click(); checkpoint.data.confirmVideoRequest = (await request).postDataJSON(); });
      await waitState(value => Boolean(value.video));
    });
    await phase('13-video-ready-playing', async () => {
      await waitState(value => value.video?.status === 'succeeded' && Boolean(value.video.url), 300_000);
      const video = page.locator('video').last(); await expect(video).toBeVisible(); await video.scrollIntoViewIfNeeded(); await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).readyState), { timeout: 60_000 }).toBeGreaterThanOrEqual(2); await shot('13-video-ready', video);
      if (await page.getByTestId('play-video').isVisible()) await page.getByTestId('play-video').click(); else { const box = (await video.boundingBox())!; await video.click({ position: { x: 24, y: box.height - 24 } }); }
      await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).currentTime), { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
      checkpoint.data.videoPlayback = await video.evaluate(element => ({ time: (element as HTMLVideoElement).currentTime, duration: (element as HTMLVideoElement).duration, muted: (element as HTMLVideoElement).muted, width: (element as HTMLVideoElement).videoWidth, height: (element as HTMLVideoElement).videoHeight })); expect(pageErrors).toEqual([]);
    });
    checkpoint.completedAt = new Date().toISOString(); await evidence();
  } catch (error) {
    checkpoint.data.lastFailure = {
      at: new Date().toISOString(), message: error instanceof Error ? error.message : String(error),
      phase: checkpoint.data.currentPhase,
      alerts: await visibleAlerts().catch(() => []), bodyText: await page.locator('body').innerText().catch(() => '[page unavailable]'),
    };
    const alerts = page.getByRole('alert');
    for (let index = 0; index < await alerts.count().catch(() => 0); index += 1) if (await alerts.nth(index).isVisible().catch(() => false)) { await alerts.nth(index).scrollIntoViewIfNeeded().catch(() => undefined); break; }
    const failures = (await readdir(directory)).map(name => /^failure-(\d+)\.png$/.exec(name)).filter(Boolean).map(match => Number(match![1]));
    const failureName = `failure-${String(Math.max(0, ...failures) + 1).padStart(2, '0')}`;
    await shot(failureName).catch(() => undefined);
    await writeFile(path.join(directory, `${failureName}.json`), `${JSON.stringify(sanitizeLiveEvidence({ failure: checkpoint.data.lastFailure, state, messages }), null, 2)}\n`);
    await shot('failure').catch(() => undefined); await evidence(); throw error;
  }
});
