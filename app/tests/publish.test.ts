import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyPublishProgress, noteText, preparePublish, savedImagesAreInOrder, videoKey, type PublishActions, type ShareOutcome } from '../src/lib/publish';
import { mediaExtension, mediaFilename } from '../src/lib/mediaFormats';

const note = { title: '秋日穿搭', body: '柔软的衬衫，今天出门刚好。', tags: ['穿搭', '#日常'], image_ids: ['cover', 'second', 'third'] };
const images = [{ id: 'third', url: '/3.jpg' }, { id: 'cover', url: '/1.jpg' }, { id: 'second', url: '/2.jpg' }];
const video = { status: 'succeeded' as const, url: 'https://media.example/video.mp4?sig=old', job_id: 'video-job-1' };
function recorder(overrides: Partial<PublishActions> = {}) {
  const calls: string[] = [];
  const actions: PublishActions = {
    copy: async () => { calls.push('copy'); },
    saveImage: async image => { calls.push(image.id); },
    saveVideo: async () => { calls.push('video'); },
    share: async () => { calls.push('share'); return 'shared'; },
    ...overrides,
  };
  return { calls, actions };
}

test('one publish operation copies text, saves original images in note order, saves video, then shares', async () => {
  const progress = emptyPublishProgress();
  const { calls, actions } = recorder();
  await preparePublish(note, images, video, progress, actions);
  assert.deepEqual(calls, ['copy', 'cover', 'second', 'third', 'video', 'share']);
  assert.equal(progress.copiedText, '秋日穿搭\n\n柔软的衬衫，今天出门刚好。\n\n#穿搭 #日常');
  assert.deepEqual(progress.savedImageIds, note.image_ids);
  assert.deepEqual(progress.savedVideoKeys, ['video-job-1']);
  assert.equal(progress.share, 'shared');
});

test('a partial image failure stops later saves and a retry saves only the unfinished suffix', async () => {
  const progress = emptyPublishProgress();
  const saved: string[] = [];
  let failed = false;
  let copies = 0;
  const { actions } = recorder({
    copy: async () => { copies += 1; },
    saveImage: async image => {
      if (image.id === 'second' && !failed) { failed = true; throw new Error('temporary download failure'); }
      saved.push(image.id);
    },
  });
  await assert.rejects(preparePublish(note, images, video, progress, actions), /temporary/);
  assert.deepEqual(saved, ['cover']);
  assert.deepEqual(progress.savedImageIds, ['cover']);
  await preparePublish(note, images, video, progress, actions);
  assert.deepEqual(saved, ['cover', 'second', 'third']);
  assert.equal(copies, 1);
});

test('a missing earlier URL blocks later images and sharing until refreshed', async () => {
  const progress = emptyPublishProgress();
  const { calls, actions } = recorder();
  await assert.rejects(preparePublish(note, images.filter(image => image.id !== 'second'), undefined, progress, actions), /第 2 张图片/);
  assert.deepEqual(calls, ['copy', 'cover']);
  await preparePublish(note, images, undefined, progress, actions);
  assert.deepEqual(calls, ['copy', 'cover', 'second', 'third', 'share']);
});

test('retrying video or system share does not download or save completed media again', async () => {
  const progress = emptyPublishProgress();
  const { calls, actions } = recorder();
  let attempts = 0;
  actions.saveVideo = async () => { calls.push('video'); if (attempts++ === 0) throw new Error('video denied'); };
  await assert.rejects(preparePublish(note, images, video, progress, actions), /denied/);
  assert.deepEqual(progress.savedVideoKeys, []);
  actions.share = async () => { calls.push('share'); throw new Error('system share unavailable'); };
  await assert.rejects(preparePublish(note, images, video, progress, actions), /unavailable/);
  actions.share = async () => { calls.push('share'); return 'shared'; };
  await preparePublish(note, images, { ...video, url: 'https://media.example/video.mp4?sig=new' }, progress, actions);
  assert.deepEqual(calls, ['copy', 'cover', 'second', 'third', 'video', 'video', 'share', 'share']);
});

test('running video pauses after images; when ready it continues with video and share', async () => {
  const progress = emptyPublishProgress();
  const { calls, actions } = recorder();
  await assert.rejects(preparePublish(note, images, { status: 'running' }, progress, actions), /视频还在制作中/);
  await preparePublish(note, images, video, progress, actions);
  assert.deepEqual(calls, ['copy', 'cover', 'second', 'third', 'video', 'share']);
});

test('failed optional video still permits the image note, with truthful unsupported or cancelled sharing', async () => {
  for (const outcome of ['dismissed', 'unavailable'] satisfies ShareOutcome[]) {
    const progress = emptyPublishProgress();
    const { calls, actions } = recorder({ share: async () => outcome });
    await preparePublish(note, images, { status: 'failed' }, progress, actions);
    assert.deepEqual(calls, ['copy', 'cover', 'second', 'third']);
    assert.equal(progress.share, outcome);
    assert.deepEqual(progress.savedVideoKeys, []);
  }
});

test('editing note text recopies changed text but reuses already saved images', async () => {
  const progress = emptyPublishProgress();
  const { calls, actions } = recorder();
  await preparePublish(note, images, undefined, progress, actions);
  await preparePublish({ ...note, title: '新的秋日穿搭' }, images, undefined, progress, actions);
  assert.deepEqual(calls, ['copy', 'cover', 'second', 'third', 'share', 'copy', 'share']);
  assert.ok(progress.copiedText?.startsWith('新的秋日穿搭'));
});

test('successful effects are checkpointed before proceeding to the next item', async () => {
  const progress = emptyPublishProgress();
  const checkpoints: string[][] = [];
  const { actions } = recorder({ changed: next => checkpoints.push([...next.savedImageIds]) });
  await preparePublish(note, images, video, progress, actions);
  assert.ok(checkpoints.some(ids => ids.join(',') === 'cover'));
  assert.ok(checkpoints.some(ids => ids.join(',') === 'cover,second'));
  assert.deepEqual(checkpoints.at(-1), ['cover', 'second', 'third']);
});

test('renewed signed video URLs use stable identity and no empty extra separators enter copied note text', () => {
  assert.equal(videoKey({ status: 'succeeded', url: 'https://example.test/one.mp4?sig=1' }), videoKey({ status: 'succeeded', url: 'https://example.test/one.mp4?sig=2' }));
  assert.notEqual(videoKey(video), videoKey({ ...video, job_id: 'video-job-2' }));
  assert.equal(noteText({ title: '', body: '正文', tags: [] }), '正文');
});

test('media signatures preserve full image/video file formats and reject downloaded error pages', () => {
  const mp4 = new Uint8Array([0, 0, 0, 24, ...Buffer.from('ftypisom')]);
  assert.equal(mediaExtension(mp4, 'video'), 'mp4');
  assert.throws(() => mediaExtension(mp4, 'image'), /不是可保存的图片/);
  assert.equal(mediaExtension(new Uint8Array([0xFF, 0xD8, 0xFF, 0]), 'image'), 'jpg');
  assert.throws(() => mediaExtension(Buffer.from('<html>403</html>'), 'video'), /不是可保存的视频/);
  assert.throws(() => mediaExtension(Buffer.from('<html>403</html>'), 'image'), /不是可保存的图片/);
  assert.equal(mediaFilename('a/b?sig=secret', 'mp4'), 'outfit-a_b_sig_secret.mp4');
  assert.ok(mediaFilename('a'.repeat(500), 'jpg').length < 120);
});


test('empty or duplicate image selections cannot appear ready for publishing', async () => {
  for (const image_ids of [[], ['cover', 'cover']]) {
    const { calls, actions } = recorder();
    await assert.rejects(preparePublish({ ...note, image_ids }, images, undefined, emptyPublishProgress(), actions));
    assert.deepEqual(calls, []);
  }
});

test('saved image order changes are detectable without downloading completed images twice', async () => {
  const progress = emptyPublishProgress();
  const { calls, actions } = recorder();
  await preparePublish(note, images, undefined, progress, actions);
  const reordered = ['second', 'cover', 'third'];
  assert.equal(savedImagesAreInOrder(reordered, progress.savedImageIds), false);
  assert.equal(savedImagesAreInOrder(['cover', 'second'], progress.savedImageIds), true);
  assert.equal(savedImagesAreInOrder(['new', 'cover', 'second'], progress.savedImageIds), false);
  await preparePublish({ ...note, image_ids: reordered }, images, undefined, progress, actions);
  assert.deepEqual(calls, ['copy', 'cover', 'second', 'third', 'share', 'share']);
});


test('a queued image URL is not treated as a finished image asset', async () => {
  const { calls, actions } = recorder();
  await assert.rejects(preparePublish(note, images.map(image => ({ ...image, status: image.id === 'cover' ? 'running' as const : 'succeeded' as const })), undefined, emptyPublishProgress(), actions), /第 1 张图片/);
  assert.deepEqual(calls, ['copy']);
});
