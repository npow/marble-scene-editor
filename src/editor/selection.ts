import * as THREE from 'three';

export interface Mask { width: number; height: number; pixels: Uint8Array }
export interface Projection { ids: Uint32Array; depths: Float32Array; surfaces?: Float32Array; near: number; far: number }
export interface SceneObject {
  id: string; name: string; indices: number[]; origin: number[];
  position: number[]; rotation: number[]; scale: number[]; deleted: boolean;
}
export interface EditProject {
  format: 'marble-scene-editor'; version: 1;
  source: { name: string; sha256: string; count: number; kind: 'splats' | 'mesh'; transform: number[] };
  objects: SceneObject[];
  repairBackground?: boolean;
}

/** Project actual source centers/face centroids, excluding points behind the camera. */
export function projectMask(points: Float32Array, excluded: Uint8Array, mask: Mask, view: THREE.Matrix4, projection: THREE.Matrix4, surfaceExcluded?: Uint8Array): Projection {
  const ids: number[] = [], depths: number[] = [], cells: number[] = [];
  const point = new THREE.Vector3(), screen = new THREE.Vector3();
  const surface = new Float32Array(Math.ceil(mask.width / 4) * Math.ceil(mask.height / 4)).fill(Infinity);
  const columns = Math.ceil(mask.width / 4);
  for (let i = 0; i < points.length / 3; i++) {
    if (excluded[i]) continue;
    point.fromArray(points, i * 3).applyMatrix4(view);
    if (point.z >= -0.02) continue;
    screen.copy(point).applyMatrix4(projection);
    if (Math.abs(screen.x) > 1 || Math.abs(screen.y) > 1 || screen.z < -1 || screen.z > 1) continue;
    const x = Math.min(mask.width - 1, Math.floor((screen.x + 1) * 0.5 * mask.width));
    const y = Math.min(mask.height - 1, Math.floor((1 - screen.y) * 0.5 * mask.height));
    if (!mask.pixels[y * mask.width + x]) continue;
    const depth = -point.z;
    ids.push(i); depths.push(depth);
    const cell = Math.floor(y / 4) * columns + Math.floor(x / 4);
    cells.push(cell);
    if (!surfaceExcluded?.[i]) surface[cell] = Math.min(surface[cell], depth);
  }
  const visible = Array.from(surface).filter(Number.isFinite).sort((a, b) => a - b);
  const near = Math.max(0, (visible[Math.floor(visible.length * 0.02)] ?? 0) - 0.15);
  const far = Math.max(near + 0.2, (visible[Math.floor(visible.length * 0.95)] ?? 2) + 0.6);
  return { ids: Uint32Array.from(ids), depths: Float32Array.from(depths), surfaces: Float32Array.from(cells, cell => surface[cell]), near, far };
}

export function depthSelection(projection: Projection, near: number, far: number): number[] {
  if (!Number.isFinite(near) || !Number.isFinite(far) || near > far) return [];
  // A global depth range alone selects walls behind the silhouette of a long
  // object. Also bound distance behind the first opaque surface in each cell.
  return Array.from(projection.ids).filter((_, i) => projection.depths[i] >= near && projection.depths[i] <= far && projection.depths[i] <= (projection.surfaces?.[i] ?? Infinity) + .75);
}

export function claimedIndices(objects: SceneObject[], count: number): Uint8Array {
  const claimed = new Uint8Array(count);
  // Deleted objects stay removed from the room. Undo restores their previous state.
  for (const object of objects) for (const index of object.indices) claimed[index] = 1;
  return claimed;
}

/** Copy encoded attributes without unpacking/requantizing or dropping view-dependent color. */
export function subsetWords(source: Uint32Array, indices: readonly number[], stride: number, capacity = indices.length): Uint32Array {
  const result = new Uint32Array(capacity * stride);
  indices.forEach((index, target) => result.set(source.subarray(index * stride, (index + 1) * stride), target * stride));
  return result;
}

export function validateProject(value: unknown, source: EditProject['source']): EditProject {
  const project = value as EditProject;
  if (project?.format !== 'marble-scene-editor' || project.version !== 1 || !Array.isArray(project.objects)) throw new Error('This is not a scene editor project.');
  if (project.repairBackground !== undefined && typeof project.repairBackground !== 'boolean') throw new Error('Invalid background repair setting.');
  if (project.source?.sha256 !== source.sha256 || project.source?.count !== source.count || project.source?.kind !== source.kind) throw new Error('Load the original source asset before opening this project.');
  if (!Array.isArray(project.source.transform) || project.source.transform.length !== 16 || project.source.transform.some(v => !Number.isFinite(v))) throw new Error('Invalid source transform.');
  if (project.source.transform.some((v, i) => Math.abs(v - source.transform[i]) > 1e-6)) throw new Error('Import the source with the same coordinate system and scale as this project.');
  const claimed = new Set<number>(), ids = new Set<string>();
  for (const object of project.objects) {
    if (typeof object.id !== 'string' || ids.has(object.id) || typeof object.name !== 'string' || object.name.length > 120 || typeof object.deleted !== 'boolean') throw new Error('Invalid object record.');
    ids.add(object.id);
    for (const field of ['origin', 'position', 'rotation', 'scale'] as const) {
      if (!Array.isArray(object[field]) || object[field].length !== 3 || object[field].some(v => !Number.isFinite(v) || Math.abs(v) > 1e6)) throw new Error('Invalid object transform.');
    }
    if (object.scale.some(v => v <= 0)) throw new Error('Object scales must be positive.');
    if (!Array.isArray(object.indices) || !object.indices.length) throw new Error('Empty object segment.');
    for (const index of object.indices) {
      if (!Number.isInteger(index) || index < 0 || index >= source.count || claimed.has(index)) throw new Error('Invalid or overlapping source indices.');
      claimed.add(index);
    }
  }
  return project;
}
