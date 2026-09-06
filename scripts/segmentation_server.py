#!/usr/bin/env python3
"""Local SAM2 mask service for the scene editor; no assets leave this machine."""
from __future__ import annotations

import base64
import io
import json
import os
import threading
import urllib.error
import urllib.request
from uuid import UUID
from contextlib import asynccontextmanager

import numpy as np
import torch
from fastapi import FastAPI, HTTPException, Request
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, Field
from transformers import Sam2Model, Sam2Processor

MODEL = "facebook/sam2-hiera-large"
REVISION = "e6a8e8809b8f1bfa2238b6d080f3d05cc76bd251"
lock = threading.Lock()
processor = None
model = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global processor, model
    device = "cuda" if torch.cuda.is_available() else "cpu"
    processor = Sam2Processor.from_pretrained(MODEL, revision=REVISION)
    model = Sam2Model.from_pretrained(MODEL, revision=REVISION).eval().to(device)
    yield


app = FastAPI(lifespan=lifespan)


class MaskRequest(BaseModel):
    image: str = Field(max_length=8_000_000)
    box: list[float] = Field(min_length=4, max_length=4)


@app.middleware("http")
async def limit_body(request: Request, call_next):
    # Bound streamed bodies too, rather than trusting Content-Length.
    size = 0
    chunks = []
    async for chunk in request.stream():
        size += len(chunk)
        if size > 8_100_000:
            from fastapi.responses import JSONResponse
            return JSONResponse({"detail": "Image request is too large"}, status_code=413)
        chunks.append(chunk)
    request._body = b"".join(chunks)
    return await call_next(request)


@app.get("/api/segmentation/health")
def health():
    return {"ready": model is not None, "model": MODEL, "revision": REVISION}


@app.get("/api/segmentation/worlds/{world_id}")
def get_world(world_id: UUID):
    """Resolve existing worlds; keys and authenticated requests stay on the server.

    Reference: https://docs.worldlabs.ai/api/reference/worlds/get
    """
    keys = [os.environ[name] for name in ("WORLD_LABS_API_KEY", "WORLD_LABS_API_KEY2") if os.environ.get(name)]
    if not keys:
        raise HTTPException(503, "Set WORLD_LABS_API_KEY on the local segmentation service, or import a downloaded asset.")
    for key in keys:
        request = urllib.request.Request(f"https://api.worldlabs.ai/marble/v1/worlds/{world_id}", headers={"WLT-Api-Key": key})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                data = json.load(response)
                world = data.get("world", data)
                return {"world_id": str(world_id), "display_name": world.get("display_name"), "assets": world.get("assets")}
        except urllib.error.HTTPError as error:
            if error.code in (401, 403, 404):
                continue
            raise HTTPException(502, f"World Labs returned HTTP {error.code}.") from None
        except (urllib.error.URLError, TimeoutError):
            raise HTTPException(502, "Could not reach World Labs.") from None
    raise HTTPException(404, "World not found or neither configured key has access.")


@app.post("/api/segmentation/mask")
def mask(request: MaskRequest):
    try:
        raw = base64.b64decode(request.image.split(",")[-1], validate=True)
        image = Image.open(io.BytesIO(raw))
        if image.width * image.height > 2_000_000:
            raise ValueError("Image must be at most 2 megapixels")
        image = image.convert("RGB")
        box = np.asarray(request.box, dtype=float)
        if not np.isfinite(box).all() or not (0 <= box[0] < box[2] <= image.width and 0 <= box[1] < box[3] <= image.height):
            raise ValueError("Box must fit inside the image")
    except (ValueError, UnidentifiedImageError, Image.DecompressionBombError) as error:
        raise HTTPException(400, str(error)) from error
    if model is None or processor is None:
        raise HTTPException(503, "Segmentation model is still loading")
    # Crop around the prompt so a small object receives enough model resolution.
    pad = max(48, int(max(box[2] - box[0], box[3] - box[1]) * 0.3))
    left, top = max(0, int(box[0]) - pad), max(0, int(box[1]) - pad)
    right, bottom = min(image.width, int(box[2]) + pad), min(image.height, int(box[3]) + pad)
    crop = image.crop((left, top, right, bottom))
    local_box = (box - [left, top, left, top]).tolist()
    with lock, torch.inference_mode():
        inputs = processor(images=crop, input_boxes=[[local_box]], return_tensors="pt").to(model.device)
        outputs = model(**inputs, multimask_output=False)
        predicted = processor.post_process_masks(outputs.pred_masks.cpu(), inputs["original_sizes"])[0][0, 0].numpy()
    full = np.zeros((image.height, image.width), dtype=np.uint8)
    full[top:bottom, left:right] = predicted.astype(np.uint8) * 255
    buffer = io.BytesIO()
    Image.fromarray(full).save(buffer, format="PNG")
    return {"mask": base64.b64encode(buffer.getvalue()).decode(), "score": float(outputs.iou_scores.item())}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8008)
