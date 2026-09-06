#!/usr/bin/env python3
"""Assemble the two-minute demo from genuine browser captures and slide PNGs.

Run after record_scene_editor.mjs. Captures remain unaltered; this only trims,
retimes, labels, and arranges their recorded pixels. Repeated montage motions
are explicitly labeled. Use --allow-partial only for an early review cut.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
from pathlib import Path
import subprocess
import textwrap

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
ART = ROOT / "artifacts/scene-editor/video"
EDIT = ART / "edit"
FPS = 25
SIZE = (1920, 1080)
FONT = "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf"
FONT_BOLD = "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf"
BG = "0x101719"


def run(cmd: list[str]) -> None:
    result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if result.returncode:
        raise RuntimeError(f"Command failed: {' '.join(cmd)}\n{result.stderr[-8000:]}")


def ffmpeg(args: list[str]) -> None:
    run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-filter_threads", "2", "-filter_complex_threads", "2", *args])


def encoding(quality: str = "25") -> list[str]:
    return ["-c:v", "libx264", "-preset", "veryfast", "-crf", quality,
            "-maxrate", "2800k", "-bufsize", "5600k", "-threads", "3",
            "-pix_fmt", "yuv420p", "-r", str(FPS), "-an", "-movflags", "+faststart"]


def cache_path(name: str, data: object) -> Path:
    key = hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()[:10]
    return EDIT / f"{name}-{key}.mp4"


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(FONT_BOLD if bold else FONT, size)


def caption_png(name: str, eyebrow: str, title: str, detail: str = "") -> Path:
    """A caption below the real UI: the app is scaled into the upper 936 px."""
    path = EDIT / f"caption-{name}.png"
    im = Image.new("RGBA", SIZE, (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rectangle((0, 936, 1920, 1080), fill=(16, 23, 25, 255))
    d.rectangle((64, 965, 70, 1040), fill="#a3edd9")
    d.text((92, 951), eyebrow.upper(), font=font(18, True), fill="#a3edd9")
    d.text((92, 980), title, font=font(34, True), fill="#f1f5f5")
    if detail:
        d.text((92, 1030), detail, font=font(21), fill="#aab9bd")
    im.save(path)
    return path


def fallback_slide(name: str, kicker: str, title: str, lines: list[str]) -> Path:
    path = EDIT / f"fallback-{name}.png"
    im = Image.new("RGB", SIZE, "#101719")
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((92, 86, 352, 130), radius=22, fill="#24453f")
    d.text((112, 93), kicker, font=font(21, True), fill="#a3edd9")
    d.text((92, 190), title, font=font(62, True), fill="#f4f7f6")
    y = 340
    for line in lines:
        for row in textwrap.wrap(line, width=64):
            d.text((102, y), row, font=font(36), fill="#d3dfdf")
            y += 58
        y += 40
    d.line((92, 946, 1828, 946), fill="#35504f", width=2)
    d.text((92, 982), "MARBLE STUDIO  /  SPATIAL EDITING", font=font(23), fill="#93aaa9")
    im.save(path)
    return path


def capture_clip(capture: dict, name: str, start: float, end: float,
                 duration: float, caption: tuple[str, str, str]) -> Path:
    overlay = caption_png(name, *caption)
    data = [capture["video"], Path(capture["video"]).stat().st_mtime_ns,
            start, end, duration, caption, "app-under-caption-v2"]
    target = cache_path(name, data)
    if target.exists() and target.stat().st_size > 1024:
        return target
    # Full recorded UI remains in view, including Save and Undo.
    speed = duration / (end - start)
    vf = (f"[0:v]trim=duration={end-start:.4f},setpts={speed:.6f}*(PTS-STARTPTS),"
          f"fps={FPS},scale=1496:936,pad=1920:1080:212:0:color={BG},"
          "setsar=1,tpad=stop_mode=clone:stop_duration=1[v];"
          "[v][1:v]overlay=0:0:format=auto,format=yuv420p[out]")
    ffmpeg(["-ss", str(max(0, start)), "-i", capture["video"], "-i", str(overlay),
            "-filter_complex", vf, "-map", "[out]", "-t", str(duration),
            *encoding(), str(target)])
    print(f"Rendered {name}: {duration:g}s", flush=True)
    return target


def tile_clip(capture: dict, operation: str) -> Path:
    marks = capture["marks"]
    start = marks["move" if operation == "move" else "transform"]
    end = marks["moved" if operation == "move" else "transformed"]
    display_name = "Sectional + ottoman" if capture["id"] == "sf-sectional" else capture["name"]
    label = f'{display_name}  /  {operation}'
    context_crops = {
        "seattle-chair": [568, 382, 748, 338],
        "house1-console": [440, 390, 840, 380],
    }
    crop = capture.get("montageCrop", context_crops.get(capture["id"], [244, 430, 1072, 484]))
    data = [capture["video"], start, end, label, crop, "context-v5"]
    target = cache_path(f'tile-{capture["id"]}-{operation}', data)
    if target.exists() and target.stat().st_size > 1024:
        return target
    label_path = EDIT / f'tile-{capture["id"]}-{operation}.txt'
    label_path.write_text(label)
    # Broad room context around the recorded objects, not an isolated cutout.
    # The original viewport is x=244..1316, y=72..972 at 1600x1000.
    x, y, w, h = crop
    vf = (f"trim=duration={end-start:.4f},setpts=PTS-STARTPTS,fps={FPS},"
          f"crop={w}:{h}:{x}:{y},scale=464:210:flags=lanczos,"
          f"pad=464:242:0:32:color={BG},setsar=1,"
          f"drawtext=fontfile={FONT}:textfile={label_path}:fontsize=22:"
          "fontcolor=0xc4f9ec:x=10:y=3,format=yuv420p")
    ffmpeg(["-ss", str(start), "-i", capture["video"], "-t", str(end-start),
            "-vf", vf, *encoding("21"), str(target)])
    print(f"Rendered tile {capture['id']} / {operation}", flush=True)
    return target


def montage(captures: list[dict], partial: bool) -> Path:
    jobs = [(c, op) for c in captures for op in ("move", c["action"])]
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        tiles = list(pool.map(lambda job: tile_clip(*job), jobs))
    unique_count = len(captures)
    if len(tiles) < 16:
        if not partial:
            raise RuntimeError(f"Need 16 tiles, got {len(tiles)}")
        tiles = (tiles * (16 // len(tiles) + 1))[:16]
    if len(tiles) != 16:
        raise RuntimeError(f"Expected 16 tiles, got {len(tiles)}")
    data = [str(p) for p in tiles]
    target = cache_path("montage", [data, "20sec-v2", unique_count])
    if target.exists() and target.stat().st_size > 1024:
        return target
    headline = ("8 objects / 4 rooms / 16 real move, rotate and scale edits"
                if unique_count == 8 else
                f"Preview: {unique_count} recorded objects / repeated motion views")
    title_path = EDIT / "montage-title.txt"
    title_path.write_text(headline)
    note_path = EDIT / "montage-note.txt"
    note_path.write_text("RECORDED MOTIONS REPLAYED")
    args = []
    for tile in tiles:
        args.extend(["-stream_loop", "-1", "-i", str(tile)])
    filters = []
    for i in range(16):
        filters.append(f"[{i}:v]setpts=PTS-STARTPTS[v{i}]")
    layout = "|".join(f"{(i%4)*480}_{(i//4)*254}" for i in range(16))
    streams = "".join(f"[v{i}]" for i in range(16))
    filters.append(f"{streams}xstack=inputs=16:layout={layout}:fill={BG},"
                   f"pad=1920:1080:8:64:color={BG},"
                   f"drawtext=fontfile={FONT_BOLD}:textfile={title_path}:fontsize=29:"
                   "fontcolor=white:x=24:y=14,"
                   f"drawtext=fontfile={FONT}:textfile={note_path}:fontsize=15:"
                   "fontcolor=0x91aaa6:x=w-tw-22:y=24,format=yuv420p[out]")
    ffmpeg([*args, "-filter_complex", ";".join(filters), "-map", "[out]", "-t", "20",
            *encoding("23"), str(target)])
    print("Rendered 4x4 montage: 20s", flush=True)
    return target


def slide_clip(path: Path, name: str, duration: float) -> Path:
    if not path.exists():
        raise FileNotFoundError(path)
    target = cache_path(name, [str(path), path.stat().st_mtime_ns, duration])
    if target.exists() and target.stat().st_size > 1024:
        return target
    ffmpeg(["-loop", "1", "-framerate", str(FPS), "-i", str(path), "-t", str(duration),
            "-vf", "scale=1920:1080,setsar=1,format=yuv420p", *encoding("22"), str(target)])
    print(f"Rendered {name}: {duration:g}s", flush=True)
    return target


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--output", type=Path, default=ROOT / "public/demo/marble-studio-2min.mp4")
    p.add_argument("--hero", default="seattle-sofa")
    p.add_argument("--allow-partial", action="store_true")
    p.add_argument("--audio", type=Path, help="Optional authorized narration or soundtrack")
    p.add_argument("--track", default="Spatial editing", help="Use the exact official track once confirmed")
    args = p.parse_args()
    EDIT.mkdir(parents=True, exist_ok=True)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    shots = json.loads((ROOT / "docs/demo/shots.json").read_text())
    captures = []
    missing = []
    for shot in shots:
        path = ART / f'{shot["id"]}-capture.json'
        if path.exists():
            capture = json.loads(path.read_text())
            if capture.get("errors"):
                raise RuntimeError(f"Capture errors for {shot['id']}: {capture['errors']}")
            if not Path(capture["video"]).exists():
                raise FileNotFoundError(capture["video"])
            captures.append(capture)
        else:
            missing.append(shot["id"])
    if missing and not args.allow_partial:
        raise RuntimeError(f"Missing captures: {', '.join(missing)}. Use --allow-partial for a labeled review cut.")
    if not captures:
        raise RuntimeError("No completed browser captures are available")
    hero = next((c for c in captures if c["id"] == args.hero), captures[0])
    m = hero["marks"]
    segments = []
    # Working app precedes all implementation explanation.
    segments.append(capture_clip(hero, "01-open", m["ready"], m["moved"], 8,
        ("MARBLE STUDIO  /  " + args.track,
         "A generated room should be editable.",
         "Turn a single splat scene into objects you can rearrange.")))
    segments.append(capture_clip(hero, "02-select", max(m["ready"], m["select"]-.55), m["created"]+.2, 9,
        ("01  SELECT / REFINE / CREATE", "Draw around an object. Make it editable.",
         "AI mask / depth-aware splat selection / named scene object.")))
    segments.append(capture_clip(hero, "03-transform", m["move"], m["transformed"], 8,
        ("02  TRANSFORM", "Move it. Rotate it. Keep the room around it.",
         "The selected splats move together as an object.")))
    segments.append(montage(captures, args.allow_partial))
    segments.append(capture_clip(hero, "05-save", m["transformed"]-.5, m["end"]-.05, 10,
        ("03  DELETE / UNDO / SAVE", "Experiment freely. Save an editable project.",
         "Undo restores a deleted object. Project files preserve the edit state.")))
    defaults = [
        ("01-method.png", 10, "UNDER THE HOOD", "From a 2D mask to a 3D object",
         ["A box prompt goes to SAM 2 for a mask of the visible object.",
          "Project splat centers into the mask, then filter by local surface depth.",
          "Keep selected splats together in a transformable scene node."]),
        ("02-floor.png", 10, "BACKGROUND REPAIR", "Moving an object reveals missing pixels",
         ["The source scene does not fully capture what was behind the object.",
          "An approximate planar floor patch extends nearby floor appearance.",
          "This is a practical visual patch, not generative completion."]),
        ("03-challenges.png", 20, "WHAT WAS HARD", "Three challenges. Three explicit tradeoffs.",
         ["Depth leaks: a 2D mask also covers background. Local surface-depth filtering reduces that leakage.",
          "Hidden background: use an approximate floor patch; complex surfaces remain limited.",
          "Incomplete backs: add or subtract selections from additional views."]),
        ("04-technology.png", 20, "TECHNOLOGY ROLES", "A focused stack for spatial editing",
         ["World Labs Marble supplies the Gaussian-splat room assets.",
          "Spark + Three.js render the scene and provide transform controls.",
          "SAM 2 runs local mask inference on an NVIDIA RTX 6000 GPU."]),
        ("05-close.png", 5, "MARBLE STUDIO", "Make the scene your own.",
         ["Select. Refine. Move. Rotate. Scale. Save."]),
    ]
    slide_records = []
    for filename, duration, kicker, title, lines in defaults:
        path = ART / "slides" / filename
        if not path.exists():
            path = fallback_slide(filename.removesuffix(".png"), kicker, title, lines)
        segments.append(slide_clip(path, filename.removesuffix(".png"), duration))
        slide_records.append(str(path.relative_to(ROOT)))
    manifest = EDIT / "concat.txt"
    manifest.write_text("".join(f"file '{path.as_posix()}'\n" for path in segments))
    temp = args.output.with_name(args.output.stem + ".rendering.mp4")
    if args.audio:
        ffmpeg(["-f", "concat", "-safe", "0", "-i", str(manifest), "-i", str(args.audio),
                "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac",
                "-b:a", "128k", "-af", "apad", "-t", "120", "-movflags", "+faststart", str(temp)])
    else:
        ffmpeg(["-f", "concat", "-safe", "0", "-i", str(manifest),
                "-c", "copy", "-t", "120", "-movflags", "+faststart", str(temp)])
    probe = json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-show_format",
        "-show_streams", "-of", "json", str(temp)], text=True))
    video = next(s for s in probe["streams"] if s["codec_type"] == "video")
    duration = float(probe["format"]["duration"])
    if abs(duration-120) > .12 or (video["width"], video["height"]) != SIZE or video["codec_name"] != "h264":
        raise RuntimeError(f"Unexpected output: {duration}s, {video}")
    temp.replace(args.output)
    poster = args.output.with_suffix(".jpg")
    ffmpeg(["-ss", "18", "-i", str(args.output), "-frames:v", "1", "-q:v", "2", str(poster)])
    output_path = args.output.resolve()
    report_path = str(output_path.relative_to(ROOT)) if output_path.is_relative_to(ROOT) else output_path.name
    report = {"output": report_path, "duration": duration, "width": 1920, "height": 1080,
              "codec": "h264", "bytes": args.output.stat().st_size, "fps": FPS,
              "captured_objects": len(captures), "montage_tiles": 16,
              "partial": bool(missing), "missing": missing, "track_label": args.track,
              "hero": hero["id"], "slides": slide_records, "has_audio": bool(args.audio),
              "timeline": [{"start": 0, "end": 8, "content": "problem over working app"},
                           {"start": 8, "end": 25, "content": "selection and transform loop"},
                           {"start": 25, "end": 45, "content": "4x4 actual capture montage"},
                           {"start": 45, "end": 55, "content": "delete, undo, save"},
                           {"start": 55, "end": 75, "content": "method and floor repair"},
                           {"start": 75, "end": 95, "content": "challenges"},
                           {"start": 95, "end": 115, "content": "technology roles"},
                           {"start": 115, "end": 120, "content": "close"}]}
    args.output.with_suffix(".json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2), flush=True)


if __name__ == "__main__":
    main()
