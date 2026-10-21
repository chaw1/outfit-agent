import assert from 'node:assert/strict';
import { test } from 'node:test';
import { previewUrl } from '../src/lib/previewUrl';

test('服务端媒体链接追加预览宽度，默认 720', () => {
  const url = 'https://example.test/media/abc?exp=1&sig=ff';
  assert.equal(previewUrl(url), `${url}&w=720`);
  assert.equal(previewUrl(url, 360), `${url}&w=360`);
});

test('已带宽度、非媒体链接、空值原样返回', () => {
  assert.equal(previewUrl('https://example.test/media/abc?exp=1&sig=ff&w=720'), 'https://example.test/media/abc?exp=1&sig=ff&w=720');
  assert.equal(previewUrl('https://example.test/static/a.png'), 'https://example.test/static/a.png');
  assert.equal(previewUrl(null), null);
  assert.equal(previewUrl(undefined), undefined);
});
