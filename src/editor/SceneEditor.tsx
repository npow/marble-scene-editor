import React, { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, Box, Check, ChevronDown, Crosshair, FolderOpen, Hand, Layers3, LoaderCircle, Maximize, MousePointer2, Move3D, Plus, Redo2, Rotate3D, RotateCcw, Scaling, Scan, Sparkles, Trash2, Undo2, Upload, X } from 'lucide-react';
import { SceneEngine, type EditorState, type Mode, type SelectionTool } from './SceneEngine';
import './editor.css';

const EXAMPLES = [
  ['seattle_modern', 'Seattle living room'], ['sf_penthouse_loft', 'SF penthouse'],
  ['house_1', 'House 01'], ['house_2', 'House 02'],
] as const;

function NumberField({ label, value, step = 0.1, min, onChange }: { label: string; value: number; step?: number; min?: number; onChange: (value: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(Math.round(value * 1000) / 1000)), [value]);
  const commit = () => {
    const n = Number(draft); if (draft.trim() && Number.isFinite(n) && (min === undefined || n >= min)) { if (Math.abs(n - value) > 1e-6) onChange(n); }
    else setDraft(String(value));
  };
  return <label className="number-field"><span>{label.split(' ').slice(-1)[0]}</span><input aria-label={label} type="number" step={step} min={min} value={draft} onChange={event => setDraft(event.target.value)} onBlur={commit} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} /></label>;
}

export function SceneEditor() {
  const host = useRef<HTMLDivElement>(null), engine = useRef<SceneEngine | null>(null);
  const fileInput = useRef<HTMLInputElement>(null), projectInput = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<EditorState | null>(null);
  const [example, setExample] = useState('seattle_modern'), [display, setDisplay] = useState<'splats' | 'mesh'>('splats');
  const [tool, setTool] = useState<SelectionTool>('ai'), [operation, setOperation] = useState<'replace' | 'add' | 'subtract'>('replace');
  const [name, setName] = useState(''), [url, setUrl] = useState(''), [importOpen, setImportOpen] = useState(false);
  const [marble, setMarble] = useState(true), [scale, setScale] = useState(1);
  const [aiReady, setAiReady] = useState(false);
  const selected = state?.objects.find(object => object.id === state.selectedId);
  const disabled = !state?.source || state.busy;

  const loadExample = async (slug: string, kind: 'splats' | 'mesh') => {
    try {
      const response = await fetch(`/assets/scenarios/${slug}/world_meta.json`);
      if (!response.ok) throw new Error('Example metadata is missing.');
      const metadata = await response.json(), transform = metadata.assets.splats.semantics_metadata;
      const filename = kind === 'splats' ? 'scene_splats_500k.spz' : 'scene_collider.glb';
      await engine.current?.load({ name: `${slug}/${filename}`, url: `/assets/scenarios/${slug}/${filename}`, scale: transform.metric_scale_factor, ground: transform.ground_plane_offset });
    } catch (error) { engine.current?.reportError(error); }
  };

  useEffect(() => {
    if (!host.current) return;
    try { engine.current = new SceneEngine(host.current, next => { setState(next); if (next.source && !next.busy) setDisplay(next.source.kind); }); void loadExample('seattle_modern', 'splats'); }
    catch (error) { setState({ busy: false, error: `Unable to start WebGL2: ${String(error)}`, status: '', source: null, objects: [], selectedId: null, mode: 'orbit', selectionCount: 0, near: 0, far: 2, canUndo: false, canRedo: false, repairBackground: true, repairedCount: 0 }); }
    return () => { engine.current?.dispose(); engine.current = null; };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const check = () => { void fetch('/api/segmentation/health', { signal: controller.signal }).then(r => r.ok ? r.json() : null).then(data => setAiReady(Boolean(data?.ready))).catch(() => {}); };
    check(); const interval = setInterval(check, 15000);
    return () => { controller.abort(); clearInterval(interval); };
  }, []);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).closest('input,textarea,select,[contenteditable]')) return;
      const e = engine.current; if (!e || e.state.busy) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? e.redo() : e.undo(); return; }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); e.saveProject(); return; }
      const modes: Record<string, Mode> = { v: 'orbit', s: 'segment', g: 'translate', r: 'rotate', e: 'scale' };
      if (modes[event.key.toLowerCase()]) e.setMode(modes[event.key.toLowerCase()]);
      if (event.key.toLowerCase() === 'f') e.focus();
      if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); e.deleteSelected(); }
      if (event.key === 'Escape') { e.cancelSelection(); e.setMode('orbit'); }
    };
    window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler);
  }, []);

  const importAsset = async (file?: File) => {
    if (!file && !url.trim()) return;
    try {
      const worldMatch = !file && url.trim().match(/^(?:https:\/\/marble\.worldlabs\.ai\/world\/)?([0-9a-f]{8}-[0-9a-f-]{27})(?:[/?#].*)?$/i);
      if (worldMatch) {
        const response = await fetch(`/api/segmentation/worlds/${worldMatch[1]}`);
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail ?? 'Unable to open this World Labs world.');
        const splats = data.assets?.splats, transform = splats?.semantics_metadata;
        const assetUrl = splats?.spz_urls?.['500k'] ?? data.assets?.mesh?.collider_mesh_url;
        if (!assetUrl) throw new Error('This world does not have completed assets yet.');
        if (!await engine.current?.load({ name: new URL(assetUrl).pathname.split('/').pop()!, url: assetUrl, scale: transform?.metric_scale_factor ?? 1, ground: transform?.ground_plane_offset ?? 0 })) return;
        setExample(''); setImportOpen(false); return;
      }
      const assetName = file?.name ?? new URL(url.trim()).pathname.split('/').pop() ?? 'scene.spz';
      if (/\.json$/i.test(assetName)) {
        const data = file ? JSON.parse(await file.text()) : await (await fetch(url)).json();
        if (data.format === 'marble-scene-editor') engine.current?.loadProject(data);
        else {
          const splats = data.assets?.splats, transform = splats?.semantics_metadata;
          const assetUrl = splats?.spz_urls?.['500k'] ?? data.assets?.mesh?.collider_mesh_url;
          if (!assetUrl) throw new Error('Expected World Labs world_meta.json or a saved scene project.');
          if (!await engine.current?.load({ name: new URL(assetUrl).pathname.split('/').pop()!, url: assetUrl, scale: transform?.metric_scale_factor ?? scale, ground: transform?.ground_plane_offset ?? 0, marble })) return;
          setExample('');
        }
      } else {
        if (!/\.(spz|ply|splat|glb)$/i.test(assetName)) throw new Error('Choose a SPZ, Gaussian PLY, SPLAT, GLB, or World Labs metadata JSON.');
        if (!await engine.current?.load({ name: assetName, ...(file ? { bytes: await file.arrayBuffer() } : { url: url.trim() }), scale, marble })) return;
        setExample('');
      }
      setImportOpen(false);
    } catch (error) { engine.current?.reportError(error); }
  };

  return <main className="scene-editor" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); if (!state?.busy) void importAsset(event.dataTransfer.files[0]); }}>
    <header className="editor-header">
      <div className="editor-brand"><div className="brand-mark"><Layers3 size={22} /></div><div><strong>Marble Studio</strong><span>Scene editor</span></div></div>
      <div className="header-divider" />
      <div className="scene-select"><select aria-label="Example scene" disabled={state?.busy} value={example} onChange={event => { setExample(event.target.value); void loadExample(event.target.value, display); }}>{!example && <option value="">Imported scene</option>}{EXAMPLES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select><ChevronDown size={13} /></div>
      <div className="representation-toggle" style={{ visibility: example ? 'visible' : 'hidden' }}>{(['splats', 'mesh'] as const).map(kind => <button key={kind} disabled={state?.busy} className={display === kind ? 'active' : ''} onClick={() => { setDisplay(kind); void loadExample(example, kind); }}>{kind === 'splats' ? 'Splats' : 'Mesh'}</button>)}</div>
      <div className="header-actions"><button disabled={state?.busy} onClick={() => setImportOpen(true)}><Upload size={15} /> Import scene</button><button className="primary-button" disabled={disabled} onClick={() => engine.current?.saveProject()}><ArrowDownToLine size={15} /> Save project</button></div>
    </header>

    <div className="editor-workspace">
      <aside className="objects-panel">
        <div className="panel-heading"><span>SCENE OBJECTS</span><span className="count-badge">{state?.objects.filter(o => !o.deleted).length ?? 0}</span></div>
        <button className={`room-row ${!selected ? 'selected' : ''}`} onClick={() => engine.current?.select(null)}><Layers3 size={17} /><span>Original scene<small>{state?.source ? `${state.source.count.toLocaleString()} ${state.source.kind === 'splats' ? 'splats' : 'triangles'}` : 'Loading…'}</small></span><span className="room-dot" /></button>
        <div className="object-list">
          {state?.objects.filter(o => !o.deleted).map((object, index) => <button key={object.id} className={`object-row ${selected?.id === object.id ? 'selected' : ''}`} onClick={() => { engine.current?.select(object.id); engine.current?.setMode('translate'); }}><Box size={16} /><span>{object.name}<small>{object.indices.length.toLocaleString()} selected elements</small></span><span className="object-number">{String(index + 1).padStart(2, '0')}</span></button>)}
          {!state?.objects.some(o => !o.deleted) && <div className="objects-empty"><Scan size={28} /><p>Your objects live here.</p><span>Segment something in the scene to start editing.</span></div>}
        </div>
        <button className="new-object-button" disabled={disabled} onClick={() => { engine.current?.select(null); engine.current?.setMode('segment'); }}><Plus size={16} /> Segment an object <kbd>S</kbd></button>
        <div className="background-repair-control"><label><input type="checkbox" aria-label="Repair background" checked={state?.repairBackground ?? true} disabled={disabled} onChange={event => engine.current?.setRepairBackground(event.target.checked)} /> Repair background</label><span>{state?.repairedCount ? `${state.repairedCount} floor area${state.repairedCount === 1 ? '' : 's'} filled` : 'Extend nearby floor after move or delete'}</span></div><div className="panel-bottom"><button disabled={disabled || !state?.objects.length} onClick={() => engine.current?.reset()}><RotateCcw size={14} /> Restore original scene</button><button disabled={disabled} onClick={() => projectInput.current?.click()}><FolderOpen size={14} /> Open saved project</button>{state?.source?.kind === 'mesh' && <button disabled={disabled} onClick={() => { void engine.current?.exportMesh().catch(error => engine.current?.reportError(error)); }}><ArrowDownToLine size={14} /> Export edited GLB</button>}</div>
      </aside>

      <section className="viewport-shell" aria-label="3D scene viewport">
        <div ref={host} className="viewport-host" />
        <div className="viewport-topline"><span><span className="live-dot" />{state?.source?.name ?? 'Opening scene'}</span><button title="Frame selection or scene (F)" aria-label="Frame selection or scene" disabled={disabled} onClick={() => engine.current?.focus()}><Maximize size={15} /></button></div>
        {state?.mode === 'segment' && <div className="selection-hint"><Scan size={15} /> Drag a box around an object <span>·</span> {tool === 'ai' ? 'AI finds its outline' : 'Select by box and depth'}</div>}
        {state?.busy && <div className="viewport-loading"><LoaderCircle className="spin" size={26} /><strong>{state.status}</strong><span>{state.source ? 'Keep this view while the selection is calculated.' : 'Preparing your scene'}</span></div>}
        {state?.error && <div className="editor-error" role="alert"><span>{state.error}</span><button aria-label="Dismiss error" onClick={() => { if (engine.current) { engine.current.state.error = null; setState({ ...engine.current.state }); } }}><X size={15} /></button></div>}
        <div className="viewport-bottom">
          <div className="editor-toolbar" aria-label="Scene tools">
            {([['orbit', Hand, 'Navigate', 'V'], ['segment', Scan, 'Segment', 'S'], ['translate', Move3D, 'Move', 'G'], ['rotate', Rotate3D, 'Rotate', 'R'], ['scale', Scaling, 'Scale', 'E']] as const).map(([mode, Icon, label, key]) => <button key={mode} disabled={disabled || (['translate', 'rotate', 'scale'].includes(mode) && !selected)} aria-pressed={state?.mode === mode} title={`${label} (${key})`} className={state?.mode === mode ? 'active' : ''} onClick={() => engine.current?.setMode(mode)}><Icon size={18} /><span>{label}</span></button>)}
            <i /><button aria-label="Undo" title="Undo (Ctrl/⌘ Z)" disabled={disabled || !state?.canUndo} onClick={() => engine.current?.undo()}><Undo2 size={18} /></button><button aria-label="Redo" title="Redo (Ctrl/⌘ Shift Z)" disabled={disabled || !state?.canRedo} onClick={() => engine.current?.redo()}><Redo2 size={18} /></button>
          </div>
          <div className="viewport-help"><MousePointer2 size={12} /> Drag to orbit · Right drag to pan · Scroll to zoom</div>
        </div>
      </section>

      <aside className="inspector-panel">
        <div className="panel-heading"><span>{selected && state?.mode !== 'segment' ? 'OBJECT PROPERTIES' : 'SEGMENT OBJECT'}</span><Crosshair size={14} /></div>
        {selected && state?.mode !== 'segment' ? <>
          <div className="inspector-object-icon"><Box size={28} /></div>
          <input className="object-name-input" aria-label="Object name" key={selected.id + selected.name} defaultValue={selected.name} maxLength={120} onBlur={event => { if (event.target.value !== selected.name) engine.current?.updateObject({ name: event.target.value.trim() || selected.name }); }} />
          <p className="inspector-description">An independent piece of the source scene.</p>
          {(['position', 'rotation', 'scale'] as const).map(field => <div className="transform-fields" key={field}><div className="field-heading">{field}<span>{field === 'rotation' ? 'degrees' : field === 'position' ? 'scene units' : 'factor'}</span></div><div className="number-row">{['X', 'Y', 'Z'].map((axis, index) => <NumberField key={`${selected.id}-${field}-${axis}`} label={`${field} ${axis}`} value={field === 'rotation' ? selected[field][index] * 180 / Math.PI : selected[field][index]} min={field === 'scale' ? 0.01 : undefined} step={field === 'rotation' ? 5 : 0.1} onChange={value => { const values = [...selected[field]]; values[index] = field === 'rotation' ? value * Math.PI / 180 : value; engine.current?.updateObject({ [field]: values }); }} />)}</div></div>)}
          <button className="secondary-button full-width" onClick={() => engine.current?.updateObject({ position: [...selected.origin], rotation: [0, 0, 0], scale: [1, 1, 1] })}><RotateCcw size={14} /> Reset transform</button>
          <button className="delete-button" onClick={() => engine.current?.deleteSelected()}><Trash2 size={15} /> Delete object <kbd>Del</kbd></button>
        </> : <>
          <div className="inspector-intro"><div className="eyebrow">01 / SELECT</div><h2>Make the scene<br />your own.</h2><p>Draw around an object, refine the selection, then make it editable.</p></div>
          <div className="selection-tool-toggle">{([['ai', Sparkles, 'AI mask'], ['box', Box, 'Box']] as const).map(([value, Icon, label]) => <button className={tool === value ? 'active' : ''} key={value} disabled={state?.busy} onClick={() => { setTool(value); if (engine.current) engine.current.tool = value; }}><Icon size={14} />{label}</button>)}</div>
          <div className={`ai-status ${aiReady ? 'ready' : ''}`}><span />{aiReady ? 'AI segmentation ready · runs locally' : 'AI service offline · Box works in browser'}</div>
          <button className="primary-button full-width" disabled={disabled} onClick={() => { engine.current?.select(null); engine.current?.setMode('segment'); }}><Scan size={16} /> {state?.selectionCount ? 'Draw another selection' : 'Start selecting'}</button>
          <div className="section-divider" />
          <div className="eyebrow">02 / REFINE</div>
          <div className="operation-toggle">{(['replace', 'add', 'subtract'] as const).map(op => <button key={op} disabled={state?.busy} className={operation === op ? 'active' : ''} onClick={() => { setOperation(op); if (engine.current) engine.current.operation = op; }}>{op === 'replace' ? 'New' : op === 'add' ? '+ Add' : '− Subtract'}</button>)}</div>
          <p className="refine-help">Use Add from another angle to include hidden surfaces. Subtract removes stray geometry.</p>
          <div className="field-heading">Selection depth<span>from camera</span></div>
          <div className="number-row depth-row"><NumberField label="Near" value={state?.near ?? 0} min={0} onChange={near => engine.current?.setDepth(near, Math.max(near, state?.far ?? 2))} /><NumberField label="Far" value={state?.far ?? 2} min={state?.near ?? 0} onChange={far => engine.current?.setDepth(state?.near ?? 0, far)} /></div>
          <p className="refine-help">Keep the object highlighted. Reduce Far to exclude walls behind it.</p>
          <div className="selection-count"><span className={state?.selectionCount ? 'live-dot' : 'empty-dot'} />{(state?.selectionCount ?? 0).toLocaleString()} {state?.source?.kind === 'mesh' ? 'triangles' : 'splats'} selected</div>
          <div className="section-divider" />
          <div className="eyebrow">03 / EDIT</div><input className="segment-name-input" aria-label="New object name" placeholder="Name your object, e.g. Sofa" value={name} maxLength={120} onChange={event => setName(event.target.value)} />
          <button className="primary-button full-width" disabled={disabled || !state?.selectionCount} onClick={() => { engine.current?.createObject(name); setName(''); }}><Check size={16} /> Create object</button>
          {!!state?.selectionCount && <button className="text-button full-width" disabled={state?.busy} onClick={() => engine.current?.cancelSelection()}>Clear selection</button>}
        </>}
        <div className="inspector-footer"><Layers3 size={14} /><span>Edits use the original scene geometry.<br />Undo brings any deleted object back.</span></div>
      </aside>
    </div>
    <footer className="editor-status"><span>{state?.status || 'Ready'}</span><span>{state?.source?.kind === 'splats' ? 'Gaussian splats' : 'Triangle mesh'}<i />World Labs</span></footer>
    <input ref={fileInput} hidden type="file" accept=".spz,.ply,.splat,.glb,.json" onChange={event => { void importAsset(event.target.files?.[0]); event.target.value = ''; }} />
    <input ref={projectInput} hidden type="file" accept=".json" onChange={async event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) try { engine.current?.loadProject(JSON.parse(await file.text())); } catch (error) { engine.current?.reportError(error); } }} />
    {importOpen && <div className="import-backdrop" onClick={() => setImportOpen(false)}><section className="import-dialog" role="dialog" aria-modal="true" aria-label="Import scene" onClick={event => event.stopPropagation()}><button className="dialog-close" aria-label="Close import" onClick={() => setImportOpen(false)}><X size={18} /></button><div className="eyebrow">YOUR WORLD, YOUR EDITS</div><h2>Import a scene</h2><p>Open a World Labs splat, collider mesh, or world metadata file.</p><button className="upload-zone" onClick={() => fileInput.current?.click()}><Upload size={28} /><strong>Choose a file or drop it here</strong><span>SPZ · Gaussian PLY · SPLAT · GLB · world_meta.json</span></button><label className="url-label">Or paste a World Labs link, world ID, or asset URL<input aria-label="Asset URL" type="url" placeholder="https://marble.worldlabs.ai/world/…" value={url} onChange={event => setUrl(event.target.value)} /></label><div className="import-settings"><label><input type="checkbox" checked={marble} onChange={event => setMarble(event.target.checked)} /> World Labs coordinates</label><NumberField label="Scale" value={scale} min={0.001} onChange={setScale} /></div><p className="import-note">World links and metadata apply metric scale automatically. Asset URLs must allow browser access.</p><button className="primary-button full-width" disabled={!url.trim() || state?.busy} onClick={() => { void importAsset(); }}>Open URL</button></section></div>}
  </main>;
}
