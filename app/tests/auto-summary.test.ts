import assert from 'node:assert/strict';
import test from 'node:test';
import type { OutfitImage } from '../src/api/types';
import { autoSummary, autoSummaryLine } from '../src/lib/autoProgress';

const image = (id: string, status: OutfitImage['status'] = 'succeeded'): OutfitImage => ({ id, shot_id: 's1', status, version: 1, ...(status === 'succeeded' ? { url: `https://x/${id}.jpg` } : {}) });

test('一键出片收尾账统计成功的图、入稿数、笔记标题与短片状态', () => {
  const summary = autoSummary({
    images: [image('a'), image('b'), image('c', 'failed')],
    note: { title: ' 周三的松弛通勤 ', body: '', tags: [], image_ids: ['a', 'b'] },
    video: { status: 'succeeded', url: 'https://x/v.mp4' },
  });
  assert.deepEqual(summary, { images: 2, selected: 2, noteTitle: '周三的松弛通勤', video: 'ready' });
  assert.equal(autoSummaryLine(summary), '出了 2 张图 · 入稿 2 张 · 笔记《周三的松弛通勤》已写好 · 短片已生成');
});

test('没有笔记和短片时收尾账如实说明', () => {
  const summary = autoSummary({ images: [image('a')] });
  assert.deepEqual(summary, { images: 1, selected: 0, noteTitle: '', video: 'none' });
  assert.equal(autoSummaryLine(summary), '出了 1 张图 · 笔记未写 · 没有短片');
  assert.equal(autoSummaryLine(autoSummary({ images: [], video: { status: 'running' } })), '出了 0 张图 · 笔记未写 · 短片还在做');
  assert.equal(autoSummaryLine(autoSummary({ images: [], video: { status: 'failed' } })), '出了 0 张图 · 笔记未写 · 短片没做成');
});
