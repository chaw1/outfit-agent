import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient, ApiError } from '../src/api/client';
import type { Project, UpdateMeInput, User } from '../src/api/types';
import { filterProjects, parseHeight, parsePhotoCache, profileCacheKey, profilePhotos, setDefaultPhoto, supportsProfile } from '../src/lib/profile';

const oldUser: User = { id: 'u1', username: 'gary', nickname: '嘉伟', created_at: '2026-10-21T00:00:00Z' };
const project = (id: string, title: string, brand: string): Project => ({ id, title, brand, brief: '', stage: 'brief', created_at: '', updated_at: '' });

test('profile capability requires new fields; older me responses remain usable', () => {
  assert.equal(supportsProfile(null), false);
  assert.equal(supportsProfile(oldUser), false);
  assert.equal(supportsProfile({ ...oldUser, profile: { model_asset_ids: [] } }), true);
});

test('profile preview cache is isolated by server and account, while canonical API suffixes share a cache', () => {
  assert.equal(profileCacheKey('http://localhost:19301/api/', 'u1'), profileCacheKey('http://localhost:19301', 'u1'));
  assert.notEqual(profileCacheKey('http://localhost:19301', 'u1'), profileCacheKey('http://localhost:19302', 'u1'));
  assert.notEqual(profileCacheKey('http://localhost:19301', 'u1'), profileCacheKey('http://localhost:19301', 'u2'));
  assert.deepEqual(parsePhotoCache('corrupted'), []);
  assert.deepEqual(parsePhotoCache('{"id":"bad"}'), []);
  assert.deepEqual(parsePhotoCache('[null,{"id":"a","url":"data:image/jpeg;base64,a"},{"id":1,"url":"bad"}]'), [{ id: 'a', url: 'data:image/jpeg;base64,a' }]);
});

test('profile preview follows saved order, hides removed photos, and preserves unknown IDs for other devices', () => {
  const photos = [{ id: 'a', url: 'local-a' }, { id: 'removed', url: 'local-removed' }, { id: 'b', url: 'local-b' }];
  const ids = ['a', 'b', 'not-cached'];
  assert.deepEqual(profilePhotos(setDefaultPhoto(ids, 'b'), photos), [{ id: 'b', url: 'local-b' }, { id: 'a', url: 'local-a' }, { id: 'not-cached' }]);
  assert.deepEqual(setDefaultPhoto(ids, 'not-owned'), ids);
  assert.deepEqual(ids, ['a', 'b', 'not-cached'], 'choosing a default cannot mutate the current saved profile');
});

test('height accepts empty optional values and rejects unusable measurements before patching', () => {
  assert.equal(parseHeight(' '), undefined);
  assert.equal(parseHeight('168.5'), 168.5);
  for (const value of ['NaN', '0', '79', '251', '-168', '168cm']) assert.throws(() => parseHeight(value), /80–250/);
});

test('project search matches title and brand, ignoring case and surrounding whitespace', () => {
  const projects = [project('1', '秋日衬衫', 'COS'), project('2', '通勤外套', 'Arket')];
  assert.deepEqual(filterProjects(projects, ' cos '), [projects[0]]);
  assert.deepEqual(filterProjects(projects, '通勤'), [projects[1]]);
  assert.deepEqual(filterProjects(projects, ''), projects);
  assert.deepEqual(filterProjects(projects, '不存在'), []);
});

test('profile patch preserves photo order, nickname and clearing values, and deletion escapes the project ID', async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  const updated: User = { ...oldUser, nickname: '新昵称', profile: { model_asset_ids: ['b', 'a'], body_notes: '', style_notes: '不穿高跟鞋' } };
  const client = new ApiClient({ baseUrl: 'http://localhost:19301', token: 'local-only', fetchImpl: (async (url, init) => {
    requests.push({ url: String(url), init });
    return init?.method === 'DELETE' ? new Response(null, { status: 204 }) : new Response(JSON.stringify(updated));
  }) as typeof fetch });
  const input: UpdateMeInput = { nickname: '新昵称', profile: { model_asset_ids: ['b', 'a'], height_cm: null, body_notes: '', style_notes: '不穿高跟鞋' } };
  assert.deepEqual(await client.patchMe(input), updated);
  assert.equal(requests[0].init?.method, 'PATCH');
  assert.deepEqual(JSON.parse(String(requests[0].init?.body)), input);
  assert.equal(new Headers(requests[0].init?.headers).get('Authorization'), 'Bearer local-only');
  await client.deleteProject('p/1');
  assert.equal(requests[1].url, 'http://localhost:19301/api/projects/p%2F1');
  assert.equal(requests[1].init?.method, 'DELETE');
});

test('missing profile endpoint exposes a 404 capability error without invalidating authentication', async () => {
  let unauthorized = false;
  const client = new ApiClient({ baseUrl: 'http://localhost:19301', onUnauthorized: () => { unauthorized = true; }, fetchImpl: (async () => new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: '当前服务未开通' } }), { status: 404 })) as typeof fetch });
  await assert.rejects(client.patchMe({ nickname: '新昵称' }), (error: unknown) => error instanceof ApiError && error.status === 404);
  assert.equal(unauthorized, false);
});
