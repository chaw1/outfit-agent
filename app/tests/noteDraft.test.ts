import assert from 'node:assert/strict';
import test from 'node:test';
import { applyNoteDraft, cleanTag, draftFromNote, draftStorageKey, limitTitle, moveDraftImage, readNoteDraft, titleLength, writeNoteDraft, type DraftStorage } from '../src/lib/noteDraft';
import { emptyPublishProgress, preparePublish } from '../src/lib/publish';

const note = { title: '秋日穿搭', body: '原始正文', tags: ['#穿搭', '穿搭', '日常'], image_ids: ['cover', 'second'], cost_cny: 1.2, ai_label: 'AI 生成' };
function storage() {
  const data = new Map<string, string>();
  const store: DraftStorage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); } };
  return { data, store };
}

test('title counter counts Chinese and complete emoji without splitting surrogate pairs', () => {
  assert.equal(titleLength('秋日🍂穿搭'), 5);
  assert.equal(titleLength(limitTitle('衣'.repeat(19) + '🍂尾')), 20);
  assert.equal(limitTitle('衣'.repeat(19) + '🍂尾'), '衣'.repeat(19) + '🍂');
});

test('draft starts with AI disclosure checked and normalized topic capsules', () => {
  const draft = draftFromNote(note);
  assert.equal(draft.aiConfirmed, true);
  assert.deepEqual(draft.tags, ['穿搭', '日常']);
  assert.equal(cleanTag(' ## 今日 穿搭 '), '今日穿搭');
  draft.image_ids.reverse();
  assert.deepEqual(note.image_ids, ['cover', 'second']);
});

test('explicit local save survives a fresh reader and remains scoped to account, project and server', () => {
  const { store, data } = storage();
  const scope = 'http://127.0.0.1:19301|user-a|project-a';
  const draft = { ...draftFromNote(note), title: '我的新标题', body: '新的正文', tags: ['咖啡馆'], image_ids: ['second', 'cover'], aiConfirmed: false };
  assert.equal(writeNoteDraft(scope, draft, store), true);
  assert.deepEqual(readNoteDraft(scope, store), draft);
  assert.equal(readNoteDraft('http://127.0.0.1:19301|user-b|project-a', store), null);
  data.set(draftStorageKey(scope), JSON.stringify({ version: 1, scope: 'wrong scope', draft }));
  assert.equal(readNoteDraft(scope, store), null);
});

test('corrupt and incomplete drafts fall back safely; failed writes do not claim success', () => {
  const { store, data } = storage();
  for (const raw of ['{broken', '{}', JSON.stringify({ version: 1, scope: 'a', draft: { ...draftFromNote(note), image_ids: ['cover', 'cover'] } })]) {
    data.set(draftStorageKey('a'), raw);
    assert.equal(readNoteDraft('a', store), null);
  }
  assert.equal(writeNoteDraft('a', draftFromNote(note), { ...store, setItem: () => { throw new Error('disk full'); } }), false);
  assert.equal(readNoteDraft('a', { ...store, getItem: () => { throw new Error('storage denied'); } }), null);
});

test('image order moves without losing images and stops at the boundaries', () => {
  assert.deepEqual(moveDraftImage(note.image_ids, 1, -1), ['second', 'cover']);
  assert.deepEqual(moveDraftImage(note.image_ids, 0, -1), note.image_ids);
  assert.deepEqual(moveDraftImage(note.image_ids, 1, 1), note.image_ids);
  assert.deepEqual(note.image_ids, ['cover', 'second']);
});

test('publishing a local override copies all edited fields and saves media in the edited order', async () => {
  const draft = { ...draftFromNote(note), title: '编辑标题', body: '编辑正文', tags: ['新话题'], image_ids: ['second', 'cover'] };
  const effective = applyNoteDraft(note, draft);
  assert.equal(effective.ai_label, 'AI 生成');
  assert.equal(effective.cost_cny, 1.2);
  const calls: string[] = [];
  await preparePublish(effective, [{ id: 'cover', url: '/1.jpg' }, { id: 'second', url: '/2.jpg' }], undefined, emptyPublishProgress(), {
    copy: async text => { calls.push(text); },
    saveImage: async image => { calls.push(image.id); },
    saveVideo: async () => {},
    share: async title => { calls.push(title); return 'shared'; },
  });
  assert.deepEqual(calls, ['编辑标题\n\n编辑正文\n\n#新话题', 'second', 'cover', '编辑标题']);
  assert.equal(note.title, '秋日穿搭');
});
