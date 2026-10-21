import assert from 'node:assert/strict';
import test from 'node:test';
import type { Project, Stage } from '../src/api/types';
import { filterByStage, stageFilters } from '../src/lib/projectProgress';

const project = (id: string, stage: Stage): Project => ({ id, title: id, brand: '', brief: '', stage, created_at: '2026-10-21', updated_at: '2026-10-21' });

test('阶段筛选项只列出现过的阶段，按流程顺序带数量', () => {
  const items = [project('a', 'done'), project('b', 'images'), project('c', 'done'), project('d', 'script')];
  assert.deepEqual(stageFilters(items), [{ stage: 'script', count: 1 }, { stage: 'images', count: 1 }, { stage: 'done', count: 2 }]);
  assert.deepEqual(stageFilters([]), []);
});

test('按阶段过滤；空阶段返回全部的副本', () => {
  const items = [project('a', 'done'), project('b', 'images')];
  assert.deepEqual(filterByStage(items, 'done').map(item => item.id), ['a']);
  assert.deepEqual(filterByStage(items, 'brief'), []);
  const all = filterByStage(items, '');
  assert.deepEqual(all, items);
  assert.notEqual(all, items);
});
