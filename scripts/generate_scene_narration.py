#!/usr/bin/env python3
"""Generate the 120-second demo narration with local Kokoro inference.

Use Python 3.10–3.12 in a separate environment. Install kokoro==0.9.4,
misaki[en]==0.9.4, soundfile==0.14.0 and a compatible Torch build. FFmpeg must
be on PATH. A first run downloads the pinned official model and English
pronunciation resources; later runs reuse the local cache. No API key is used.

HF_HOME=/path/to/voice-cache python scripts/generate_scene_narration.py
Add --sample to generate only opening.wav for listening before a full run.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

os.environ.setdefault("HF_HUB_DISABLE_IMPLICIT_TOKEN", "1")

import numpy as np
import soundfile as sf
import torch
from huggingface_hub import snapshot_download
from kokoro import KModel, KPipeline

ROOT = Path(__file__).resolve().parents[1]
RATE = 24000
MODEL_SHA256 = "496dba118d1a58f5f3db2efc88dbdc216e0483fc89fe6e47ee1f2c53f18ad1e4"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--script", type=Path, default=ROOT / "docs/demo/spoken-script.json")
    parser.add_argument("--output", type=Path, default=ROOT / "artifacts/scene-editor/video/narration.wav")
    parser.add_argument("--sample", action="store_true")
    args = parser.parse_args()
    copy = json.loads(args.script.read_text())
    sections = copy["sections"][:1] if args.sample else copy["sections"]
    voice_dir = args.output.parent / "narration-sections"
    voice_dir.mkdir(parents=True, exist_ok=True)
    model_dir = Path(snapshot_download(copy["model"], revision=copy["revision"], token=False,
                                      allow_patterns=["config.json", "kokoro-v1_0.pth", f"voices/{copy['voice']}.pt"]))
    weights = model_dir / "kokoro-v1_0.pth"
    if hashlib.sha256(weights.read_bytes()).hexdigest() != MODEL_SHA256:
        raise RuntimeError("Kokoro model checksum differs from the published v1.0 checksum")
    torch.set_num_threads(4)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = KModel(repo_id=copy["model"], config=str(model_dir / "config.json"), model=str(weights)).to(device).eval()
    pipeline = KPipeline(lang_code="a", model=model)
    voice = torch.load(model_dir / f"voices/{copy['voice']}.pt", weights_only=True)
    timeline = np.zeros(round(copy["duration"] * RATE), dtype=np.float32)
    report = []
    for section in sections:
        print(f"Generating {section['id']}…", flush=True)
        outputs = [result.audio.numpy() for result in pipeline(section["text"], voice=voice, speed=1)]
        audio = np.concatenate(outputs)
        raw = voice_dir / f"{section['id']}-raw.wav"
        target = voice_dir / f"{section['id']}.wav"
        sf.write(raw, audio, RATE, subtype="PCM_16")
        words = len(re.findall(r"\b[\w']+\b", section["text"]))
        target_duration = min(words * 60 / copy["targetWordsPerMinute"], section["end"] - section["start"] - .45)
        tempo = len(audio) / RATE / target_duration
        if not .5 <= tempo <= 2:
            raise RuntimeError(f"Unnatural timing adjustment for {section['id']}: {tempo:.3f}")
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(raw),
                        "-af", f"atempo={tempo:.8f},afade=t=in:d=0.01,afade=t=out:st={target_duration-.03}:d=0.03",
                        "-ar", str(RATE), "-ac", "1", str(target)], check=True)
        fitted, sample_rate = sf.read(target, dtype="float32")
        assert sample_rate == RATE
        start = round((section["start"] + .15) * RATE)
        if start + len(fitted) > round(section["end"] * RATE):
            raise RuntimeError(f"Narration overruns section {section['id']}")
        timeline[start:start + len(fitted)] = fitted
        record = {"id": section["id"], "file": str(target.relative_to(ROOT)), "start": section["start"] + .15,
                  "duration": round(len(fitted) / RATE, 3), "words": words, "tempo": round(tempo, 4)}
        report.append(record)
        print(json.dumps(record), flush=True)
    if args.sample:
        print(f"Sample ready: {voice_dir / 'opening.wav'}", flush=True)
        return
    peak = float(np.max(np.abs(timeline)))
    if peak > .95:
        timeline *= .95 / peak
    sf.write(args.output, timeline, RATE, subtype="PCM_16")
    (voice_dir / "timing.json").write_text(json.dumps({"duration": len(timeline) / RATE, "model": copy["model"],
        "revision": copy["revision"], "voice": copy["voice"], "sections": report}, indent=2) + "\n")
    print(f"Ready: {args.output} ({len(timeline) / RATE:.3f} seconds)", flush=True)


if __name__ == "__main__":
    main()
