import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Deterministic prompts plus recorded browser interactions. Transform playback
// drives the same scene node and TransformControls events as a pointer drag.
const root = resolve('artifacts/scene-editor/video');
await mkdir(`${root}/raw`, { recursive: true });
const shots = JSON.parse(await readFile('docs/demo/shots.json', 'utf8'));
const only = process.env.SHOTS?.split(',');
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=vulkan', '--enable-features=Vulkan', '--disable-vulkan-surface', '--ignore-gpu-blocklist'] });
process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY = '1';
// Access the dev component's existing engine without adding a production backdoor.
const engine = (page, action, args = {}) => page.evaluate(async ({ action, args }) => {
  const host = document.querySelector('.viewport-host');
  let fiber = host[Object.keys(host).find(k => k.startsWith('__reactFiber'))];
  while (fiber && fiber.type?.name !== 'SceneEditor') fiber = fiber.return;
  const e = fiber.memoizedState.next.memoizedState.current;
  return await new Function('e', 'args', `return (async () => { ${action} })()`)(e, args);
}, { action, args });
const wait = ms => new Promise(r => setTimeout(r, ms));
const manifests = [];
try {
  for (const shot of shots.filter(s => !only || only.includes(s.id))) {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, recordVideo: { dir: `${root}/raw`, size: { width: 1600, height: 1000 } } });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message)); page.setDefaultTimeout(120000);
    await page.route('https://fonts.googleapis.com/**', r => r.abort()); await page.route('https://fonts.gstatic.com/**', r => r.abort());
    const clockStart = Date.now(); const marks = {};
    const mark = key => { marks[key] = (Date.now() - clockStart) / 1000; };
    await page.goto(process.env.EDITOR_URL ?? 'http://127.0.0.1:5173');
    await page.getByText('500,000 splats', { exact: true }).waitFor();
    if (shot.scene !== 'seattle_modern') await page.getByLabel('Example scene').selectOption(shot.scene);
    await page.waitForFunction(s => document.querySelector('.viewport-topline')?.textContent.includes(s) && !document.querySelector('.viewport-loading'), shot.scene);
    if (shot.target) await engine(page, 'e.orbit.target.fromArray(args.target); e.orbit.update();', shot);
    await wait(1500); mark('ready');
    await page.screenshot({ path: `${root}/${shot.id}-before.png` });
    await page.getByRole('button', { name: 'Start selecting', exact: true }).click();
    await wait(400); mark('select');
    const [x1,y1,x2,y2] = shot.box;
    await page.mouse.move(x1,y1); await page.mouse.down(); await page.mouse.move(x2,y2,{steps:30}); await wait(350); await page.mouse.up();
    await page.waitForFunction(() => !document.querySelector('.viewport-loading'));
    await wait(900); mark('mask');
    const count = await engine(page, 'return e.state.selectionCount;');
    if (count < 30) throw new Error(`${shot.id}: empty or tiny selection (${count})`);
    await page.screenshot({ path: `${root}/${shot.id}-mask.png` });
    await page.getByLabel('New object name').fill(shot.name);
    await page.getByRole('button', { name: 'Create object', exact: true }).click();
    await engine(page, 'await e.repairQueue;'); await wait(800); mark('created');
    const record = await engine(page, 'return { source: e.state.source, objects: e.state.objects, repairBackground: e.state.repairBackground };');
    await writeFile(`${root}/${shot.id}.spatial.json`, JSON.stringify({format:'marble-scene-editor',version:1,...record}));
    // World-horizontal translation relative to this camera keeps the motion legible.
    mark('move');
    await engine(page, `
      const node = e.gizmo.object, original = node.position.clone();
      const right = original.clone().set(1,0,0).applyQuaternion(e.camera.quaternion); right.y=0; right.normalize();
      e.gizmo.dispatchEvent({type:'dragging-changed', value:true});
      await new Promise(resolve => { const start=performance.now(); function tick(now) {
        const t=Math.min(1,(now-start)/4000), k=t*t*(3-2*t);
        node.position.copy(original).addScaledVector(right, args.move*k);
        e.gizmo.dispatchEvent({type:'objectChange'});
        if(t<1) requestAnimationFrame(tick); else resolve();
      } requestAnimationFrame(tick); });
      e.gizmo.dispatchEvent({type:'dragging-changed',value:false});`, shot);
    await wait(1600); mark('moved');
    await page.screenshot({ path: `${root}/${shot.id}-moved.png` });
    await page.getByRole('button', { name: 'Reset transform', exact: true }).click(); await wait(400);
    await page.getByRole('button', { name: shot.action === 'rotate' ? 'Rotate' : 'Scale', exact: true }).click(); await wait(500); mark('transform');
    await engine(page, `
      const node=e.gizmo.object; e.gizmo.dispatchEvent({type:'dragging-changed',value:true});
      await new Promise(resolve => { const start=performance.now(); function tick(now) {
        const t=Math.min(1,(now-start)/4000), k=t*t*(3-2*t);
        if(args.action==='rotate') node.rotation.y=args.amount*Math.PI/180*k;
        else { const scale=1+(args.amount-1)*k; node.scale.set(scale,scale,scale); }
        e.gizmo.dispatchEvent({type:'objectChange'}); if(t<1) requestAnimationFrame(tick); else resolve();
      } requestAnimationFrame(tick); }); e.gizmo.dispatchEvent({type:'dragging-changed',value:false});`, shot);
    await wait(1600); mark('transformed');
    await page.screenshot({ path: `${root}/${shot.id}-transformed.png` });
    await page.getByRole('button', { name: /Delete object/ }).click(); await wait(1000); mark('deleted');
    await page.screenshot({ path: `${root}/${shot.id}-deleted.png` });
    await page.getByRole('button', { name: 'Undo', exact: true }).click(); await wait(700); mark('undo');
    const download = page.waitForEvent('download'); await page.getByRole('button',{name:'Save project',exact:true}).click(); await (await download).saveAs(`${root}/${shot.id}-edited.spatial.json`);
    await wait(700); mark('end');
    const video=page.video(); await context.close(); const path=await video.path();
    const result={...shot,video:path,marks,sourceHash:record.source.sha256,selected:count,sourceCount:record.source.count,errors};
    manifests.push(result); await writeFile(`${root}/${shot.id}-capture.json`, JSON.stringify(result,null,2));
    console.log(`${shot.id}: ${count} splats; ${marks.end.toFixed(1)}s recorded; ${errors.length} errors`);
    if(errors.length) throw new Error(errors.join('\n'));
  }
} finally { await browser.close(); }
await writeFile(`${root}/capture-manifest.json`,JSON.stringify(manifests,null,2));
