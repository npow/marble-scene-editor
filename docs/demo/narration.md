# Marble Studio video

The complete timed narration and slide copy live in [video-copy.json](./video-copy.json). The suggested edit is 120 seconds: experience first (0–55), method (55–75), challenges (75–95), actual technology (95–115), close (115–120).

Official event and track names are awaiting confirmation. “Spatial editing” describes the project focus. It is not presented as an official track.

All cards are 1920 × 1080 and render from [slides.html](./slides.html), using the `?slide=ID` query parameter. Serve the repository over HTTP, or inject the parsed JSON as `window.__VIDEO_COPY__` before loading the HTML. Wait for `window.__SLIDE_READY__`, then capture at device scale factor 1. For `title-overlay` and `problem-overlay`, use a transparent screenshot (`omitBackground: true`).

The PNG assets are under `artifacts/scene-editor/video/slides/`. Full frame title is optional: prefer the transparent title and problem overlays over real application footage during the first eight seconds. Keep the working editor visible through 55 seconds. The loop appears in the method card footer and should be demonstrated before that card.

The sixteen-edit montage copy assumes the final montage includes two distinct recorded edits for each of the eight objects in `shots.json`. Confirm the actual captures before using that line. Recorded transform playback uses the real scene node and TransformControls events; do not call it unscripted footage.

The floor diagram explains a method, not an observed result. It shows nearby floor reused in a flat patch. Do not present the patch as recovered hidden geometry or general AI inpainting. The actual current technology credits are World Labs Marble, Meta SAM 2, Spark, Three.js, and an NVIDIA RTX 6000 GPU. Convex and Isaac are not part of the editor being demonstrated.

## Optional spoken script

**0:00–0:08** Generated rooms look real, but their objects aren’t independently editable. Marble Studio lets you select an object and change the scene.

**0:08–0:25** Import a world, frame the object, and draw a box. Refine the selection, name the object, and move it with the transform gizmo. The object becomes a separate group you can rotate, scale, or delete.

**0:25–0:45** Here are sixteen recorded edits across eight objects in four scenes: furniture, tables, and a kitchen island. Each pair shows a move and a second transform. The same editing loop carries across the different rooms.

**0:45–0:55** Undo brings the object back. Save the project to keep the source scene and its edits together, ready to reopen.

**0:55–1:05** SAM 2 masks the current view. Projecting that mask onto splats, with local depth checks, forms an editable object.

**1:05–1:15** Moving an object can reveal missing floor. A flat patch reuses nearby rendered floor, with visible tiling and residual artifacts.

**1:15–1:35** A selection can accidentally include the background, so we check distance behind the object. Moving furniture can expose missing floor, which we approximate. A view can also hide parts of an object. Selecting from another angle can include more existing geometry, but does not reconstruct missing surfaces.

**1:35–1:55** World Labs Marble provides the world assets and API import. Meta SAM 2 creates local screen masks. Spark and Three.js render the splats and provide the transform gizmos. An NVIDIA RTX 6000 GPU runs SAM 2 inference. Together, they connect a generated world to direct object editing.

**1:55–2:00** Marble Studio. Make the room your own.
