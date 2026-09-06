import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { convexHull, finishFloorTexture, insideHull, planFloorRepair, visibleFloorSamples } from '../src/editor/backgroundRepair';

function floorScene() {
  const points: number[] = [], horizontal: number[] = [];
  for (let x = -3; x < 4; x += .06) for (let z = -5; z < 2; z += .06) { points.push(x, 0, z); horizontal.push(1); }
  const selected: number[] = [];
  for (const x of [0, 1]) for (const z of [-2, -1]) for (const y of [.1, 1]) { selected.push(horizontal.length); points.push(x, y, z); horizontal.push(0); }
  const residue = horizontal.length; points.push(.5, .6, -1.5); horizontal.push(0);
  const otherObject = horizontal.length; points.push(.5, .5, -1.5); horizontal.push(0);
  const outside = horizontal.length; points.push(2.5, .5, -1.5); horizontal.push(0);
  const claimed = new Uint8Array(horizontal.length); [...selected, otherObject].forEach(i => claimed[i] = 1);
  return { points: Float32Array.from(points), horizontal: Uint8Array.from(horizontal), selected, claimed, residue, otherObject, outside };
}

test('floor reconstruction infers support, cleans only the footprint, and respects object ownership and room bounds', () => {
  const f = floorScene(), plan = planFloorRepair(f.points, f.horizontal, f.selected, f.claimed, new THREE.Vector3(0, 1.6, 0));
  assert.ok(plan); assert.equal(plan.y, 0); assert.ok(plan.donors.length > 30);
  assert.ok(plan.cleanup.includes(f.residue)); assert.ok(!plan.cleanup.includes(f.otherObject)); assert.ok(!plan.cleanup.includes(f.outside));
  for (const [x, z] of plan.polygon) { assert.ok(x >= -3 && x <= 4); assert.ok(z >= -5 && z <= 2); }
  assert.ok(insideHull(.5, -1.5, plan.polygon));
  assert.ok(plan.donors.every(i => !f.claimed[i]));
});

test('repair declines unsupported scenes instead of creating arbitrary geometry', () => {
  const f = floorScene();
  assert.equal(planFloorRepair(f.points, new Uint8Array(f.horizontal.length), f.selected, f.claimed, new THREE.Vector3(0, 1.6, 0)), null);
  const lifted = f.points.slice(); f.selected.forEach(i => lifted[i * 3 + 1] += 2);
  assert.equal(planFloorRepair(lifted, f.horizontal, f.selected, f.claimed, new THREE.Vector3(0, 1.6, 0)), null);
});

test('floor samples occluded in the original capture cannot donate furniture-colored texture', () => {
  const points = Float32Array.from([0, 1, -1, 0, 0, -2, 1, 0, -2]);
  assert.deepEqual(Array.from(visibleFloorSamples(points, Uint8Array.from([0, 1, 1]), new Uint8Array(3), new THREE.Vector3(0, 2, 0))), [0, 0, 1]);
});

test('rendered texture gaps become opaque, borders join, and texture detail is retained', () => {
  const size = 16, input = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4; input.set([150 + x * 2, 135 + y * 2, 120 + x, x > 5 && x < 9 && y > 5 && y < 9 ? 0 : 255], i);
  }
  const texture = finishFloorTexture(input, size), pixels = texture.image.data as Uint8Array;
  for (let i = 0; i < size * size; i++) assert.equal(pixels[i * 4 + 3], 255);
  for (let y = 0; y < size; y++) assert.deepEqual(pixels.slice(y * size * 4, y * size * 4 + 3), pixels.slice((y * size + size - 1) * 4, (y * size + size - 1) * 4 + 3));
  assert.ok(new Set(Array.from(pixels).filter((_, i) => i % 4 === 0)).size > 4);
  assert.throws(() => finishFloorTexture(new Uint8Array(16), 2), /No opaque floor/);
  texture.dispose();
});

test('convex footprint excludes empty AABB corners', () => {
  const hull = convexHull([[0, 0], [2, 0], [1, 2], [1, 1]]);
  assert.ok(insideHull(1, 1, hull)); assert.ok(!insideHull(0, 2, hull));
});
