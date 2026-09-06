#!/usr/bin/env node
// Render the durable HTML/copy sources. All generated files stay under artifacts.
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  track: { type: 'string' },
  slide: { type: 'string' },
  'output-dir': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} });
if (values.help) {
  console.log('Usage: node scripts/render_scene_slides.mjs [--track "Exact confirmed track"] [--slide technology] [--output-dir artifacts/scene-editor/video/slides]\nCHROME_PATH overrides the browser executable. --track changes rendering in memory only.');
  process.exit(0);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const copy = JSON.parse(await readFile(resolve(root, 'docs/demo/video-copy.json'), 'utf8'));
const slides = [...copy.slides, ...copy.overlays].filter(slide => !values.slide || slide.id === values.slide);
if (!slides.length) throw new Error(`Unknown slide: ${values.slide}`);
if (values.track !== undefined) {
  const track = values.track.trim();
  if (!track) throw new Error('--track must contain the confirmed track name');
  const oldFocus = copy.focus;
  copy.track = track;
  copy.focus = `Track · ${track}`;
  // The template uses event before focus in its running header.
  if (copy.event) copy.event = `${copy.event} · ${track}`;
  for (const item of [...copy.slides, ...copy.overlays]) {
    if (item.eyebrow === oldFocus) item.eyebrow = copy.focus;
  }
}

const output = resolve(root, values['output-dir'] ?? copy.assetDirectory);
await mkdir(output, { recursive: true });
const chrome = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';
const browser = await chromium.launch({
  ...(process.env.CHROME_PATH || existsSync(chrome) ? { executablePath: chrome } : {}),
  headless: true,
  // Code-native slides need no WebGL; software rendering also avoids GPU contention.
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
});
try {
  const page = await browser.newPage({
    viewport: { width: copy.theme.width, height: copy.theme.height },
    deviceScaleFactor: 1,
  });
  await page.addInitScript(data => { window.__VIDEO_COPY__ = data; }, copy);
  for (const slide of slides) {
    const url = pathToFileURL(resolve(root, 'docs/demo/slides.html'));
    url.searchParams.set('slide', slide.id);
    await page.goto(url.href);
    await page.waitForFunction(() => window.__SLIDE_READY__ === true);
    const path = resolve(output, slide.file);
    await page.screenshot({ path, omitBackground: slide.id.endsWith('overlay') });
    console.log(path);
  }
} finally {
  await browser.close();
}
