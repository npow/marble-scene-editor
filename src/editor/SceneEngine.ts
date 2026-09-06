import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { PackedSplats, SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import { claimedIndices, depthSelection, projectMask, subsetWords, validateProject, type EditProject, type Mask, type Projection, type SceneObject } from './selection';
import { finishFloorTexture, planFloorRepair, visibleFloorSamples, type FloorPlan } from './backgroundRepair';

export type Mode = 'orbit' | 'segment' | 'translate' | 'rotate' | 'scale';
export type SelectionTool = 'ai' | 'box';
export interface EditorState {
  busy: boolean; status: string; error: string | null; source: EditProject['source'] | null;
  objects: SceneObject[]; selectedId: string | null; mode: Mode; selectionCount: number;
  near: number; far: number; canUndo: boolean; canRedo: boolean;
  repairBackground: boolean; repairedCount: number;
}
type Primitive = { geometry: THREE.BufferGeometry; material: THREE.Material | THREE.Material[]; start: number; count: number };
type History = { objects: SceneObject[]; repairBackground: boolean };
const cloneObjects = (objects: SceneObject[]) => objects.map(o => ({ ...o, position: [...o.position], rotation: [...o.rotation], scale: [...o.scale] }));
export const download = (data: BlobPart, name: string, type = 'application/json') => {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

export class SceneEngine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(65, 1, 0.03, 1000);
  readonly orbit: OrbitControls;
  readonly gizmo: TransformControls;
  readonly spark: SparkRenderer;
  readonly room = new THREE.Group();
  readonly objectRoot = new THREE.Group();
  readonly preview = new THREE.Group();
  readonly repairs = new THREE.Group();
  readonly outline = new THREE.Box3Helper(new THREE.Box3(), 0x7affd4);
  state: EditorState = { busy: false, status: 'Open a scene to begin', error: null, source: null, objects: [], selectedId: null, mode: 'orbit', selectionCount: 0, near: 0, far: 2, canUndo: false, canRedo: false, repairBackground: true, repairedCount: 0 };
  tool: SelectionTool = 'ai';
  operation: 'replace' | 'add' | 'subtract' = 'replace';
  private packed: PackedSplats | null = null;
  private primitives: Primitive[] = [];
  private points = new Float32Array();
  private opacityExcluded = new Uint8Array();
  private horizontal: Uint8Array = new Uint8Array();
  private floorPlans = new WeakMap<number[], FloorPlan | null>();
  private floorTextures = new Map<FloorPlan, Promise<THREE.Texture | null>>();
  private repairQueue: Promise<unknown> = Promise.resolve();
  private sourceTransform = new THREE.Matrix4();
  private nodes = new Map<string, THREE.Group>();
  private selection: number[] = [];
  private projection: Projection | null = null;
  private projectionView: THREE.Matrix4 | null = null;
  private selectionBase: number[] = [];
  private projectionOperation: 'replace' | 'add' | 'subtract' = 'replace';
  private history: History[] = [];
  private future: History[] = [];
  private dragStart: THREE.Vector2 | null = null;
  private draggingGizmo = false;
  private observer: ResizeObserver;
  private generation = 0;
  private disposed = false;
  private request: AbortController | null = null;
  private rectangle: HTMLDivElement;

  constructor(private host: HTMLDivElement, private changed: (state: EditorState) => void) {
    this.renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor(0x151a20);
    host.appendChild(this.renderer.domElement);
    this.renderer.domElement.className = 'scene-canvas';
    this.spark = new SparkRenderer({ renderer: this.renderer });
    this.scene.add(this.spark, this.room, this.objectRoot, this.preview, this.outline, this.repairs);
    this.outline.visible = false;
    (this.outline.material as THREE.Material).depthTest = false;
    this.outline.renderOrder = 1000;
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x737b87, 2.8));
    const sun = new THREE.DirectionalLight(0xffffff, 2); sun.position.set(2, 8, 5); this.scene.add(sun);
    this.camera.position.set(0, 1.5, 0);
    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.target.set(2, 1, -4); this.orbit.enableDamping = true; this.orbit.minDistance = 0.1;
    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.gizmo.setSize(0.85); this.scene.add(this.gizmo.getHelper());
    this.gizmo.addEventListener('dragging-changed', event => {
      this.draggingGizmo = Boolean(event.value); this.orbit.enabled = !event.value && this.state.mode !== 'segment';
      if (event.value) this.checkpoint(); else this.readTransform();
    });
    this.gizmo.addEventListener('objectChange', () => { this.updateOutline(); });
    this.rectangle = document.createElement('div'); this.rectangle.className = 'selection-rectangle'; host.appendChild(this.rectangle);
    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown', this.pointerDown);
    canvas.addEventListener('pointermove', this.pointerMove);
    canvas.addEventListener('pointerup', this.pointerUp);
    canvas.addEventListener('pointercancel', this.pointerCancel);
    this.observer = new ResizeObserver(() => {
      this.renderer.setSize(host.clientWidth, host.clientHeight);
      this.camera.aspect = host.clientWidth / Math.max(1, host.clientHeight); this.camera.updateProjectionMatrix();
    });
    this.observer.observe(host);
    this.renderer.setAnimationLoop(() => {
      this.orbit.update(); this.renderer.render(this.scene, this.camera);
    });
  }

  private emit(patch: Partial<EditorState> = {}) {
    this.state = { ...this.state, ...patch, canUndo: !!this.history.length, canRedo: !!this.future.length };
    this.autosave();
    if (!this.disposed) this.changed(this.state);
  }
  private autosave() {
    if (!this.state.source || this.state.busy) return;
    try {
      const project: EditProject = { format: 'marble-scene-editor', version: 1, source: this.state.source, objects: this.state.objects, repairBackground: this.state.repairBackground };
      localStorage.setItem(`marble-editor:${project.source.sha256}`, JSON.stringify(project));
    } catch { /* Downloaded projects remain available if browser storage is full. */ }
  }
  reportError(error: unknown) { this.emit({ busy: false, error: error instanceof Error ? error.message : String(error) }); }
  private snapshot(): History { return { objects: cloneObjects(this.state.objects), repairBackground: this.state.repairBackground }; }
  private checkpoint() {
    this.history.push(this.snapshot()); if (this.history.length > 30) this.history.shift(); this.future = [];
  }
  private clearGroup(group: THREE.Group) {
    group.traverse(node => {
      if (node instanceof SplatMesh) node.dispose();
      else if (node instanceof THREE.Mesh) node.geometry.dispose();
    });
    group.clear();
  }
  private clearSource() {
    this.gizmo.detach(); this.clearGroup(this.room); this.clearGroup(this.objectRoot); this.clearGroup(this.preview);
    this.clearRepairs(); this.floorPlans = new WeakMap();
    for (const texture of this.floorTextures.values()) void texture.then(t => t?.dispose());
    this.floorTextures.clear();
    this.packed?.dispose(); this.packed = null;
    const materials = new Set<THREE.Material>();
    this.primitives.forEach(p => { p.geometry.dispose(); (Array.isArray(p.material) ? p.material : [p.material]).forEach(m => materials.add(m)); });
    const textures = new Set<THREE.Texture>();
    materials.forEach(m => { Object.values(m).forEach(v => { if (v instanceof THREE.Texture) textures.add(v); }); m.dispose(); });
    textures.forEach(t => t.dispose()); this.primitives = []; this.nodes.clear(); this.selection = []; this.projection = null;
    this.outline.visible = false;
  }

  async load(input: { name: string; url?: string; bytes?: ArrayBuffer; scale?: number; ground?: number; marble?: boolean }) {
    const generation = ++this.generation;
    this.request?.abort(); this.request = new AbortController();
    this.emit({ busy: true, error: null, status: 'Loading scene…' });
    try {
      let bytes = input.bytes;
      if (!bytes && input.url) {
        const response = await fetch(input.url, { signal: this.request.signal });
        if (!response.ok) throw new Error(`Could not load asset (${response.status}).`);
        bytes = await response.arrayBuffer();
      }
      if (!bytes || bytes.byteLength < 4) throw new Error('The source asset is empty or invalid.');
      if (!crypto.subtle) throw new Error('Open the editor through localhost or HTTPS to enable source-file verification.');
      const sha = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(b => b.toString(16).padStart(2, '0')).join('');
      const isMesh = /\.glb(?:$|\?)/i.test(input.name) || new DataView(bytes).getUint32(0, true) === 0x46546c67;
      const scale = input.scale ?? 1, ground = input.ground ?? 0;
      if (!Number.isFinite(scale) || scale <= 0 || !Number.isFinite(ground)) throw new Error('Invalid scene calibration.');
      const transform = new THREE.Matrix4().makeScale(scale, input.marble === false ? scale : -scale, input.marble === false ? scale : -scale);
      transform.setPosition(0, ground, 0);
      let packed: PackedSplats | null = null;
      let gltf: Awaited<ReturnType<GLTFLoader['parseAsync']>> | null = null;
      if (isMesh) gltf = await new GLTFLoader().parseAsync(bytes, input.url ? new URL('.', new URL(input.url, location.href)).href : '');
      else { packed = new PackedSplats({ fileBytes: bytes, fileName: input.name, lod: false }); await packed.initialized; }
      if (generation !== this.generation || this.disposed) { packed?.dispose(); return false; }
      if (packed && !packed.numSplats) { packed.dispose(); throw new Error('The asset contains no editable splats. Use a non-LOD SPZ, PLY, or SPLAT file.'); }
      if (gltf) {
        let count = 0;
        gltf.scene.traverse(node => {
          if (node instanceof THREE.SkinnedMesh) throw new Error('Use a static World Labs mesh; animated meshes are not supported.');
          if (node instanceof THREE.Mesh) count += node.geometry.getAttribute('position')?.count ?? 0;
        });
        if (!count) throw new Error('The GLB contains no triangle meshes.');
      }
      this.clearSource(); this.sourceTransform.copy(transform); this.packed = packed;
      const positions: number[] = [], hidden: number[] = [], horizontal: number[] = [];
      const point = new THREE.Vector3(), normal = new THREE.Vector3(), normalTransform = new THREE.Matrix3().getNormalMatrix(transform);
      if (packed) {
        if (!packed.numSplats) throw new Error('The asset contains no editable splats. Use a non-LOD SPZ, PLY, or SPLAT file.');
        packed.forEachSplat((_, center, scales, quaternion, opacity) => {
          point.copy(center).applyMatrix4(transform); positions.push(point.x, point.y, point.z); hidden.push(opacity < 0.12 ? 1 : 0);
          const smallest = Math.min(scales.x, scales.y, scales.z), largest = Math.max(scales.x, scales.y, scales.z);
          normal.set(scales.x === smallest ? 1 : 0, scales.x !== smallest && scales.y === smallest ? 1 : 0, scales.x !== smallest && scales.y !== smallest ? 1 : 0).applyQuaternion(quaternion).applyNormalMatrix(normalTransform);
          horizontal.push(opacity > .15 && Math.abs(normal.y) > .85 && smallest < largest * .4 ? 1 : 0);
        });
      } else if (gltf) {
        gltf.scene.updateMatrixWorld(true);
        gltf.scene.traverse(node => {
          if (!(node instanceof THREE.Mesh)) return;
          if (node instanceof THREE.SkinnedMesh) throw new Error('Use a static World Labs mesh; animated meshes are not supported.');
          const geometry = node.geometry.index ? node.geometry.toNonIndexed() : node.geometry.clone();
          geometry.applyMatrix4(node.matrixWorld);
          const attr = geometry.getAttribute('position'), start = positions.length / 3;
          for (let v = 0; v < attr.count; v += 3) {
            point.set(0, 0, 0);
            for (let k = 0; k < 3; k++) point.add(new THREE.Vector3().fromBufferAttribute(attr, v + k));
            point.divideScalar(3).applyMatrix4(transform); positions.push(point.x, point.y, point.z); hidden.push(0);
            const a = new THREE.Vector3().fromBufferAttribute(attr, v), b = new THREE.Vector3().fromBufferAttribute(attr, v + 1), c = new THREE.Vector3().fromBufferAttribute(attr, v + 2);
            normal.copy(b).sub(a).cross(c.sub(a)).applyNormalMatrix(normalTransform);
            horizontal.push(Math.abs(normal.y) > .95 ? 1 : 0);
          }
          this.primitives.push({ geometry, material: node.material, start, count: attr.count / 3 });
        });
        if (!positions.length) throw new Error('The GLB contains no triangle meshes.');
      }
      this.points = Float32Array.from(positions); this.opacityExcluded = Uint8Array.from(hidden); this.horizontal = Uint8Array.from(horizontal);
      if (packed) this.horizontal = visibleFloorSamples(this.points, this.horizontal, this.opacityExcluded, new THREE.Vector3().setFromMatrixPosition(transform));
      this.history = []; this.future = [];
      this.state.objects = []; this.state.source = { name: input.name, sha256: sha, count: positions.length / 3, kind: isMesh ? 'mesh' : 'splats', transform: transform.toArray() };
      try {
        const saved = localStorage.getItem(`marble-editor:${sha}`);
        if (saved) { const project = validateProject(JSON.parse(saved), this.state.source); this.state.objects = cloneObjects(project.objects); this.state.repairBackground = project.repairBackground ?? true; }
      } catch { /* A different calibration requires explicitly opening the matching project. */ }
      this.rebuild();
      this.camera.position.set(0, ground || 1.5, 0); this.orbit.target.set(2, Math.max(0.7, ground - 0.4), -4); this.orbit.update();
      this.setMode('orbit');
      this.emit({ busy: false, selectedId: null, selectionCount: 0, status: 'Draw a box around an object to segment it.' });
      return true;
    } catch (error) {
      if (generation === this.generation && !this.disposed && !(error instanceof DOMException && error.name === 'AbortError')) this.reportError(error);
      return false;
    }
  }

  private makeSubset(indices: number[], origin = [0, 0, 0], highlight = false): THREE.Group {
    const group = new THREE.Group();
    if (!indices.length) return group;
    const base = new THREE.Group(); base.matrixAutoUpdate = false;
    base.matrix.makeTranslation(-origin[0], -origin[1], -origin[2]).multiply(this.sourceTransform); group.add(base);
    if (this.packed) {
      const packed = new PackedSplats(); packed.ensureSplats(indices.length);
      packed.packedArray = subsetWords(this.packed.packedArray!, indices, 4, packed.maxSplats);
      packed.numSplats = indices.length; packed.splatEncoding = this.packed.splatEncoding;
      for (const [key, stride] of [['sh1', 2], ['sh2', 4], ['sh3', 4]] as const) {
        const data = this.packed.extra[key];
        if (data instanceof Uint32Array) packed.extra[key] = subsetWords(data, indices, stride, packed.maxSplats);
      }
      const mesh = new SplatMesh({ packedSplats: packed, enableLod: false });
      if (highlight) { mesh.recolor.setRGB(0.2, 2.2, 1.7); }
      base.add(mesh);
    } else {
      const wanted = new Set(indices);
      for (const primitive of this.primitives) {
        const faces: number[] = [];
        for (let i = 0; i < primitive.count; i++) if (wanted.has(primitive.start + i)) faces.push(i);
        if (!faces.length) continue;
        const geometry = new THREE.BufferGeometry();
        for (const [name, attribute] of Object.entries(primitive.geometry.attributes)) {
          const values = new Float32Array(faces.length * 3 * attribute.itemSize);
          faces.forEach((face, target) => {
            for (let vertex = 0; vertex < 3; vertex++) for (let k = 0; k < attribute.itemSize; k++) values[(target * 3 + vertex) * attribute.itemSize + k] = attribute.getComponent(face * 3 + vertex, k);
          });
          geometry.setAttribute(name, new THREE.BufferAttribute(values, attribute.itemSize));
        }
        if (primitive.geometry.groups.length) {
          faces.forEach((face, target) => {
            const original = primitive.geometry.groups.find(g => face * 3 >= g.start && face * 3 < g.start + g.count);
            geometry.addGroup(target * 3, 3, original?.materialIndex ?? 0);
          });
        }
        const mesh = new THREE.Mesh(geometry, highlight ? this.previewMaterial : primitive.material); base.add(mesh);
      }
    }
    return group;
  }
  private previewMaterial = new THREE.MeshBasicMaterial({ color: 0x48f5c7, side: THREE.DoubleSide, transparent: true, opacity: 0.8 });

  private rebuild() {
    this.gizmo.detach(); this.clearGroup(this.room); this.clearGroup(this.objectRoot); this.nodes.clear();
    const claimed = claimedIndices(this.state.objects, this.points.length / 3);
    const plans = new Map<string, FloorPlan>();
    this.clearRepairs();
    if (this.state.repairBackground) {
      for (const object of this.state.objects) {
        if (!this.floorPlans.has(object.indices)) this.floorPlans.set(object.indices, planFloorRepair(this.points, this.horizontal, object.indices, claimed, new THREE.Vector3().setFromMatrixPosition(this.sourceTransform)));
        const plan = this.floorPlans.get(object.indices);
        if (plan) { plans.set(object.id, plan); this.addFloorRepair(plan); }
      }
    }
    const removed = claimed.slice(), extra = new Map<string, number[]>();
    for (const object of this.state.objects) {
      const plan = plans.get(object.id); if (!plan) continue;
      // Remove captured shadows and residue in the original footprint as well.
      const owned: number[] = [];
      for (const i of plan.cleanup) if (!removed[i]) { removed[i] = 1; owned.push(i); }
      extra.set(object.id, owned);
    }
    const remaining: number[] = []; for (let i = 0; i < removed.length; i++) if (!removed[i]) remaining.push(i);
    this.room.add(this.makeSubset(remaining));
    for (const object of this.state.objects) {
      if (object.deleted) continue;
      const plan = plans.get(object.id);
      const indices = plan ? [...object.indices, ...(extra.get(object.id) ?? [])].filter(i => this.points[i * 3 + 1] >= plan.y + .04) : object.indices;
      const node = this.makeSubset(indices, object.origin);
      node.position.fromArray(object.position); node.rotation.set(object.rotation[0], object.rotation[1], object.rotation[2]); node.scale.fromArray(object.scale);
      this.objectRoot.add(node); this.nodes.set(object.id, node);
    }
    this.select(this.state.selectedId);
    this.emit({ repairedCount: plans.size });
  }
  private clearRepairs() {
    this.repairs.traverse(node => { if (node instanceof THREE.Mesh) (node.material as THREE.Material).dispose(); });
    this.clearGroup(this.repairs);
  }
  private addFloorRepair(plan: FloorPlan) {
    const geometry = new THREE.ShapeGeometry(new THREE.Shape(plan.polygon.map(([x, z]) => new THREE.Vector2(x, -z))));
    const positions = geometry.getAttribute('position'), uv = geometry.getAttribute('uv');
    // Use the center of the donor tile to avoid uncertain splats at its edges.
    for (let i = 0; i < positions.count; i++) uv.setXY(i, (positions.getX(i) - plan.tile[0] - .3) / .6, (plan.tile[3] - .3 + positions.getY(i)) / .6);
    const material = new THREE.MeshBasicMaterial({ color: 0xaaa18d, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.x = -Math.PI / 2; mesh.position.y = plan.y - .025;
    mesh.name = 'Reconstructed floor'; this.repairs.add(mesh);
    if (!this.floorTextures.has(plan)) {
      const generation = this.generation;
      const pending = this.repairQueue.then(async () => {
        if (this.disposed || generation !== this.generation) return null;
        return this.renderFloorTile(plan);
      }).catch(error => { console.warn('Floor texture rendering failed', error); if (generation === this.generation && !this.disposed) this.emit({ status: 'Floor color filled; a detailed floor texture could not be rendered.' }); return null; });
      this.floorTextures.set(plan, pending); this.repairQueue = pending;
    }
    void this.floorTextures.get(plan)!.then(texture => {
      if (!texture || !mesh.parent) return;
      material.color.set(0xffffff); material.map = texture; material.needsUpdate = true;
    });
  }
  private async renderFloorTile(plan: FloorPlan): Promise<THREE.Texture> {
    // Render the actual Gaussian blend/material textures, not isolated splat colors.
    // Isolate the bake from the viewport's asynchronous GPU sorting/readback.
    const size = 256, scene = new THREE.Scene(), subset = this.makeSubset(plan.donors);
    const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true });
    renderer.setSize(size, size); renderer.setClearColor(0, 0); renderer.outputColorSpace = THREE.SRGBColorSpace;
    const spark = new SparkRenderer({ renderer, autoUpdate: false, minSortIntervalMs: 0, target: { width: size, height: size } });
    scene.add(spark, subset, new THREE.HemisphereLight(0xffffff, 0x737b87, 2.8));
    const sun = new THREE.DirectionalLight(0xffffff, 2); sun.position.set(2, 8, 5); scene.add(sun);
    const camera = new THREE.OrthographicCamera(-.3, .3, .3, -.3, .01, 30);
    camera.position.set((plan.tile[0] + plan.tile[2]) / 2, plan.y + 10, (plan.tile[1] + plan.tile[3]) / 2);
    camera.up.set(0, 0, -1); camera.lookAt(camera.position.x, plan.y, camera.position.z); camera.updateMatrixWorld();
    spark.renderSize.set(size, size);
    try {
      await Promise.all(subset.children.flatMap(base => base.children).filter((n): n is SplatMesh => n instanceof SplatMesh).map(n => n.initialized));
      scene.updateMatrixWorld(true);
      spark.renderTarget({ scene, camera });
      await spark.update({ scene, camera });
      const target = spark.renderTarget({ scene, camera }), pixels = new Uint8Array(size * size * 4);
      renderer.readRenderTargetPixels(target, 0, 0, size, size, pixels);
      return finishFloorTexture(pixels, size);
    } finally { spark.dispose(); this.clearGroup(subset); renderer.dispose(); renderer.forceContextLoss(); }
  }
  setRepairBackground(enabled: boolean) {
    if (this.state.busy || this.state.repairBackground === enabled) return;
    this.checkpoint();
    this.state.repairBackground = enabled; this.rebuild();
    this.emit({ status: enabled ? (this.state.repairedCount ? 'Exposed floor filled from nearby floor appearance.' : 'No nearby floor found for automatic repair.') : 'Background repair disabled; original source geometry shown.' });
  }
  select(id: string | null) {
    const node = id ? this.nodes.get(id) : null;
    this.gizmo.detach();
    if (node && ['translate', 'rotate', 'scale'].includes(this.state.mode)) this.gizmo.attach(node);
    this.state.selectedId = node ? id : null; this.updateOutline(); this.emit();
  }
  private updateOutline() {
    const object = this.state.objects.find(o => o.id === this.state.selectedId);
    const node = object ? this.nodes.get(object.id) : null;
    this.outline.visible = !!node;
    if (!object || !node) return;
    node.updateMatrixWorld(true);
    const bounds = new THREE.Box3(), p = new THREE.Vector3();
    for (const index of object.indices) bounds.expandByPoint(p.fromArray(this.points, index * 3).sub(new THREE.Vector3().fromArray(object.origin)).applyMatrix4(node.matrixWorld));
    this.outline.box.copy(bounds); this.outline.updateMatrixWorld(true);
  }
  setMode(mode: Mode) {
    this.state.mode = mode; this.orbit.enabled = mode !== 'segment' && !this.state.busy;
    if (mode === 'translate' || mode === 'rotate' || mode === 'scale') this.gizmo.setMode(mode);
    this.renderer.domElement.style.cursor = mode === 'segment' ? 'crosshair' : 'grab';
    this.select(this.state.selectedId);
  }
  private readTransform() {
    const object = this.state.objects.find(o => o.id === this.state.selectedId), node = object ? this.nodes.get(object.id) : null;
    if (!object || !node) return;
    object.position = node.position.toArray(); object.rotation = [node.rotation.x, node.rotation.y, node.rotation.z];
    node.scale.clampScalar(0.01, 100); object.scale = node.scale.toArray(); this.emit();
  }
  updateObject(patch: Partial<Pick<SceneObject, 'name' | 'position' | 'rotation' | 'scale'>>) {
    const object = this.state.objects.find(o => o.id === this.state.selectedId); if (!object) return;
    this.checkpoint(); Object.assign(object, patch);
    const node = this.nodes.get(object.id)!; node.position.fromArray(object.position); node.rotation.set(...object.rotation as [number, number, number]); node.scale.fromArray(object.scale);
    this.updateOutline(); this.emit();
  }
  deleteSelected() {
    if (this.state.busy) return;
    const object = this.state.objects.find(o => o.id === this.state.selectedId); if (!object) return;
    this.checkpoint(); object.deleted = true; this.state.selectedId = null; this.rebuild(); this.emit({ status: 'Object deleted. Undo restores it.' });
  }
  undo() {
    if (this.state.busy) return;
    const previous = this.history.pop(); if (!previous) return;
    this.future.push(this.snapshot()); this.state.objects = cloneObjects(previous.objects); this.state.repairBackground = previous.repairBackground; this.cancelSelection(); this.rebuild(); this.emit();
  }
  redo() {
    if (this.state.busy) return;
    const next = this.future.pop(); if (!next) return;
    this.history.push(this.snapshot()); this.state.objects = cloneObjects(next.objects); this.state.repairBackground = next.repairBackground; this.cancelSelection(); this.rebuild(); this.emit();
  }
  reset() {
    if (this.state.busy || !this.state.objects.length) return;
    this.checkpoint(); this.state.objects = []; this.cancelSelection(); this.rebuild(); this.emit({ status: 'Original scene restored.' });
  }
  focus() {
    const object = this.state.objects.find(o => o.id === this.state.selectedId);
    if (object) {
      const center = new THREE.Vector3().fromArray(object.position); this.orbit.target.copy(center);
      this.camera.position.copy(center).add(new THREE.Vector3(2, 1.5, 3));
    } else {
      const box = new THREE.Box3(); const p = new THREE.Vector3();
      for (let i = 0; i < this.points.length; i += 3) box.expandByPoint(p.fromArray(this.points, i));
      const center = box.getCenter(new THREE.Vector3()), distance = Math.min(40, Math.max(3, box.getSize(p).length() * 0.45));
      this.orbit.target.copy(center); this.camera.position.copy(center).add(new THREE.Vector3(distance, distance * 0.7, distance));
    }
    this.orbit.update();
  }

  private pointerPosition = (event: PointerEvent) => {
    const rect = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(Math.max(0, Math.min(rect.width, event.clientX - rect.left)), Math.max(0, Math.min(rect.height, event.clientY - rect.top)));
  };
  private pointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || this.state.busy || !this.state.source) return;
    this.dragStart = this.pointerPosition(event);
    if (this.state.mode === 'segment') this.renderer.domElement.setPointerCapture(event.pointerId);
  };
  private pointerMove = (event: PointerEvent) => {
    if (!this.dragStart || this.state.mode !== 'segment') return;
    const end = this.pointerPosition(event), start = this.dragStart;
    Object.assign(this.rectangle.style, { display: 'block', left: `${Math.min(start.x, end.x)}px`, top: `${Math.min(start.y, end.y)}px`, width: `${Math.abs(start.x - end.x)}px`, height: `${Math.abs(start.y - end.y)}px` });
  };
  private pointerCancel = () => { this.dragStart = null; this.rectangle.style.display = 'none'; };
  private pointerUp = (event: PointerEvent) => {
    const start = this.dragStart; this.dragStart = null; this.rectangle.style.display = 'none';
    if (!start || this.state.busy) return;
    const end = this.pointerPosition(event);
    if (this.state.mode === 'segment') {
      if (start.distanceTo(end) < 8) { this.emit({ status: 'Drag a box around the entire object.' }); return; }
      void this.segment([Math.min(start.x, end.x), Math.min(start.y, end.y), Math.max(start.x, end.x), Math.max(start.y, end.y)]);
    } else if (start.distanceTo(end) < 4 && !this.gizmo.axis) {
      const ray = new THREE.Raycaster(); ray.setFromCamera(new THREE.Vector2(end.x / this.host.clientWidth * 2 - 1, 1 - end.y / this.host.clientHeight * 2), this.camera);
      let closest = Infinity, id: string | null = null;
      for (const [objectId, node] of this.nodes) { const hit = ray.intersectObject(node, true)[0]; if (hit && hit.distance < closest) { closest = hit.distance; id = objectId; } }
      this.select(id);
    }
  };

  private async segment(box: number[]) {
    this.emit({ busy: true, error: null, status: this.tool === 'ai' ? 'Finding the object boundary…' : 'Selecting geometry…' });
    this.orbit.enabled = false; const generation = this.generation;
    this.request?.abort(); this.request = new AbortController();
    const request = this.request;
    const timeout = setTimeout(() => request.abort(), 120000);
    try {
      // A fixed camera snapshot keeps the 2D mask and the 3D projection aligned.
      this.camera.updateMatrixWorld(); const view = this.camera.matrixWorldInverse.clone(), projection = this.camera.projectionMatrix.clone();
      const scale = Math.min(1, 1200 / this.host.clientWidth);
      const width = Math.round(this.host.clientWidth * scale), height = Math.round(this.host.clientHeight * scale);
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d')!;
      const visible = this.preview.visible; this.preview.visible = false; this.outline.visible = false; this.gizmo.getHelper().visible = false;
      this.renderer.render(this.scene, this.camera); context.drawImage(this.renderer.domElement, 0, 0, width, height);
      this.preview.visible = visible; this.updateOutline(); this.gizmo.getHelper().visible = true;
      const scaled = box.map((v, i) => Math.min(i % 2 ? height : width, v * scale));
      let mask: Mask;
      if (this.tool === 'ai') {
        const response = await fetch('/api/segmentation/mask', { method: 'POST', signal: request.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: canvas.toDataURL('image/jpeg', 0.94), box: scaled }) });
        if (!response.ok) throw new Error('AI selection is unavailable. Start the segmentation service or switch to Box selection.');
        const result = await response.json();
        const bitmap = new Image(); bitmap.src = `data:image/png;base64,${result.mask}`; await bitmap.decode();
        context.clearRect(0, 0, width, height); context.drawImage(bitmap, 0, 0); const rgba = context.getImageData(0, 0, width, height).data;
        mask = { width, height, pixels: Uint8Array.from({ length: width * height }, (_, i) => rgba[i * 4]) };
      } else {
        const pixels = new Uint8Array(width * height);
        for (let y = Math.floor(scaled[1]); y < scaled[3]; y++) for (let x = Math.floor(scaled[0]); x < scaled[2]; x++) pixels[y * width + x] = 255;
        mask = { width, height, pixels };
      }
      if (generation !== this.generation || this.disposed) return;
      const excluded = claimedIndices(this.state.objects, this.points.length / 3);
      // Transparent splats remain selectable; only the depth estimate ignores
      // them so low-opacity floaters cannot pull it in front of the object.
      const preserveDepth = this.operation !== 'replace' && this.projectionView?.equals(view);
      this.projection = projectMask(this.points, excluded, mask, view, projection, this.opacityExcluded); this.projectionView = view;
      this.projectionOperation = this.operation;
      this.selectionBase = this.operation === 'replace' ? [] : [...this.selection];
      this.setDepth(preserveDepth ? this.state.near : this.projection.near, preserveDepth ? this.state.far : this.projection.far);
      this.emit({ busy: false, status: 'Review the highlight. Adjust depth, add another view, or subtract stray geometry.' });
    } catch (error) {
      if (generation === this.generation && !this.disposed) this.reportError(error instanceof DOMException && error.name === 'AbortError' ? new Error('Selection cancelled or timed out. Try a smaller box or use Box selection.') : error);
    } finally { clearTimeout(timeout); if (generation === this.generation) this.orbit.enabled = this.state.mode !== 'segment'; }
  }
  setDepth(near: number, far: number) {
    if (!this.projection) return;
    const candidates = depthSelection(this.projection, near, far), set = new Set(this.selectionBase);
    if (this.projectionOperation === 'subtract') candidates.forEach(i => set.delete(i)); else candidates.forEach(i => set.add(i));
    this.selection = [...set].sort((a, b) => a - b);
    this.clearGroup(this.preview); this.preview.add(this.makeSubset(this.selection, [0, 0, 0], true));
    this.emit({ near, far, selectionCount: this.selection.length });
  }
  cancelSelection() {
    this.request?.abort(); this.selection = []; this.projection = null; this.selectionBase = []; this.clearGroup(this.preview); this.emit({ selectionCount: 0 });
  }
  createObject(name: string) {
    if (!this.selection.length || this.state.busy) return;
    const bounds = new THREE.Box3(), p = new THREE.Vector3(); this.selection.forEach(i => bounds.expandByPoint(p.fromArray(this.points, i * 3)));
    const origin = bounds.getCenter(new THREE.Vector3()).toArray();
    const id = crypto.randomUUID(); this.checkpoint();
    this.state.objects = [...this.state.objects, { id, name: name.trim() || `Object ${this.state.objects.length + 1}`, indices: [...this.selection], origin, position: [...origin], rotation: [0, 0, 0], scale: [1, 1, 1], deleted: false }];
    this.cancelSelection(); this.state.selectedId = id; this.rebuild(); this.setMode('translate');
    this.emit({ status: 'Object separated. Drag the arrows to move it.' });
  }
  saveProject() {
    if (!this.state.source) return;
    this.readTransform();
    const project: EditProject = { format: 'marble-scene-editor', version: 1, source: this.state.source, objects: this.state.objects, repairBackground: this.state.repairBackground };
    download(JSON.stringify(project), 'scene.spatial.json'); this.emit({ status: 'Project saved. Reopen it with the original source asset.' });
  }
  loadProject(value: unknown) {
    if (!this.state.source) throw new Error('Load the source asset before opening its project.');
    const project = validateProject(value, this.state.source); this.checkpoint();
    this.state.repairBackground = project.repairBackground ?? true;
    this.state.objects = cloneObjects(project.objects); this.cancelSelection(); this.rebuild(); this.emit({ status: 'Saved edits restored.' });
  }
  async exportMesh() {
    if (this.packed) { this.saveProject(); return; }
    this.gizmo.detach();
    const exportScene = new THREE.Scene(); exportScene.add(this.room.clone(true), this.objectRoot.clone(true), this.repairs.clone(true));
    const result = await new GLTFExporter().parseAsync(exportScene, { binary: true });
    download(result as ArrayBuffer, 'edited-scene.glb', 'model/gltf-binary'); this.select(this.state.selectedId);
  }
  dispose() {
    this.disposed = true; this.generation++; this.request?.abort(); this.renderer.setAnimationLoop(null); this.observer.disconnect();
    this.orbit.dispose(); this.gizmo.dispose(); this.clearSource(); this.previewMaterial.dispose(); this.outline.geometry.dispose(); (this.outline.material as THREE.Material).dispose();
    this.spark.dispose(); this.renderer.dispose(); this.renderer.domElement.remove(); this.rectangle.remove();
  }
}
