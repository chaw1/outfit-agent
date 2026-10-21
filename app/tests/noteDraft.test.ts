import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { applyNoteDraft, changeNoteDraft, cleanTag, draftFromNote, draftStorageKey, hasNoteDraftConflict, keepNoteDraft, limitTitle, moveDraftImage, noteSourceFingerprint, readNoteDraft, readPreviousNoteDraft, reconcileNoteDraft, titleLength, writeNoteDraft, writePreviousNoteDraft, type DraftStorage } from '../src/lib/noteDraft';
import { sha256 } from '../src/lib/sha256';
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
  assert.equal(draft.dirty, false);
  assert.equal(draft.sourceFingerprint, noteSourceFingerprint(note));
  assert.deepEqual(draft.tags, ['穿搭', '日常']);
  assert.equal(cleanTag(' ## 今日 穿搭 '), '今日穿搭');
  draft.image_ids.reverse();
  assert.deepEqual(note.image_ids, ['cover', 'second']);
});

test('draft fingerprints are SHA-256 over every source publishing field, including ordered media', () => {
  const expected = createHash('sha256').update(JSON.stringify([note.title, note.body, note.tags, note.image_ids])).digest('hex');
  assert.equal(noteSourceFingerprint(note), expected);
  for (const changed of [
    { ...note, title: '新标题' }, { ...note, body: '新的正文' },
    { ...note, tags: [...note.tags, '新话题'] }, { ...note, image_ids: [...note.image_ids].reverse() },
  ]) assert.notEqual(noteSourceFingerprint(changed), expected);
  const metadataOnly = { ...note, cost_cny: 20 };
  assert.equal(noteSourceFingerprint(metadataOnly), expected);
  assert.notEqual(noteSourceFingerprint({ ...note, title: 'a', body: 'bc' }), noteSourceFingerprint({ ...note, title: 'ab', body: 'c' }));
});

test('cross-platform SHA-256 matches standard hashes across UTF-8 and block boundaries', () => {
  for (const text of ['', 'abc', '秋日🍂穿搭', '\ud800', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), '衣🍂'.repeat(1000)]) {
    assert.equal(sha256(text), createHash('sha256').update(text).digest('hex'));
  }
});

test('clean drafts follow server revisions, including the newly adopted image and image order', () => {
  const initial = draftFromNote(note);
  const latest = { ...note, title: '服务端的新标题', image_ids: ['cover-v2', 'second'] };
  const synced = reconcileNoteDraft(latest, initial);
  assert.equal(synced.title, latest.title);
  assert.deepEqual(synced.image_ids, latest.image_ids);
  assert.equal(synced.sourceFingerprint, noteSourceFingerprint(latest));
  assert.equal(synced.dirty, false);
  assert.equal(hasNoteDraftConflict(latest, synced), false);
});

test('dirty drafts survive a server revision until the user chooses to keep or adopt', () => {
  const initial = draftFromNote(note);
  assert.equal(changeNoteDraft(initial, { title: initial.title }).dirty, false);
  const authored = changeNoteDraft(initial, { title: '我的标题', tags: ['我的话题'], image_ids: ['second', 'cover'] });
  assert.equal(authored.dirty, true);
  assert.equal(hasNoteDraftConflict(note, authored), false);
  const latest = { ...note, title: '新的服务端标题', image_ids: ['cover-v2', 'second'] };
  assert.equal(reconcileNoteDraft(latest, authored), authored);
  assert.equal(hasNoteDraftConflict(latest, authored), true);
  const kept = keepNoteDraft(latest, authored);
  assert.equal(kept.title, authored.title);
  assert.deepEqual(kept.image_ids, authored.image_ids);
  assert.equal(kept.dirty, true);
  assert.equal(hasNoteDraftConflict(latest, kept), false);
  assert.equal(hasNoteDraftConflict({ ...latest, body: '又一次修订' }, kept), true);
  const adopted = draftFromNote(latest);
  assert.equal(adopted.title, latest.title);
  assert.equal(adopted.dirty, false);
  assert.deepEqual(adopted.image_ids, latest.image_ids);
  assert.equal(hasNoteDraftConflict(latest, adopted), false);
});

test('legacy authored drafts are preserved and ask before a source without a recorded fingerprint replaces them', () => {
  const { store, data } = storage();
  const legacy = { title: '旧草稿', body: '保留这段话', tags: ['咖啡馆'], image_ids: ['cover'], aiConfirmed: false };
  data.set(draftStorageKey('legacy'), JSON.stringify({ version: 1, scope: 'legacy', draft: legacy }));
  const recovered = readNoteDraft('legacy', store)!;
  assert.equal(recovered.dirty, true);
  assert.equal(recovered.sourceFingerprint, '');
  assert.equal(recovered.body, legacy.body);
  assert.equal(reconcileNoteDraft(note, recovered), recovered);
  assert.equal(hasNoteDraftConflict(note, recovered), true);
});

test('explicit adoption can preserve an independent recoverable copy of the authored draft', () => {
  const { store } = storage();
  const authored = changeNoteDraft(draftFromNote(note), { body: '这是我的修改' });
  assert.equal(writePreviousNoteDraft('project', authored, store), true);
  assert.equal(writeNoteDraft('project', draftFromNote({ ...note, body: '新的服务端正文' }), store), true);
  assert.equal(readNoteDraft('project', store)?.body, '新的服务端正文');
  assert.deepEqual(readPreviousNoteDraft('project', store), authored);
  assert.equal(readPreviousNoteDraft('another-project', store), null);
});

test('keeping an authored draft retains its manual image acceptance after the server adopts a verified revision', () => {
  const original = { ...note, image_ids: ['unchecked-a', 'second'], accepted_unverified_ids: ['unchecked-a', 'not-selected'] };
  const authored = changeNoteDraft(draftFromNote(original), { title: '我的标题', image_ids: ['second', 'unchecked-a'] });
  assert.deepEqual(authored.accepted_unverified_ids, ['unchecked-a']);
  const latest = { ...note, image_ids: ['verified-b', 'second'], accepted_unverified_ids: [] };
  const kept = keepNoteDraft(latest, reconcileNoteDraft(latest, authored));
  const effective = applyNoteDraft(latest, kept);
  assert.deepEqual(effective.image_ids, ['second', 'unchecked-a']);
  assert.deepEqual(effective.accepted_unverified_ids, ['unchecked-a']);
  assert.equal(effective.title, '我的标题');
  assert.equal(hasNoteDraftConflict(latest, kept), false);
  const { store } = storage();
  writeNoteDraft('project', kept, store);
  writePreviousNoteDraft('project', kept, store);
  assert.deepEqual(readNoteDraft('project', store)?.accepted_unverified_ids, ['unchecked-a']);
  assert.deepEqual(readPreviousNoteDraft('project', store)?.accepted_unverified_ids, ['unchecked-a']);
  const removed = changeNoteDraft(kept, { image_ids: ['second'] });
  assert.deepEqual(applyNoteDraft(latest, removed).accepted_unverified_ids, []);
  assert.deepEqual(applyNoteDraft(latest, draftFromNote(latest)).accepted_unverified_ids, []);
  const differentMetadata = { ...original, accepted_unverified_ids: [] };
  assert.equal(noteSourceFingerprint(original), noteSourceFingerprint(differentMetadata));
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
