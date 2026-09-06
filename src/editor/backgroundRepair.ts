import * as THREE from 'three';

export interface FloorPlan {
  y: number;
  bounds: [number, number, number, number]; // min x/z, max x/z
  tile: [number, number, number, number];
  donors: number[];
  cleanup: number[];
  polygon: [number, number][];
}

export function convexHull(samples: [number, number][]): [number, number][] {
  samples = samples.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (a: number[], b: number[], c: number[]) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const lower: [number, number][] = [], upper: [number, number][] = [];
  for (const p of samples) { while (lower.length > 1 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  for (const p of samples.reverse()) { while (upper.length > 1 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  lower.pop(); upper.pop(); return [...lower, ...upper];
}

export function insideHull(x: number, z: number, hull: [number, number][], margin = 0) {
  if (hull.length < 3) return false;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    if ((b[0] - a[0]) * (z - a[1]) - (b[1] - a[1]) * (x - a[0]) < -margin * Math.hypot(b[0] - a[0], b[1] - a[1])) return false;
  }
  return true;
}

/** Reject floor samples hidden behind furniture in the source panorama. */
export function visibleFloorSamples(points: Float32Array, horizontal: Uint8Array, transparent: Uint8Array, camera: THREE.Vector3): Uint8Array {
  const width = 1024, height = 512, depth = new Float32Array(width * height).fill(Infinity), pixels = new Int32Array(horizontal.length), ranges = new Float32Array(horizontal.length);
  for (let i = 0; i < horizontal.length; i++) {
    const x = points[i * 3] - camera.x, y = points[i * 3 + 1] - camera.y, z = points[i * 3 + 2] - camera.z;
    const radius = Math.hypot(x, y, z); ranges[i] = radius;
    const u = Math.min(width - 1, Math.floor((.5 + Math.atan2(x, z) / (Math.PI * 2)) * width));
    const v = Math.min(height - 1, Math.floor((.5 + Math.asin(Math.max(-1, Math.min(1, y / Math.max(radius, .0001)))) / Math.PI) * height));
    const pixel = v * width + u; pixels[i] = pixel;
    if (!transparent[i]) depth[pixel] = Math.min(depth[pixel], radius);
  }
  return Uint8Array.from(horizontal, (value, i) => value && ranges[i] < depth[pixels[i]] + .12 ? 1 : 0);
}

/** Infer a nearby horizontal support surface and reuse an observed floor tile.
 * This is a fast planar reconstruction, not a recovered observation of the hole.
 */
export function planFloorRepair(points: Float32Array, horizontal: Uint8Array, selected: readonly number[], claimed: Uint8Array, camera: THREE.Vector3): FloorPlan | null {
  if (selected.length < 3) return null;
  const box = new THREE.Box3(), point = new THREE.Vector3();
  selected.forEach(i => box.expandByPoint(point.fromArray(points, i * 3)));
  if (box.max.x - box.min.x > 8 || box.max.z - box.min.z > 8) return null;
  const histogram = new Map<number, number>();
  for (let i = 0; i < horizontal.length; i++) {
    if (!horizontal[i] || claimed[i]) continue;
    const x = points[i * 3], y = points[i * 3 + 1], z = points[i * 3 + 2];
    if (x < box.min.x - 2 || x > box.max.x + 2 || z < box.min.z - 2 || z > box.max.z + 2 || y < box.min.y - 1 || y > box.min.y + .25) continue;
    const bin = Math.round(y / .025); histogram.set(bin, (histogram.get(bin) ?? 0) + 1);
  }
  let peak = 0, support = 0;
  for (const [bin, count] of histogram) if (count > support) { support = count; peak = bin; }
  if (support < 24) return null;
  const y = peak * .025;
  if (Math.abs(box.min.y - y) > .4 || box.max.y < y + .15) return null;
  const floors: number[] = [];
  const tiles = new Map<string, { x: number; z: number; count: number }>();
  const tileSize = 1.2;
  for (let i = 0; i < horizontal.length; i++) {
    if (!horizontal[i] || claimed[i] || Math.abs(points[i * 3 + 1] - y) > .15) continue;
    const x = points[i * 3], z = points[i * 3 + 2];
    if (x < box.min.x - 4 || x > box.max.x + 4 || z < box.min.z - 4 || z > box.max.z + 4) continue;
    floors.push(i);
    if (Math.abs(points[i * 3 + 1] - y) > .04) continue;
    const tx = Math.floor(x / tileSize) * tileSize, tz = Math.floor(z / tileSize) * tileSize;
    // Donor tiles must be entirely outside the object's footprint.
    if (tx < box.max.x + .1 && tx + tileSize > box.min.x - .1 && tz < box.max.z + .1 && tz + tileSize > box.min.z - .1) continue;
    const key = `${tx},${tz}`, tile = tiles.get(key) ?? { x: tx, z: tz, count: 0 }; tile.count++; tiles.set(key, tile);
  }
  const center = box.getCenter(new THREE.Vector3());
  const candidates = [...tiles.values()].sort((a, b) => {
    const score = (t: typeof a) => t.count / (1 + .2 * ((t.x + .6 - center.x) ** 2 + (t.z + .6 - center.z) ** 2));
    return score(b) - score(a);
  });
  const tile = candidates[0]; if (!tile || tile.count < 30) return null;
  const donors = floors.filter(i => Math.abs(points[i * 3 + 1] - y) <= .04 && points[i * 3] >= tile.x && points[i * 3] < tile.x + tileSize && points[i * 3 + 2] >= tile.z && points[i * 3 + 2] < tile.z + tileSize);
  const bounds: FloorPlan['bounds'] = [box.min.x - .15, box.min.z - .15, box.max.x + .15, box.max.z + .15];
  // Extend into the floor shadow occluded from the original capture camera.
  // The patch is fixed in world coordinates and stays behind a moved object.
  const cameraHeight = camera.y - y;
  if (cameraHeight > .3) {
    const factor = Math.min(2.5, cameraHeight / Math.max(.2, camera.y - box.max.y));
    for (const x of [box.min.x, box.max.x]) for (const z of [box.min.z, box.max.z]) {
      const px = camera.x + (x - camera.x) * factor, pz = camera.z + (z - camera.z) * factor;
      bounds[0] = Math.min(bounds[0], px); bounds[1] = Math.min(bounds[1], pz);
      bounds[2] = Math.max(bounds[2], px); bounds[3] = Math.max(bounds[3], pz);
    }
  }
  // Remove residual source splats in the object interior. Existing floor stays.
  // The convex footprint avoids unrelated geometry in empty AABB corners.
  const hull = convexHull(selected.filter(i => points[i * 3 + 1] > y + .12).map(i => [points[i * 3], points[i * 3 + 2]]));
  const cleanup: number[] = [];
  for (let i = 0; i < horizontal.length; i++) {
    if (claimed[i]) continue;
    const x = points[i * 3], sy = points[i * 3 + 1], z = points[i * 3 + 2];
    if (x < box.min.x - .15 || x > box.max.x + .15 || z < box.min.z - .15 || z > box.max.z + .15 || sy < y - .4 || sy > box.max.y + .12) continue;
    if (insideHull(x, z, hull, .15)) cleanup.push(i);
  }
  // Sparse floaters beyond windows must not extend the inferred room boundary.
  const cells = new Map<string, { x: number; z: number; count: number }>();
  for (const i of floors) {
    const x = Math.floor(points[i * 3] / .25), z = Math.floor(points[i * 3 + 2] / .25), key = `${x},${z}`;
    const cell = cells.get(key) ?? { x, z, count: 0 }; cell.count++; cells.set(key, cell);
  }
  const floorHull = convexHull([...cells.values()].filter(c => c.count >= 8).map(c => [(c.x + .5) * .25, (c.z + .5) * .25]));
  let polygon: [number, number][] = [[bounds[0], bounds[1]], [bounds[2], bounds[1]], [bounds[2], bounds[3]], [bounds[0], bounds[3]]];
  // Clip the repair to observed room extent instead of projecting through walls.
  for (let i = 0; i < floorHull.length; i++) {
    const a = floorHull[i], b = floorHull[(i + 1) % floorHull.length];
    // A hull edge across a large occluded area is not evidence of a wall.
    // Only clip edges supported by floor observations along their length.
    const steps = Math.max(2, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / .25));
    let supported = 0;
    for (let step = 0; step <= steps; step++) {
      const x = a[0] + (b[0] - a[0]) * step / steps, z = a[1] + (b[1] - a[1]) * step / steps;
      const gx = Math.floor(x / .25), gz = Math.floor(z / .25);
      let found = false;
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) if ((cells.get(`${gx + dx},${gz + dz}`)?.count ?? 0) >= 8) found = true;
      if (found) supported++;
    }
    if (supported / (steps + 1) < .75) continue;
    const previous = polygon; polygon = [];
    const side = (p: number[]) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    for (let j = 0; j < previous.length; j++) {
      const p = previous[j], q = previous[(j + 1) % previous.length], dp = side(p), dq = side(q);
      if (dp >= 0) polygon.push(p);
      if ((dp >= 0) !== (dq >= 0)) { const t = dp / (dp - dq); polygon.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]); }
    }
  }
  if (polygon.length < 3) return null;
  return { y, bounds, tile: [tile.x, tile.z, tile.x + tileSize, tile.z + tileSize], donors, cleanup, polygon };
}

/** Fill small transparent gaps in a rendered donor tile from its nearest opaque pixel. */
export function finishFloorTexture(data: Uint8Array, size: number): THREE.DataTexture {
  const owners = new Int32Array(size * size).fill(-1), queue = new Int32Array(size * size);
  const channels = [0, 1, 2].map(c => {
    const values: number[] = []; for (let i = 0; i < owners.length; i++) if (data[i * 4 + 3] >= 230) values.push(data[i * 4 + c] * 255 / data[i * 4 + 3]);
    values.sort((a, b) => a - b); return values[Math.floor(values.length / 2)] ?? 128;
  });
  let start = 0, end = 0;
  for (let i = 0; i < owners.length; i++) {
    if (data[i * 4 + 3] >= 230 && channels.every((median, c) => Math.abs(data[i * 4 + c] * 255 / data[i * 4 + 3] - median) < 42)) { owners[i] = i; queue[end++] = i; }
  }
  if (!end) throw new Error('No opaque floor texture was found.');
  while (start < end) {
    const i = queue[start++], x = i % size, y = Math.floor(i / size);
    for (const next of [x > 0 ? i - 1 : -1, x < size - 1 ? i + 1 : -1, y > 0 ? i - size : -1, y < size - 1 ? i + size : -1]) {
      if (next >= 0 && owners[next] < 0) { owners[next] = owners[i]; queue[end++] = next; }
    }
  }
  const pixels = new Uint8Array(data.length);
  for (let i = 0; i < owners.length; i++) {
    const source = owners[i] * 4;
    for (let c = 0; c < 3; c++) pixels[i * 4 + c] = Math.min(255, Math.round(data[source + c] * 255 / data[source + 3]));
    pixels[i * 4 + 3] = 255;
  }
  // Blend opposite borders so repeated floor samples have no rectangular seams.
  const border = Math.max(1, Math.floor(size * .2));
  for (let row = 0; row < size; row++) for (let edge = 0; edge < border; edge++) {
    const weight = .5 * (1 - edge / border), a = (row * size + edge) * 4, b = (row * size + size - 1 - edge) * 4;
    for (let c = 0; c < 3; c++) { const left = pixels[a + c], right = pixels[b + c]; pixels[a + c] = left * (1 - weight) + right * weight; pixels[b + c] = right * (1 - weight) + left * weight; }
  }
  for (let col = 0; col < size; col++) for (let edge = 0; edge < border; edge++) {
    const weight = .5 * (1 - edge / border), a = (edge * size + col) * 4, b = ((size - 1 - edge) * size + col) * 4;
    for (let c = 0; c < 3; c++) { const top = pixels[a + c], bottom = pixels[b + c]; pixels[a + c] = top * (1 - weight) + bottom * weight; pixels[b + c] = bottom * (1 - weight) + top * weight; }
  }
  const texture = new THREE.DataTexture(pixels, size, size); texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping; texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter; texture.generateMipmaps = true; texture.needsUpdate = true;
  return texture;
}
