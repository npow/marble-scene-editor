import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { claimedIndices, depthSelection, projectMask, subsetWords, validateProject, type EditProject, type SceneObject } from '../src/editor/selection';

const object = (indices = [0, 1]): SceneObject => ({ id: 'sofa', name: 'Sofa', indices, origin: [0, 0, 0], position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1], deleted: false });
const source: EditProject['source'] = { name: 'room.spz', sha256: 'a'.repeat(64), count: 5, kind: 'splats', transform: new THREE.Matrix4().toArray() };

test('mask projection excludes geometry behind the camera, outside the mask, and already assigned', () => {
  const camera = new THREE.PerspectiveCamera(90, 1, .1, 100);
  const points = Float32Array.from([0, 0, -3, 0, 0, -8, 0, 0, 3, 9, 0, -3, 0, 0, -2]);
  const mask = { width: 10, height: 10, pixels: new Uint8Array(100) }; mask.pixels[55] = 255;
  const projected = projectMask(points, Uint8Array.from([0, 0, 0, 0, 1]), mask, new THREE.Matrix4(), camera.projectionMatrix);
  assert.deepEqual(Array.from(projected.ids), [0, 1]);
  assert.deepEqual(depthSelection(projected, 2, 5), [0], 'depth limit excludes the wall behind the object');
  assert.deepEqual(depthSelection(projected, 9, 2), []);
});

test('deleted segments remain absent from the original room, and restored state reverses that', () => {
  const deleted = { ...object([1, 3]), deleted: true };
  assert.deepEqual(Array.from(claimedIndices([deleted], 5)), [0, 1, 0, 1, 0]);
  assert.deepEqual(Array.from(claimedIndices([], 5)), [0, 0, 0, 0, 0]);
});

test('transparent splats can be selected without biasing the visible surface depth', () => {
  const camera = new THREE.PerspectiveCamera(90, 1, .1, 100);
  const points = Float32Array.from([0, 0, -1, 0, 0, -3, 0, 0, -3.1]);
  const result = projectMask(points, new Uint8Array(3), { width: 10, height: 10, pixels: new Uint8Array(100).fill(255) }, new THREE.Matrix4(), camera.projectionMatrix, Uint8Array.from([1, 0, 1]));
  assert.deepEqual(Array.from(result.ids), [0, 1, 2]);
  assert.deepEqual(depthSelection(result, result.near, result.far), [1, 2]);
});

test('local visible depth rejects a wall inside the global range of a long object', () => {
  const camera = new THREE.PerspectiveCamera(90, 1, .1, 100);
  const points = Float32Array.from([0, 0, -3, 0, 0, -5, 2, 0, -6]);
  const result = projectMask(points, new Uint8Array(3), { width: 100, height: 100, pixels: new Uint8Array(10000).fill(255) }, new THREE.Matrix4(), camera.projectionMatrix);
  assert.deepEqual(depthSelection(result, 2, 7), [0, 2]);
});

test('subsetting preserves packed geometry and every SH word exactly, including nonsequential indices', () => {
  for (const stride of [2, 4]) {
    const input = Uint32Array.from({ length: stride * 5 }, (_, i) => (0xf0000000 + i) >>> 0);
    const subset = subsetWords(input, [4, 1], stride, 4);
    assert.deepEqual(subset.slice(0, stride), input.slice(4 * stride, 5 * stride));
    assert.deepEqual(subset.slice(stride, 2 * stride), input.slice(stride, 2 * stride));
    assert.ok(subset.slice(2 * stride).every(v => v === 0));
  }
});

test('project roundtrip preserves source indices, deleted state and object transforms', () => {
  const project: EditProject = { format: 'marble-scene-editor', version: 1, source, objects: [{ ...object(), deleted: true }], repairBackground: false };
  assert.deepEqual(validateProject(JSON.parse(JSON.stringify(project)), source), project);
});

test('project rejects another source, overlapping/out-of-range indices, invalid transforms and duplicate IDs', () => {
  const base: EditProject = { format: 'marble-scene-editor', version: 1, source, objects: [object()] };
  assert.throws(() => validateProject(base, { ...source, sha256: 'b'.repeat(64) }), /original source/);
  for (const objects of [[object([5])], [object([-1])], [object([0.5])], [object([0, 0])], [object(), { ...object([2]), id: 'sofa' }], [object(), { ...object([1, 2]), id: 'table' }], [{ ...object(), scale: [0, 1, 1] }], [{ ...object(), position: [NaN, 0, 0] }]]) {
    assert.throws(() => validateProject({ ...base, objects }, source));
  }
});
