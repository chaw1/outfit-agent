import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiClient } from '../src/api/client';
import { filterGarmentsByTag, garmentTagCounts, toggleGarmentTag } from '../src/lib/garmentTags';

const garments = [
  { id: 'shirt', tags: ['衬衫', '米白色', '简约'] },
  { id: 'pants', tags: ['牛仔裤', '浅蓝色', '简约', '简约'] },
  { id: 'legacy' },
];

test('garment filters match exact tags, include legacy clothes when unfiltered and toggle off', () => {
  assert.deepEqual(filterGarmentsByTag(garments, null), garments);
  assert.deepEqual(filterGarmentsByTag(garments, '衬衫').map(item => item.id), ['shirt']);
  assert.equal(filterGarmentsByTag(garments, '衬').length, 0);
  assert.equal(filterGarmentsByTag(garments, '简约').length, 2);
  assert.equal(filterGarmentsByTag(garments, '冬').length, 0);
  const selected = toggleGarmentTag(null, '衬衫');
  assert.equal(selected, '衬衫');
  assert.equal(toggleGarmentTag(selected, '牛仔裤'), '牛仔裤');
  assert.equal(toggleGarmentTag(selected, '衬衫'), null);
  assert.deepEqual(garments[1].tags, ['牛仔裤', '浅蓝色', '简约', '简约']);
});

test('picker tag counts count each garment once and show common tags first', () => {
  const counts = garmentTagCounts(garments);
  assert.deepEqual(counts[0], { tag: '简约', count: 2 });
  assert.equal(counts.length, 5);
  assert.deepEqual(garmentTagCounts([]), []);
});

test('asset requests encode tags, retain filtered pagination and expose the count endpoint', async () => {
  const urls: string[] = [];
  const api = new ApiClient({ baseUrl: 'http://localhost:19381', token: 'local-token', fetchImpl: async input => {
    urls.push(String(input));
    return new Response(JSON.stringify({ items: [], total: 0 }), { status: 200 });
  } });
  await api.myAssets('garment', 30, 30, '简约 / 日常');
  await api.myAssets('model', 30, 0, '简约');
  await api.myAssetTags();
  assert.equal(urls[0], `http://localhost:19381/api/me/assets?kind=garment&limit=30&offset=30&tag=${encodeURIComponent('简约 / 日常')}`);
  assert.equal(urls[1], 'http://localhost:19381/api/me/assets?kind=model&limit=30&offset=0');
  assert.equal(urls[2], 'http://localhost:19381/api/me/assets/tags?kind=garment');
});
