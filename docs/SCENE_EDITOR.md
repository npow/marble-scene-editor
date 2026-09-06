# Marble Studio scene editor

The app imports World Labs splats or meshes, segments scene objects, and moves, rotates, scales, or deletes them. See the [README](../README.md) for the two-minute demo, technology roles, and quickstart.

## Run

```bash
npm ci
npm run dev -- --host 127.0.0.1 --port 5173
```

Open `http://127.0.0.1:5173/`. WebGL2 and localhost or HTTPS are required. Four checked-in example worlds are available immediately. Box selection and all editing operations run in the browser.

For AI masks and importing authenticated World Labs links, run the local service in another terminal:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements-segmentation.txt
# Export WORLD_LABS_API_KEY and optionally WORLD_LABS_API_KEY2 in this shell.
npm run segmentation:serve
```

Install a CUDA-compatible Torch build for GPU inference. The service loads a pinned SAM2 model on startup; the first run downloads its weights. It binds to `127.0.0.1:8008`, and Vite proxies `/api/segmentation` to it. Screenshots are processed locally. API keys are read only by Python, never included in browser code or project files. No new World Labs worlds are generated.

## Workflow

1. Choose an example, drop a file, or use **Import scene**. Supported inputs: `.spz`, Gaussian `.ply`, `.splat`, self-contained static `.glb`, `world_meta.json`, a Marble world link, or a world UUID. Direct asset URLs must permit browser CORS access. Metadata/world links automatically apply the world's metric calibration. For files alone, set scale and the World Labs coordinate checkbox before import; clear it for an ordinary Y-up GLB.
2. Choose **Segment**, then drag a box around the whole object. **AI mask** uses SAM2 to find its outline. **Box** is available without the service.
3. Review the green geometry preview. Near/Far constrain camera depth, with an additional local surface-depth bound to reduce walls behind the object. **Add** and **Subtract** apply to the next box and retain the depth interval when the camera has not changed. Navigate to another angle, return to Segment, and Add to collect surfaces hidden in the first view.
4. Name the selection and click **Create object**. Its source indices are removed from the room and assigned to an independent object.
5. Select an object in the scene/list. Use the Move/Rotate/Scale gizmo or numeric properties. Delete removes the object; Undo/Redo restore edits. Reset transform returns an object to its original placement. Restore original scene is also undoable.
6. **Repair background**, enabled by default, fills supported floor areas at extracted objects' original locations using nearby floor appearance. Toggle it to compare the repaired room with the original source geometry. The setting supports Undo/Redo and is saved with the project.
7. Edits autosave in this browser's local storage, keyed by the source hash. Reloading the same source with matching calibration restores the saved objects and repair setting. The source asset itself is not stored; imported files must be selected again, and downloaded projects remain the portable backup if browser storage is cleared or full. **Save project** downloads `scene.spatial.json`. Reopen the original source with the same calibration, then **Open saved project**. The SHA-256, element count, coordinates, indices, and transforms are validated. Mesh scenes additionally support **Export edited GLB**.

Shortcuts: V navigate, S segment, G move, R rotate, E scale, F frame selection/scene, Delete delete, Escape clear preview, Ctrl/Command-Z undo, Ctrl/Command-Shift-Z redo, Ctrl/Command-S save.

## What is preserved

- Selection IDs refer to original splats or source mesh faces. Objects own disjoint index sets. Deleted objects remain excluded from the room until undone/reset.
- Splat subsets copy packed position/shape/color words and all supported spherical harmonic bands without re-encoding. Splats are rendered by Spark with their original appearance.
- Mesh subsets copy complete triangles, attributes, source node transforms, and materials. GLB exports contain the remaining room plus transformed objects and any enabled floor repair geometry.
- Saved projects preserve original source hashes, indices, calibration, object origins, transforms, names, deletion state, and the background repair setting. Splat projects are edit documents referencing the original asset, not standalone exported SPZ files.
- Floor repair adds inferred planar geometry and cleans residual source geometry around the original footprint. Its preview can include nearby residual splats with the moved object; these are derived from the saved selection rather than added to its saved index set. Disable repair when comparing exact source membership or source triangle counts.

## Segmentation limits

SAM2 produces a mask of the current rendered view; it does not infer a complete semantic 3D asset. The mask is projected onto splat centers or mesh face centroids. The automatic depth interval uses the 2nd–95th percentiles of the nearest opaque surfaces in four-pixel cells, with 0.15 scene units of near padding and 0.6 of far padding. Selection also stays within 0.75 units behind each cell's nearest opaque surface. Transparent splats remain selectable inside these bounds. Preview and multi-view Add/Subtract are part of the workflow, especially for cushions, legs, backs, and adjacent surfaces.

Moving/deleting geometry can reveal unobserved background, holes, or incomplete backs in the original capture. Background repair approximates a horizontal floor plane, clips it against supported room boundaries, and bakes nearby observed floor appearance into a repeating texture. It declines scenes without enough floor evidence. Residual edges, visible texture repetition, and imperfect cleanup can remain; this is not general inpainting or a reconstruction of arbitrary walls or unseen object backs. Marble collider meshes are coarse and may omit detail that exists in the splats. A single selection is not a guarantee of a watertight, fully isolated furniture asset.

## Validation

```bash
npm run build
npm test
python -m unittest discover -s tests -p 'test_*.py' -v
# Start Vite on port 5173 before these browser checks:
npm run test:editor
npm run test:editor -- --ai  # also requires the local SAM2 service
```

The browser test uses Playwright and an installed Chrome (`CHROME_PATH` can override its path); `EDITOR_URL` can override the app URL. It exercises selection, Add/Subtract, move/rotate/scale, delete, undo/redo, project roundtrip, local autosave recovery, floor repair and its toggle, mesh extraction, GLB export counts with repair disabled, and recovery when AI is unavailable. Screenshots and downloaded files go to ignored `artifacts/scene-editor/`.

Standalone extraction verified on 2026-09-06 UTC:

- Production TypeScript/Vite build passed. Vite reports the existing large Spark/Three bundle warning.
- Twelve geometry/project/floor tests and four API validation tests passed.
- Real SAM2 browser workflow passed with 17,078 source splats after refinement; the screenshot before Add/Subtract contains 16,956.
- Mesh workflow deleted 1,656 faces; with floor repair disabled, the exported GLB contained exactly 31,378 remaining triangles from the 33,034-face source.
- Project reopening and browser reload reproduced the saved object records exactly. Floor repair, its saved setting and undo history, transforms, and unavailable-AI recovery passed; no uncaught browser errors occurred.
- Visual inspection confirmed the sofa highlight and the repaired/unrepaired comparison. The repaired result still has visible texture repetition and residual edges; the test verifies operation and persistence, not photorealistic completion.

The earlier 2026-09-05 run also verified authenticated Marble link import and reimporting the edited local GLB; those two manual import paths were not rerun in this validation pass.

## Files

- `src/editor/SceneEditor.tsx`: import UI, object list, tools and properties.
- `src/editor/SceneEngine.ts`: Three/Spark scene, extraction, transforms, history and exports.
- `src/editor/selection.ts`: projection, depth selection, source membership and project validation.
- `src/editor/backgroundRepair.ts`: supported floor detection, footprint cleanup, room clipping, and donor texture completion.
- `scripts/segmentation_server.py`: pinned SAM2 inference and World Labs world lookup.
- `tests/`, `scripts/test_scene_editor.mjs`: core/API/browser checks.

