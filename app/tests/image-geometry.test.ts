import assert from 'node:assert/strict';
import test from 'node:test';
import { containRect, constrainTransform, editActionForResult, imageToScreen, imageVersionFamily, regionFromPoints, screenBrushToNormalized, screenToImage, zoomAtPoint, IDENTITY_TRANSFORM } from '../src/lib/imageGeometry';

const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

test('contain fit locates horizontal and vertical letterbox margins', () => {
  const portrait = containRect({ width: 800, height: 1200 }, { width: 400, height: 400 })!;
  close(portrait.x, 200 / 3);
  close(portrait.width, 800 / 3);
  assert.equal(portrait.y, 0);
  assert.equal(portrait.height, 400);
  assert.deepEqual(containRect({ width: 1200, height: 600 }, { width: 400, height: 500 }), { x: 0, y: 150, width: 400, height: 200 });
  assert.deepEqual(containRect({ width: 200, height: 200 }, { width: 400, height: 400 }), { x: 0, y: 0, width: 400, height: 400 });
});

test('drawing starts in contain whitespace are rejected instead of leaking into a mask', () => {
  const viewport = { width: 400, height: 500 };
  const rect = containRect({ width: 1200, height: 600 }, viewport)!;
  assert.equal(screenToImage({ x: 100, y: 100 }, rect, viewport, IDENTITY_TRANSFORM), null);
  assert.deepEqual(screenToImage({ x: 100, y: 150 }, rect, viewport, IDENTITY_TRANSFORM), { x: .25, y: 0 });
  assert.deepEqual(screenToImage({ x: 500, y: 600 }, rect, viewport, IDENTITY_TRANSFORM, true), { x: 1, y: 1 });
});

test('normalization round trips portrait, landscape and square images through letterbox, zoom and pan', () => {
  for (const image of [{ width: 768, height: 1024 }, { width: 1600, height: 600 }, { width: 900, height: 900 }]) {
    for (const viewport of [{ width: 390, height: 430 }, { width: 844, height: 260 }]) {
      const rect = containRect(image, viewport)!;
      for (const transform of [IDENTITY_TRANSFORM, { scale: 2.5, translateX: 73, translateY: -81 }, { scale: 5, translateX: -200, translateY: 150 }]) {
        for (const point of [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: .32, y: .74 }, { x: .5, y: .5 }]) {
          const result = screenToImage(imageToScreen(point, rect, viewport, transform), rect, viewport, transform)!;
          close(result.x, point.x);
          close(result.y, point.y);
        }
      }
    }
  }
});

test('coordinates are not divided by viewport width when the image has side margins', () => {
  const viewport = { width: 400, height: 400 }, rect = containRect({ width: 100, height: 400 }, viewport)!;
  assert.deepEqual(screenToImage({ x: 175, y: 100 }, rect, viewport, IDENTITY_TRANSFORM), { x: .25, y: .25 });
  assert.equal(screenToImage({ x: 149, y: 200 }, rect, viewport, IDENTITY_TRANSFORM), null);
});

test('known screen coordinates invert both scale and translation after contain fit', () => {
  const viewport = { width: 400, height: 500 };
  const rect = containRect({ width: 1200, height: 600 }, viewport)!;
  assert.deepEqual(screenToImage({ x: 30, y: 310 }, rect, viewport, { scale: 2, translateX: 30, translateY: -40 }), { x: .25, y: .75 });
});

test('rectangle supports reverse drag, clamps to bounds and keeps the x/y/w/h contract', () => {
  assert.deepEqual(regionFromPoints({ x: .8, y: .7 }, { x: .2, y: .1 }), { x: .2, y: .1, w: .6000000000000001, h: .6 });
  assert.deepEqual(regionFromPoints({ x: -2, y: 1.4 }, { x: 2, y: -.2 }), { x: 0, y: 0, w: 1, h: 1 });
  assert.deepEqual(regionFromPoints({ x: .5, y: .5 }, { x: .5, y: .5 }), { x: .5, y: .5, w: 0, h: 0 });
});

test('brush width uses the displayed short edge with zoom removed', () => {
  const rect = { x: 100, y: 0, width: 200, height: 400 };
  close(screenBrushToNormalized(20, rect, 1), .1);
  close(screenBrushToNormalized(40, rect, 2), .1);
  assert.equal(screenBrushToNormalized(1000, rect, 1), 1);
  assert.equal(screenBrushToNormalized(-10, rect, 1), 0);
});

test('pan limits preserve visible image and reset axes that have not filled the viewport', () => {
  const viewport = { width: 400, height: 500 }, rect = { x: 75, y: 0, width: 250, height: 500 };
  assert.deepEqual(constrainTransform({ scale: .5, translateX: 100, translateY: 100 }, rect, viewport), IDENTITY_TRANSFORM);
  assert.deepEqual(constrainTransform({ scale: 2, translateX: 900, translateY: -900 }, rect, viewport), { scale: 2, translateX: 50, translateY: -250 });
  assert.equal(constrainTransform({ scale: 99, translateX: 0, translateY: 0 }, rect, viewport).scale, 5);
});

test('pinch anchored at a focal point preserves the original image point', () => {
  const viewport = { width: 400, height: 400 }, rect = containRect({ width: 400, height: 400 }, viewport)!;
  const focal = { x: 130, y: 170 };
  const before = screenToImage(focal, rect, viewport, IDENTITY_TRANSFORM)!;
  const transform = zoomAtPoint(IDENTITY_TRANSFORM, 3, focal, viewport, rect);
  const after = screenToImage(focal, rect, viewport, transform)!;
  close(after.x, before.x);
  close(after.y, before.y);
  assert.deepEqual(zoomAtPoint(transform, 1, focal, viewport, rect), IDENTITY_TRANSFORM);
});

test('invalid image dimensions and transforms never emit nonfinite API coordinates', () => {
  for (const size of [{ width: 0, height: 1 }, { width: -1, height: 1 }, { width: Infinity, height: 100 }, { width: 100, height: NaN }]) {
    assert.equal(containRect(size, { width: 400, height: 400 }), null);
  }
  const rect = { x: 0, y: 0, width: 200, height: 300 }, viewport = { width: 400, height: 400 };
  for (const transform of [{ scale: 0, translateX: 0, translateY: 0 }, { scale: NaN, translateX: 0, translateY: 0 }, { scale: 1, translateX: Infinity, translateY: 0 }]) {
    assert.equal(screenToImage({ x: 1, y: 1 }, rect, viewport, transform), null);
  }
  assert.equal(screenBrushToNormalized(20, rect, 0), 0);
});

test('version strip follows parent links and excludes unrelated images sharing a shot', () => {
  const root = { id: 'a', version: 1, shot_id: 'one' };
  const child = { id: 'b', version: 2, parent_id: 'a', shot_id: 'one' };
  const grandchild = { id: 'c', version: 3, parent_id: 'b', shot_id: 'one' };
  const branch = { id: 'd', version: 3, parent_id: 'a', shot_id: 'one' };
  const unrelated = { id: 'x', version: 99, shot_id: 'one' };
  assert.deepEqual(imageVersionFamily([unrelated, grandchild, branch, root, child], 'c').map(image => image.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(imageVersionFamily([root, child], 'missing'), []);
  assert.deepEqual(imageVersionFamily([{ id: 'orphan', version: 2, parent_id: 'missing' }], 'orphan').map(image => image.id), ['orphan']);
});

test('malformed cyclic version links terminate and include each member once', () => {
  const result = imageVersionFamily([{ id: 'a', version: 1, parent_id: 'b' }, { id: 'b', version: 2, parent_id: 'a' }], 'a');
  assert.equal(result.length, 2);
  assert.equal(new Set(result.map(image => image.id)).size, 2);
});

test('reopened identical edit instructions recover the mask for that specific result', () => {
  const images = [{ id: 'original', version: 1 }, { id: 'left-result', parent_id: 'original', version: 2, instruction: '袖口放下来' }, { id: 'right-result', parent_id: 'original', version: 3, instruction: '袖口放下来' }];
  const actions = [{ image_id: 'other', instruction: '袖口放下来', mask_strokes: { brush: .1, strokes: [[{ x: .1, y: .1 }]] } }, { image_id: 'original', instruction: '袖口放下来', mask_strokes: { brush: .05, strokes: [[{ x: .2, y: .4 }]] } }, { image_id: 'original', instruction: '袖口放下来', mask_strokes: { brush: .08, strokes: [[{ x: .8, y: .5 }]] } }];
  assert.deepEqual(editActionForResult(images, actions, 'left-result'), actions[1]);
  assert.deepEqual(editActionForResult(images, actions, 'right-result'), actions[2]);
  assert.equal(editActionForResult(images, actions, 'original'), undefined);
});
