import assert from 'node:assert/strict';
import test from 'node:test';
import { STYLE_TAGS, styleBatch, toggleStyleTag } from '../src/lib/styleTags';

test('风格词条每批八个，换一批可看到全部十二个，选择跨批保留', () => {
  const first = styleBatch(0), second = styleBatch(1);
  assert.equal(STYLE_TAGS.length, 12);
  assert.equal(new Set(first).size, 8);
  assert.equal(new Set(second).size, 8);
  assert.notDeepEqual(first, second);
  assert.equal(new Set([...first, ...second]).size, 12);
  assert.deepEqual(styleBatch(3), first);
  const selected = toggleStyleTag([], first[0]);
  assert.deepEqual(toggleStyleTag(selected, second[0]), [first[0], second[0]]);
  assert.deepEqual(toggleStyleTag(selected, first[0]), []);
});

test('风格最多六个且仅接受约定词条', () => {
  const selected = STYLE_TAGS.slice(0, 6);
  assert.deepEqual(toggleStyleTag(selected, STYLE_TAGS[6]), selected);
  assert.equal(toggleStyleTag(selected, selected[0]).length, 5);
  assert.deepEqual(toggleStyleTag([], '不存在的风格'), []);
});
