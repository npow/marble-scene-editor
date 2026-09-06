# Reproduce the Marble Studio demo

The deliverable is a **120-second, 1920 × 1080, 25 fps H.264 video**, available with captions only or with generic synthetic narration.

- [Narrated video](../../public/demo/marble-studio-2min-narrated.mp4)
- [Animated README preview](../../public/demo/scene-editor-preview.gif)
- [Recorded narration script](spoken-script.json)

- [Video](../../public/demo/marble-studio-2min.mp4) — served at `/demo/marble-studio-2min.mp4`.
- [Poster](../../public/demo/marble-studio-2min.jpg) — served at `/demo/marble-studio-2min.jpg`.
- [Assembly report](../../public/demo/marble-studio-2min.json) — dimensions, duration, capture coverage, audio state, and timeline.

The first 55 seconds show the running editor, including a 4 × 4 montage of sixteen motion clips from eight object selections across four scenes. Method, current challenges, and technology follow. The montage loops the recorded motions and labels that replay. Some selections include adjacent geometry; the sectional selection is labeled “Sectional + ottoman.”

## Install

Run these commands from the repository root on Ubuntu/Debian with Node.js, npm, and Python 3 available:

```bash
npm ci
npx playwright install --with-deps chrome ffmpeg
sudo apt-get update
sudo apt-get install -y ffmpeg fonts-noto-core python3-venv
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-segmentation.txt
```

The recorder uses `/usr/bin/google-chrome`; `CHROME_PATH` can point to another compatible executable. Playwright's FFmpeg supports browser recording, while system `ffmpeg` and `ffprobe` perform assembly and validation. Pillow comes from the segmentation requirements. Install a CUDA-compatible Torch build for GPU inference; the demonstrated run used an NVIDIA RTX 6000 GPU. See [scene editor setup](../SCENE_EDITOR.md) for service setup.

## Run the app and mask service

In one terminal:

```bash
.venv/bin/python scripts/segmentation_server.py
```

In another terminal:

```bash
npm run dev -- --host 127.0.0.1 --port 5173
```

Wait for the model to finish loading. The first service start downloads pinned SAM 2 weights. The four bundled example scenes need no World Labs API key. API keys are needed only when importing authenticated World Labs world links.

## Capture, render, and assemble

In a third terminal, from the repository root:

```bash
EDITOR_URL=http://127.0.0.1:5173 node scripts/record_scene_editor.mjs
node scripts/render_scene_slides.mjs
.venv/bin/python scripts/assemble_scene_video.py
```

The capture script reads [shots.json](shots.json), performs the selections and transformations, and writes videos, screenshots, project snapshots, source hashes, errors, and timing marks to `artifacts/scene-editor/video/`. It needs a working WebGL2 browser; its Vulkan flags match the Linux GPU recording environment. Rerun one capture with, for example:

```bash
SHOTS=seattle-sofa EDITOR_URL=http://127.0.0.1:5173 node scripts/record_scene_editor.mjs
```

Assembly reads each object's `*-capture.json`, so a single-shot rerun preserves the other captures. The default assembly requires all eight captures. `--allow-partial` makes an explicitly labeled early review cut and must not be used to claim complete capture coverage.

The slide renderer reads [video-copy.json](video-copy.json), injects it into [slides.html](slides.html), waits for the page to be ready, and captures six full cards plus two transparent overlays at 1920 × 1080. The current assembly uses five method/closing cards and its own captions over the opening application footage; the full title and transparent overlays remain available for alternate edits.

To create a separate review output without replacing the public video:

```bash
.venv/bin/python scripts/assemble_scene_video.py --output artifacts/scene-editor/video/review.mp4
```

The assembler writes a poster and JSON report beside the MP4. It validates the duration, size, and codec with `ffprobe`. No audio is added unless an authorized file is explicitly supplied with `--audio /path/to/audio.wav`.

## Official track name

The official event and track names are still pending confirmation. **“Spatial editing” is the project focus, not an asserted official track.** Once the exact name is confirmed, pass the same text to both commands:

```bash
node scripts/render_scene_slides.mjs --track 'EXACT CONFIRMED TRACK NAME'
.venv/bin/python scripts/assemble_scene_video.py --track 'EXACT CONFIRMED TRACK NAME'
```

The renderer updates the track in memory for that render; it does not rewrite the JSON or HTML. It carries the label into the running header and title/closing copy. For an isolated slide review, add `--output-dir artifacts/scene-editor/video/slides-review`.

## Provenance and durable files

The browser captures show the real editor. Selection uses actual pointer interactions; deterministic transform playback changes the real scene node and dispatches the same TransformControls events used by a drag. This is scripted application footage. The assembler trims, retimes, crops, labels, and arranges those recorded pixels; it does not synthesize a successful edit. Capture manifests include source asset hashes, selected splat counts, timing marks, and browser errors.

World Labs Marble supplies the world assets and API import; Meta SAM 2 produces local screen masks; Spark and Three.js render splats and provide transform gizmos; an NVIDIA RTX 6000 GPU runs SAM 2. Floor repair is an approximate flat reconstruction using nearby rendered floor. Tiling, residual geometry, and unseen object backs remain visible limitations. 

The durable inputs are the scripts under `scripts/` and this directory's shot list, JSON copy, HTML, and narration. Generated captures, project snapshots, slide PNGs, and FFmpeg intermediates stay under the ignored `artifacts/scene-editor/` directory. Public MP4, poster, and report live under `public/demo/` so they can ship with the app. No secrets belong in any capture manifest or public output.

## Optional local narration

Use a separate Python 3.10–3.12 environment so voice dependencies do not affect the segmentation service:

```bash
python3.12 -m venv .venv-narration
.venv-narration/bin/pip install kokoro==0.9.4 'misaki[en]==0.9.4' soundfile==0.14.0
.venv-narration/bin/python scripts/generate_scene_narration.py
.venv/bin/python scripts/assemble_scene_video.py \
  --audio artifacts/scene-editor/video/narration.wav \
  --output public/demo/marble-studio-2min-narrated.mp4
```

The generator downloads pinned Kokoro weights and uses the generic `af_heart` voice. It needs FFmpeg and does not use an API key. The spoken script and section timing are in `spoken-script.json`.
