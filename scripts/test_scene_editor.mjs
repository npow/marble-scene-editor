import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

// Run against `npm run dev -- --port 5173`. --ai exercises the real local SAM2 service.
const useAi = process.argv.includes('--ai');
const base = process.env.EDITOR_URL ?? 'http://127.0.0.1:5173';
const artifacts = new URL('../artifacts/scene-editor/', import.meta.url);
await mkdir(artifacts, { recursive: true });
process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY = '1';
const executablePath = process.env.CHROME_PATH ?? (existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined);
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=vulkan', '--enable-features=Vulkan', '--disable-vulkan-surface', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.setDefaultTimeout(30000);
const errors = []; page.on('pageerror', error => errors.push(error.message));
// Font availability must not determine graphics test completion.
await page.route('https://fonts.googleapis.com/**', route => route.abort());
await page.route('https://fonts.gstatic.com/**', route => route.abort());
const settle = async () => {
  await page.waitForFunction(() => !document.querySelector('.viewport-loading'), {}, { timeout: 120000 });
  await page.waitForTimeout(800); // Allow the asynchronous GPU splat sort to finish.
};
const capture = name => page.screenshot({ path: new URL(name, artifacts).pathname, timeout: 30000 });
const save = async name => {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  await (await pending).saveAs(new URL(name, artifacts).pathname);
  return JSON.parse(await readFile(new URL(name, artifacts), 'utf8'));
};
const draw = async (x1, y1, x2, y2) => {
  await page.mouse.move(x1, y1); await page.mouse.down(); await page.mouse.move(x2, y2, { steps: 12 }); await page.mouse.up(); await settle();
};

try {
  await page.goto(base);
  await page.getByText('500,000 splats', { exact: true }).waitFor(); await settle();
  await capture('01-loaded.png');
  if (useAi) {
    const health = await page.request.get(`${base}/api/segmentation/health`);
    assert.equal(health.status(), 200, 'AI test requires the segmentation service');
  } else await page.getByRole('button', { name: 'Box', exact: true }).click();
  await page.getByRole('button', { name: 'Start selecting', exact: true }).click();
  await draw(492, 495, 914, 824);
  const count = Number((await page.locator('.selection-count').innerText()).replace(/[^0-9]/g, ''));
  assert.ok(count > 100 && count < 100000, `Expected an object-sized segment; selected ${count}`);
  await capture('02-selected.png');

  // Subtract from a preview and restore it by adding the same area again.
  await page.getByRole('button', { name: 'Box', exact: true }).click();
  await page.getByRole('button', { name: '− Subtract', exact: true }).click();
  await draw(530, 590, 700, 700);
  const subtracted = Number((await page.locator('.selection-count').innerText()).replace(/[^0-9]/g, ''));
  assert.ok(subtracted < count, 'Subtract must remove actual source indices');
  await page.getByRole('button', { name: '+ Add', exact: true }).click();
  await draw(530, 590, 700, 700);
  assert.ok(Number((await page.locator('.selection-count').innerText()).replace(/[^0-9]/g, '')) > subtracted);
  await page.getByLabel('New object name').fill('Sofa');
  await page.getByRole('button', { name: 'Create object', exact: true }).click(); await settle();
  assert.equal(await page.locator('.object-row').count(), 1);
  const x = Number(await page.getByLabel('position X', { exact: true }).inputValue());
  for (const [label, value] of [['position X', String(x - 1.5)], ['rotation Y', '30'], ['scale Z', '1.1']]) {
    await page.getByLabel(label, { exact: true }).fill(value); await page.getByLabel(label, { exact: true }).press('Enter');
  }
  await settle(); await capture('03-transformed.png');
  const project = await save('splats.spatial.json');
  assert.equal(project.source.kind, 'splats'); assert.equal(project.source.count, 500000);
  assert.equal(project.objects[0].name, 'Sofa'); assert.equal(project.objects[0].scale[2], 1.1);
  assert.ok(Math.abs(project.objects[0].rotation[1] - Math.PI / 6) < 1e-6);
  assert.equal(new Set(project.objects[0].indices).size, project.objects[0].indices.length);
  await page.getByRole('button', { name: /Delete object/ }).click(); await settle();
  assert.equal(await page.locator('.object-row').count(), 0);
  const deleted = await save('deleted.spatial.json'); assert.equal(deleted.objects[0].deleted, true);
  assert.deepEqual(deleted.objects[0].indices, project.objects[0].indices);
  assert.equal(deleted.repairBackground, true);
  assert.match(await page.locator('.background-repair-control').innerText(), /1 floor area filled/);
  await capture('05-background-filled.png');
  await page.getByLabel('Repair background').uncheck(); await settle();
  await capture('06-background-unfilled.png');
  assert.equal((await save('repair-disabled.spatial.json')).repairBackground, false);
  await page.getByLabel('Repair background').check(); await settle();
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); await settle(); assert.equal(await page.getByLabel('Repair background').isChecked(), false);
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); await settle(); assert.equal(await page.getByLabel('Repair background').isChecked(), true);
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); await settle(); assert.equal(await page.locator('.object-row').count(), 1);
  await page.getByRole('button', { name: 'Redo', exact: true }).click(); await settle(); assert.equal(await page.locator('.object-row').count(), 0);
  await page.getByRole('button', { name: 'Restore original scene', exact: true }).click(); await settle();
  const chooser = page.waitForEvent('filechooser'); await page.getByRole('button', { name: 'Open saved project', exact: true }).click();
  await (await chooser).setFiles(new URL('splats.spatial.json', artifacts).pathname); await settle();
  const restored = await save('restored.spatial.json'); assert.deepEqual(restored.objects, project.objects);
  await page.reload(); await page.getByText('500,000 splats', { exact: true }).waitFor(); await settle();
  assert.deepEqual((await save('autosaved.spatial.json')).objects, project.objects, 'Reload must recover locally saved edits');
  console.log(`Splats: ${project.objects[0].indices.length} source elements; refine, move, rotate, scale, delete, undo/redo and save/reopen passed.`);

  await page.getByRole('button', { name: 'Mesh', exact: true }).click(); await settle();
  // Check original triangle provenance separately from generated repair polygons.
  await page.getByLabel('Repair background').uncheck(); await settle();
  await page.getByRole('button', { name: 'Box', exact: true }).click();
  await page.getByRole('button', { name: 'Start selecting', exact: true }).click(); await draw(492, 495, 914, 824);
  await page.getByLabel('New object name').fill('Mesh object'); await page.getByRole('button', { name: 'Create object', exact: true }).click(); await settle();
  const meshProject = await save('mesh.spatial.json'); assert.equal(meshProject.source.kind, 'mesh'); assert.ok(meshProject.objects[0].indices.length > 0);
  await page.getByRole('button', { name: /Delete object/ }).click(); await settle();
  const exported = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export edited GLB', exact: true }).click();
  await (await exported).saveAs(new URL('edited-scene.glb', artifacts).pathname);
  const glb = await readFile(new URL('edited-scene.glb', artifacts)); assert.equal(glb.readUInt32LE(0), 0x46546c67);
  const jsonLength = glb.readUInt32LE(12), json = JSON.parse(glb.subarray(20, 20 + jsonLength).toString());
  let triangles = 0; for (const mesh of json.meshes) for (const primitive of mesh.primitives) triangles += json.accessors[primitive.indices ?? primitive.attributes.POSITION].count / 3;
  assert.equal(triangles, meshProject.source.count - meshProject.objects[0].indices.length, 'Export must omit the selected source triangles exactly once');
  await capture('04-mesh-deleted.png');
  console.log(`Mesh: ${meshProject.objects[0].indices.length} source faces deleted; exported GLB has exactly ${triangles} remaining triangles.`);

  // Simulate an unavailable model: errors must terminate loading and leave Box usable.
  await page.route('**/api/segmentation/mask', route => route.fulfill({ status: 503, body: '{}' }));
  await page.getByRole('button', { name: 'AI mask', exact: true }).click(); await page.getByRole('button', { name: 'Start selecting', exact: true }).click();
  await draw(950, 510, 1245, 660);
  assert.match(await page.getByRole('alert').innerText(), /unavailable/);
  await page.getByRole('button', { name: 'Dismiss error', exact: true }).click();
  await page.getByRole('button', { name: 'Box', exact: true }).click(); await draw(950, 510, 1245, 660);
  assert.ok(await page.getByRole('button', { name: 'Create object', exact: true }).isEnabled());
  assert.deepEqual(errors, [], 'No uncaught browser exceptions');
  console.log('Offline AI recovery passed. Screenshots and roundtrip artifacts: artifacts/scene-editor/');
} finally { await browser.close(); }
