import assert from 'node:assert/strict';
import test from 'node:test';
import type { OutfitImage, ScriptData } from '../src/api/types';
import { coverFirstImageIds, isCoverImage } from '../src/lib/images';

const image = (id: string, shot_id: string, version = 1, extra: Partial<OutfitImage> = {}): OutfitImage => ({ id, shot_id, version, status: 'succeeded', url: `local/${id}`, ...extra });
const cover = image('cover', 'first');
const second = image('second', 'second', 1, { anchor_id: cover.id });
const script: ScriptData = { status: 'confirmed', title_ideas: [], cover: { scene: '', pose: '', text_overlay: '' }, shots: [{ id: 'first', scene: '', outfit_asset_ids: [], pose: '', camera: '', caption: '' }], video: { prompt: '', duration: 5 } };

test('cover is identified by anchor reference or the first script shot, never by array order', () => {
  assert.equal(isCoverImage(cover, [second, cover]), true);
  assert.equal(isCoverImage(second, [second, cover], script), false);
  assert.equal(isCoverImage(cover, [cover], script), true);
  assert.equal(isCoverImage(cover, [cover]), false);
  assert.equal(isCoverImage(cover, [cover], { ...script, shots: [] }), false);
});

test('latest verified cover wins by default; explicit adoption can choose a different version', () => {
  const newer = image('new', 'first', 2);
  const unverified = image('unverified', 'first', 3, { edit_check: { passed: false, reason: '待核对' } });
  const pending = image('pending', 'first', 4, { status: 'running' });
  const images = [second, cover, newer, unverified, pending];
  assert.equal(isCoverImage(cover, images, script), false);
  assert.equal(isCoverImage(newer, images, script), true);
  assert.equal(isCoverImage(unverified, images, script), false);
  assert.equal(isCoverImage(unverified, images, script, ['unverified', 'second']), true);
  assert.equal(isCoverImage(pending, images, script, ['pending']), false);
  assert.equal(isCoverImage(cover, images, script, ['cover', 'second']), true);
});

test('cover order survives moves, saved drafts and replacement with a version of the same shot', () => {
  const newer = image('new', 'first', 2);
  const images = [cover, second, newer];
  const ids = ['second', 'cover'];
  assert.deepEqual(coverFirstImageIds(ids, images, script), ['cover', 'second']);
  assert.deepEqual(ids, ['second', 'cover']);
  assert.deepEqual(coverFirstImageIds(['second', 'new'], images, script), ['new', 'second']);
  assert.deepEqual(coverFirstImageIds(['second'], images, script), ['new', 'second']);
  assert.deepEqual(coverFirstImageIds([], images, script), []);
  assert.deepEqual(coverFirstImageIds(['second', 'cover'], [cover, image('second', 'second')]), ['second', 'cover']);
});
