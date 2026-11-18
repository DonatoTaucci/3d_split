import './style.css';
import * as THREE from 'three';
import { Viewer, segmentColor } from './viewer.js';
import { loadModelFile, ACCEPTED, mergeRaw } from './io/loaders.js';
import { toSTL, toOBJ, to3MF, zipFiles, downloadBytes, safeFileName } from './io/exporters.js';
import { weld, MeshData } from './core/meshdata.js';
import { analyzeMesh } from './core/patches.js';
import {
  smartSelect, autoSegment, refineFaceLabels, growSurface, selectComponent, brushFaces,
  growMask, shrinkMask, cleanFaceMask, maskBoundaryEdges,
} from './core/segment.js';
import { repairMesh } from './core/repair.js';
import { segmentRegion } from './core/region.js';
import { fitPlaneToSelection, selectionCentroid } from './core/cutter.js';
import { GeoClient } from './geoClient.js';
import * as AI from './ai/gemini.js';

const $ = (id) => document.getElementById(id);
const PART_COLORS = [0xc9ccd4, 0x8ec5ff, 0xffd27a, 0xa7e3a1, 0xf4a6c8, 0xc3b1f5, 0x9fe3e0, 0xf7b98b];
let partColorIdx = 0;
let nextPartId = 1;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  parts: [],
  active: null,
  mode: 'smart',
  method: 'membrane',
  undo: [],
  redo: [],
  smart: null, // {part, res, order, pos, modifier, base}
  fileName: 'modello',
  zUp: true,
  settings: AI.loadSettings(),
  hover: null,
  brushing: false,
  plane: null, // {object, baseOrigin, normal}
  previewTimer: 0,
  previewSeq: 0,
  focus: 0,
  selName: null,
  wire: false,
};

class Part {
  constructor(name, pos, tri, opts = {}) {
    this.id = nextPartId++;
    this.name = name;
    this.mesh = opts.mesh || new MeshData(pos, tri, opts.faceGroup || null);
    this.groupKind = opts.groupKind || null;
    this.color = opts.color ?? PART_COLORS[partColorIdx++ % PART_COLORS.length];
    this.sel = new Uint8Array(this.mesh.nf);
    this.visible = true;
    this.analysis = null;
    this.segFace = null;
    this.segNames = null;
    this.segCount = 0;
    this.explodeDir = new THREE.Vector3();
    this.object = null;
  }
}

const viewer = new Viewer($('viewport'));
window.__app = { state, viewer }; // handy for debugging / tests

// ---------------------------------------------------------------------------
// Utilities: busy overlay, toasts, status
// ---------------------------------------------------------------------------
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

async function busy(msg, fn) {
  $('busy-text').textContent = msg;
  $('busy').hidden = false;
  document.body.style.cursor = 'progress';
  await nextFrame();
  try {
    return await fn();
  } finally {
    $('busy').hidden = true;
    document.body.style.cursor = '';
  }
}

function toast(msg, kind = 'info', ms = 4200) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

function status(msg) { $('status').textContent = msg; }

const fmt = (x, d = 1) => (Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(d));

const geo = new GeoClient();
geo.call('init').catch((e) => console.warn('worker init', e));
const disposePartManifold = (p) => geo.dropPart(p);

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------
$('file-input').accept = ACCEPTED;
$('btn-open').onclick = () => $('file-input').click();
$('btn-open2').onclick = () => $('file-input').click();
$('file-input').onchange = (e) => { const f = e.target.files[0]; if (f) openFile(f); e.target.value = ''; };
const vp = $('viewport');
vp.addEventListener('dragover', (e) => { e.preventDefault(); vp.classList.add('drag-over'); });
vp.addEventListener('dragleave', () => vp.classList.remove('drag-over'));
vp.addEventListener('drop', (e) => {
  e.preventDefault();
  vp.classList.remove('drag-over');
  const f = e.dataTransfer.files[0];
  if (f) openFile(f);
});
$('btn-demo').onclick = () => loadDemo();

async function openFile(file) {
  try {
    await busy(`Apertura di ${file.name}…`, async () => {
      const res = await loadModelFile(file, (m) => { $('busy-text').textContent = m; });
      const scale = parseFloat(state.settings.units || '1') || 1;
      const raws = res.meshes;
      const parts = [];
      for (const r of raws) {
        if (scale !== 1) for (let i = 0; i < r.positions.length; i++) r.positions[i] *= scale;
        $('busy-text').textContent = `Analisi topologia (${r.name})…`;
        await nextFrame();
        const w = weld(r.positions, r.indices, r.groups);
        if (!w.tri.length) continue;
        const color = r.color ? new THREE.Color(r.color[0], r.color[1], r.color[2]).getHex() : undefined;
        const kind = ['step', 'stp', 'iges', 'igs', 'brep', 'brp'].includes(res.format) ? 'brep' : r.groups ? 'material' : null;
        const baseName = file.name.replace(/\.[^.]+$/, '').replace(/^[0-9a-f]{8}-/, '');
        const genericName = !r.name || /^(Oggetto|Corpo) \d+$/.test(r.name);
        parts.push(new Part(raws.length === 1 && genericName ? baseName : r.name || baseName, w.pos, w.tri, { faceGroup: w.faceGroup, groupKind: kind, color: raws.length === 1 && color === 0xffffff ? undefined : color }));
      }
      if (!parts.length) throw new Error('Nessun triangolo valido nel file.');
      setModel(parts, file.name.replace(/\.[^.]+$/, ''), res.zUp);
    });
    status(`Caricato ${file.name}`);
    const h = modelHeight();
    if (h > 0 && h < 10) toast(`Il modello è alto solo ${fmt(h, 2)} mm: probabilmente è in un'altra unità. Imposta l'altezza reale nel pannello Modello.`, 'error', 9000);
    if (state.parts.some((p) => !p.mesh.isClosed())) toast('La mesh non è chiusa: per i connettori e il taglio a piano usa prima «Ripara mesh».', 'info', 7000);
  } catch (err) {
    console.error(err);
    toast(err.message || String(err), 'error', 7000);
  }
}

async function loadDemo() {
  try {
    await busy('Creazione modello di esempio…', async () => {
      const d = await geo.call('demo');
      const w = weld(d.pos, d.tri);
      setModel([new Part('Busto di esempio', w.pos, w.tri)], 'busto-esempio', true);
    });
    toast('Clicca sui capelli: verranno riconosciuti e selezionati. Poi premi "Separa parte".', 'ok', 7000);
  } catch (err) {
    console.error(err);
    toast(err.message, 'error');
  }
}

function setModel(parts, name, zUp) {
  for (const p of state.parts) { viewer.disposePart(p); disposePartManifold(p); }
  state.parts = [];
  state.undo = [];
  state.redo = [];
  state.fileName = name;
  state.zUp = zUp;
  partColorIdx = 0;
  parts.forEach((p, i) => { if (parts.length === 1 || p.color === undefined) p.color = PART_COLORS[i % PART_COLORS.length]; });
  applyUpAxis();
  for (const p of parts) addPart(p);
  state.active = parts[0];
  $('drop-hint').hidden = true;
  $('view-toolbar').hidden = false;
  $('mode-toolbar').hidden = false;
  viewer.frameObjects(parts.map((p) => p.object), false);
  removePlane();
  refreshAll();
}

function addPart(p, index = state.parts.length) {
  state.parts.splice(index, 0, p);
  viewer.buildPartObject(p);
  p.object.material.wireframe = false;
  refreshSegDisplay(p);
  refreshSelectionDisplay(p);
}

function applyUpAxis() {
  viewer.modelRoot.rotation.set(state.zUp ? -Math.PI / 2 : 0, 0, 0);
  viewer.modelRoot.updateMatrixWorld(true);
  $('btn-upaxis').textContent = `Asse su: ${state.zUp ? 'Z' : 'Y'}`;
}

$('btn-upaxis').onclick = () => {
  state.zUp = !state.zUp;
  applyUpAxis();
  viewer.frameObjects(state.parts.map((p) => p.object), false);
};

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------
async function ensureAnalysis(part) {
  if (part.analysis) return part.analysis;
  return busy('Analisi della forma…', async () => {
    const t = performance.now();
    part.analysis = analyzeMesh(part.mesh);
    status(`Analisi completata in ${((performance.now() - t) / 1000).toFixed(1)} s · ${part.analysis.graph.n} zone`);
    return part.analysis;
  });
}

/**
 * Snap an AI-provided patch region onto the geometric part that best matches it
 * (AI decides *what*, the crease/neck analysis decides *where* the border is).
 */
function snapToGeometry(an, pm) {
  const g = an.graph;
  let area = 0, cx = 0, cy = 0, cz = 0;
  for (let p = 0; p < g.n; p++) if (pm[p]) { area += g.area[p]; cx += g.centroid[3 * p] * g.area[p]; cy += g.centroid[3 * p + 1] * g.area[p]; cz += g.centroid[3 * p + 2] * g.area[p]; }
  if (!area) return { mask: pm, iou: 0 };
  cx /= area; cy /= area; cz /= area;
  // seeds: interior patches of the region, closest to its centroid first
  const interior = [];
  for (let p = 0; p < g.n; p++) {
    if (!pm[p]) continue;
    let inside = true;
    for (let k = g.start[p]; k < g.start[p + 1]; k++) if (!pm[g.nbr[k]]) { inside = false; break; }
    const d = (g.centroid[3 * p] - cx) ** 2 + (g.centroid[3 * p + 1] - cy) ** 2 + (g.centroid[3 * p + 2] - cz) ** 2;
    interior.push([p, d + (inside ? 0 : 1e12)]);
  }
  interior.sort((a, b) => a[1] - b[1]);
  const seeds = [interior[0][0], interior[Math.floor(interior.length / 3)][0], interior[Math.floor((2 * interior.length) / 3)][0]];
  let best = { mask: pm, iou: 0 };
  const tried = new Set();
  for (const seed of seeds) {
    if (tried.has(seed)) continue;
    tried.add(seed);
    const res = smartSelect(g, seed);
    for (const c of res.candidates) {
      if (c.whole) continue;
      let inter = 0, uni = 0;
      for (let p = 0; p < g.n; p++) {
        const a = pm[p], b = c.mask[p];
        if (a || b) { uni += g.area[p]; if (a && b) inter += g.area[p]; }
      }
      const iou = uni ? inter / uni : 0;
      if (iou > best.iou) best = { mask: c.mask, iou };
    }
  }
  return best.iou >= 0.7 ? best : { mask: pm, iou: best.iou };
}

function patchMaskToFaces(part, patchMask) {
  const { aff, graph } = part.analysis;
  const lab = new Int32Array(graph.n);
  for (let p = 0; p < graph.n; p++) lab[p] = patchMask[p] ? 1 : 0;
  const fl = refineFaceLabels(part.mesh, aff, graph, lab);
  const mask = new Uint8Array(part.mesh.nf);
  for (let f = 0; f < fl.length; f++) mask[f] = fl[f] === 1 ? 1 : 0;
  cleanFaceMask(part.mesh, mask);
  return mask;
}

// ---------------------------------------------------------------------------
// Selection & history
// ---------------------------------------------------------------------------
function pushUndo(entry) {
  state.undo.push(entry);
  if (state.undo.length > 40) state.undo.shift();
  state.redo = [];
  updateUndoButtons();
}

function setSelection(part, mask, record = true, name = null) {
  if (record) pushUndo({ type: 'sel', part, before: part.sel.slice(), after: mask.slice(), nameBefore: state.selName, nameAfter: name });
  part.sel = mask;
  state.selName = name;
  refreshSelectionDisplay(part);
  if (state.method === 'plane' && mask.some((v) => v)) fitPlane();
  updateSelInfo();
  if (part.segFace) renderSegList();
  schedulePreview();
}

function combine(base, mask, modifier) {
  if (modifier === 'add') { const o = base.slice(); for (let i = 0; i < o.length; i++) o[i] |= mask[i]; return o; }
  if (modifier === 'sub') { const o = base.slice(); for (let i = 0; i < o.length; i++) if (mask[i]) o[i] = 0; return o; }
  return mask;
}

function updateUndoButtons() {
  $('btn-undo').disabled = !state.undo.length;
  $('btn-redo').disabled = !state.redo.length;
}

function undo() {
  const e = state.undo.pop();
  if (!e) return;
  state.redo.push(e);
  applyHistory(e, true);
  updateUndoButtons();
}

function redo() {
  const e = state.redo.pop();
  if (!e) return;
  state.undo.push(e);
  applyHistory(e, false);
  updateUndoButtons();
}

function applyHistory(e, isUndo) {
  if (e.type === 'sel') {
    e.part.sel = (isUndo ? e.before : e.after).slice();
    state.selName = isUndo ? e.nameBefore : e.nameAfter;
    if (state.parts.includes(e.part)) { refreshSelectionDisplay(e.part); state.active = e.part; }
    state.smart = null;
    updateSmartNav();
  } else if (e.type === 'parts') {
    const from = isUndo ? e.after : e.before;
    const to = isUndo ? e.before : e.after;
    for (const p of from) if (!to.includes(p)) { viewer.disposePart(p); disposePartManifold(p); }
    state.parts = [];
    for (const p of to) { if (!p.object) addPart(p); else state.parts.push(p); }
    state.active = isUndo ? e.activeBefore : e.activeAfter;
    applyExplode();
  } else if (e.type === 'seg') {
    restoreSeg(e.part, isUndo ? e.before : e.after);
    if (state.parts.includes(e.part)) refreshSegDisplay(e.part);
  }
  refreshAll();
}

function refreshSelectionDisplay(part) {
  if (!part.object) return;
  const hover = state.hover && state.hover.part === part ? state.hover.mask : null;
  viewer.setSelectionFlags(part, part.sel, hover);
  drawSelectionOutline(part);
}

function drawSelectionOutline(part) {
  if (part._outline) { part.object.remove(part._outline); part._outline.geometry.dispose(); part._outline.material.dispose(); part._outline = null; }
  let any = false;
  for (let i = 0; i < part.sel.length; i++) if (part.sel[i]) { any = true; break; }
  if (!any) return;
  const ev = maskBoundaryEdges(part.mesh, part.sel);
  if (!ev.length) return;
  const pos = new Float32Array(ev.length * 3);
  for (let i = 0; i < ev.length; i++) for (let k = 0; k < 3; k++) pos[3 * i + k] = part.mesh.pos[3 * ev[i] + k];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const line = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xffe0b0, depthTest: true }));
  line.renderOrder = 2;
  part._outline = line;
  part.object.add(line);
}

function refreshSegDisplay(part) {
  if (!part.object) return;
  if (part.segFace) {
    viewer.ensurePalette(part.segCount + 1);
    viewer.setFaceAttribute(part, 'aSeg', part.segFace, (v) => (v >= 0 ? v + 1 : 0));
  } else {
    viewer.setFaceAttribute(part, 'aSeg', new Int32Array(part.mesh.nf), () => 0);
  }
}

function selectedStats(part) {
  let n = 0, area = 0;
  for (let f = 0; f < part.mesh.nf; f++) if (part.sel[f]) { n++; area += part.mesh.faceArea[f]; }
  return { n, area };
}

function updateSelInfo() {
  applyFocus();
  const p = state.active;
  if (!p) { $('sel-info').textContent = 'Nessuna selezione'; $('btn-split').disabled = true; return; }
  const { n, area } = selectedStats(p);
  const frac = p.mesh.totalArea ? (100 * area) / p.mesh.totalArea : 0;
  $('sel-info').textContent = n
    ? `${state.selName ? `«${state.selName}» · ` : ''}${n.toLocaleString('it-IT')} triangoli · ${frac.toFixed(1)}% della superficie`
    : 'Nessuna selezione';
  $('btn-split').disabled = state.method === 'membrane' ? n === 0 : !state.plane;
  $('btn-plane-fit').textContent = n ? 'Adatta alla selezione' : 'Piano orizzontale';
}

// ---------------------------------------------------------------------------
// Picking & interaction
// ---------------------------------------------------------------------------
const canvas = viewer.renderer.domElement;
let downPos = null;
let downButton = -1;

function modifierOf(e) {
  if (e.altKey || e.ctrlKey || e.metaKey) return 'sub';
  if (e.shiftKey) return 'add';
  return state.selOp || 'replace';
}

document.querySelectorAll('[data-selop]').forEach((b) => (b.onclick = () => {
  state.selOp = b.dataset.selop;
  document.querySelectorAll('[data-selop]').forEach((x) => x.classList.toggle('active', x === b));
}));

canvas.addEventListener('pointerdown', (e) => {
  downPos = [e.clientX, e.clientY];
  downButton = e.button;
  if (state.mode === 'brush' && e.button === 0 && state.parts.length) {
    const hit = viewer.pick(e.clientX, e.clientY, state.parts);
    if (hit) {
      state.brushing = { part: hit.part, before: hit.part.sel.slice(), sub: modifierOf(e) === 'sub' };
      state.active = hit.part;
      paintAt(hit);
      canvas.setPointerCapture(e.pointerId);
    }
  }
});

canvas.addEventListener('pointermove', (e) => {
  if (state.brushing) {
    const hit = viewer.pick(e.clientX, e.clientY, [state.brushing.part]);
    if (hit) paintAt(hit);
    return;
  }
  scheduleHover(e);
});

canvas.addEventListener('pointerup', (e) => {
  if (state.brushing) {
    const b = state.brushing;
    state.brushing = false;
    pushUndo({ type: 'sel', part: b.part, before: b.before, after: b.part.sel.slice(), nameBefore: state.selName, nameAfter: null });
    state.selName = null;
    if (state.method === 'plane') fitPlane();
    updateSelInfo();
    schedulePreview();
    renderPartsList();
    return;
  }
  if (!downPos || downButton !== 0) return;
  const moved = Math.hypot(e.clientX - downPos[0], e.clientY - downPos[1]);
  downPos = null;
  if (moved > 5) return;
  onClick(e);
});

canvas.addEventListener('pointerleave', () => { setHover(null); $('cursor-hint').hidden = true; });

async function onClick(e) {
  if (!state.parts.length) return;
  if (viewer.transform.dragging) return;
  const hit = viewer.pick(e.clientX, e.clientY, state.parts);
  const mod = modifierOf(e);
  if (!hit) {
    if (mod === 'replace' && state.active && state.mode !== 'brush') {
      // click on empty space: keep selection (Esc clears)
    }
    return;
  }
  const part = hit.part;
  if (state.active !== part) {
    if (state.active) { const prev = state.active; state.active = part; refreshSelectionDisplay(prev); }
    state.active = part;
    renderPartsList();
  }
  const mesh = part.mesh;
  switch (state.mode) {
    case 'smart': {
      const an = await ensureAnalysis(part);
      const patch = an.graph.patchOf[hit.face];
      const res = smartSelect(an.graph, patch);
      // order candidates by area for "smaller/larger" navigation
      const order = res.candidates.map((c, i) => i).sort((a, b) => res.candidates[a].area - res.candidates[b].area);
      state.smart = { part, res, order, pos: order.indexOf(res.best), modifier: mod, base: part.sel.slice() };
      applySmartCandidate(true);
      break;
    }
    case 'segment': {
      if (!part.segFace) { await runAutoSegment(part); }
      const lab = part.segFace[hit.face];
      if (lab < 0) return;
      toggleSegment(part, lab, mod);
      break;
    }
    case 'surface': {
      const ang = (parseFloat($('surface-angle').value) * Math.PI) / 180;
      const m = growSurface(mesh, hit.face, ang, part.groupKind === 'brep');
      setSelection(part, combine(part.sel, m, mod));
      break;
    }
    case 'component': {
      setSelection(part, combine(part.sel, selectComponent(mesh, hit.face), mod));
      break;
    }
    default:
      break;
  }
  renderPartsList();
}

function applySmartCandidate(first = false) {
  const s = state.smart;
  if (!s) return;
  const cand = s.res.candidates[s.order[s.pos]];
  const faces = patchMaskToFaces(s.part, cand.mask);
  const out = combine(s.base, faces, s.modifier);
  if (first) setSelection(s.part, out, true, null);
  else {
    // replace the last history entry when cycling between candidates
    const last = state.undo[state.undo.length - 1];
    if (last && last.type === 'sel' && last.part === s.part) last.after = out.slice();
    s.part.sel = out;
    refreshSelectionDisplay(s.part);
    updateSelInfo();
    schedulePreview();
  }
  updateSmartNav();
}

function updateSmartNav() {
  const s = state.smart;
  $('smart-nav').hidden = !s || state.mode !== 'smart';
  if (!s) return;
  $('cand-label').textContent = `${s.pos + 1} di ${s.order.length}`;
  $('btn-cand-prev').disabled = s.pos <= 0;
  $('btn-cand-next').disabled = s.pos >= s.order.length - 1;
  const box = $('cand-chips');
  box.innerHTML = '';
  const total = s.part.mesh.totalArea || 1;
  const bestPos = s.order.indexOf(s.res.best);
  s.order.forEach((ci, k) => {
    const c = s.res.candidates[ci];
    const b = document.createElement('button');
    const pct = (100 * c.area) / total;
    b.textContent = `${k === bestPos ? '★ ' : ''}${c.whole ? 'Tutto il corpo' : `${pct < 1 ? pct.toFixed(1) : pct.toFixed(0)}%`}`;
    b.title = `${c.whole ? 'Intero corpo collegato' : `${pct.toFixed(1)}% della superficie`} · nettezza del taglio ${(1 / (0.1 + c.score)).toFixed(1)}`;
    b.classList.toggle('active', k === s.pos);
    b.onclick = () => { s.pos = k; setHover(null); applySmartCandidate(); };
    b.onmouseenter = () => {
      const g = s.part.analysis.graph;
      setHover({ part: s.part, key: `cand:${ci}`, mask: g.toFaceMask(c.mask, s.part.mesh.nf) });
    };
    b.onmouseleave = () => setHover(null);
    box.appendChild(b);
  });
}

$('btn-cand-prev').onclick = () => { if (state.smart && state.smart.pos > 0) { state.smart.pos--; applySmartCandidate(); } };
$('btn-cand-next').onclick = () => { if (state.smart && state.smart.pos < state.smart.order.length - 1) { state.smart.pos++; applySmartCandidate(); } };

// brush
function brushRadius(part) {
  const v = parseFloat($('brush-radius').value);
  return (part.mesh.bounds.diag * v) / 400;
}

function paintAt(hit) {
  const b = state.brushing;
  const part = b.part;
  const faces = brushFaces(part.mesh, hit.face, [hit.point.x, hit.point.y, hit.point.z], brushRadius(part));
  for (const f of faces) part.sel[f] = b.sub ? 0 : 1;
  refreshSelectionDisplay(part);
}

// hover preview
let hoverRAF = 0;
let lastHoverEvt = null;
function scheduleHover(e) {
  lastHoverEvt = e;
  if (hoverRAF) return;
  hoverRAF = requestAnimationFrame(() => {
    hoverRAF = 0;
    doHover(lastHoverEvt);
  });
}

function doHover(e) {
  if (!state.parts.length || e.buttons) return;
  const hit = viewer.pick(e.clientX, e.clientY, state.parts);
  const hint = $('cursor-hint');
  if (!hit) { setHover(null); hint.hidden = true; updateBrushCursor(null); return; }
  const part = hit.part;
  const rect = vp.getBoundingClientRect();
  hint.style.left = `${e.clientX - rect.left}px`;
  hint.style.top = `${e.clientY - rect.top}px`;
  let text = '';
  if (state.mode === 'segment' && part.segFace) {
    const lab = part.segFace[hit.face];
    const key = `seg:${part.id}:${lab}`;
    if (!state.hover || state.hover.key !== key) {
      const m = new Uint8Array(part.mesh.nf);
      if (lab >= 0) for (let f = 0; f < m.length; f++) if (part.segFace[f] === lab) m[f] = 1;
      setHover({ part, key, mask: m });
    }
    text = lab >= 0 ? part.segNames?.[lab] || `Segmento ${lab + 1}` : '';
  } else if (state.mode === 'component') {
    const c = part.mesh.faceComp[hit.face];
    const key = `comp:${part.id}:${c}`;
    if (!state.hover || state.hover.key !== key) setHover({ part, key, mask: selectComponent(part.mesh, hit.face) });
    text = `Corpo ${c + 1}`;
  } else if (state.mode === 'surface') {
    const key = `surf:${part.id}:${hit.face}:${$('surface-angle').value}`;
    if (!state.hover || state.hover.key !== key) {
      const ang = (parseFloat($('surface-angle').value) * Math.PI) / 180;
      setHover({ part, key, mask: growSurface(part.mesh, hit.face, ang, part.groupKind === 'brep') });
    }
  } else {
    setHover(null);
  }
  if (state.mode === 'brush') updateBrushCursor(hit); else updateBrushCursor(null);
  hint.textContent = text;
  hint.hidden = !text;
}

function setHover(h) {
  const prev = state.hover;
  state.hover = h;
  if (prev && prev.part !== h?.part && prev.part.object) refreshSelectionFlagsOnly(prev.part);
  if (h) refreshSelectionFlagsOnly(h.part);
}

function refreshSelectionFlagsOnly(part) {
  const hover = state.hover && state.hover.part === part ? state.hover.mask : null;
  viewer.setSelectionFlags(part, part.sel, hover);
}

let brushCursor = null;
function updateBrushCursor(hit) {
  if (!hit) { if (brushCursor) brushCursor.visible = false; viewer.requestRender(); return; }
  const part = hit.part;
  const r = brushRadius(part);
  if (!brushCursor) {
    brushCursor = new THREE.Mesh(new THREE.RingGeometry(0.92, 1, 48), new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, depthTest: false, transparent: true, opacity: 0.85 }));
    brushCursor.renderOrder = 10;
  }
  if (brushCursor.parent !== part.object) part.object.add(brushCursor);
  const f = hit.face;
  const n = new THREE.Vector3(part.mesh.faceNormal[3 * f], part.mesh.faceNormal[3 * f + 1], part.mesh.faceNormal[3 * f + 2]);
  brushCursor.position.copy(hit.point).addScaledVector(n, r * 0.02);
  brushCursor.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
  brushCursor.scale.setScalar(r);
  brushCursor.visible = true;
  viewer.requestRender();
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------
const MODE_HELP = {
  smart: 'Clicca su una parte: viene riconosciuta e selezionata. Se non è quella giusta scegline un\'altra tra le «Possibili parti». Shift+clic aggiunge, Alt+clic toglie.',
  segment: 'Clicca i segmenti colorati da staccare insieme: un clic aggiunge, un altro clic toglie. Se un segmento è troppo grande usa ✂ nell\'elenco a sinistra.',
  surface: 'Seleziona una superficie liscia fino agli spigoli più netti dell\'angolo scelto.',
  brush: 'Dipingi con il tasto sinistro per aggiungere alla selezione (con «Togli» o Alt per cancellare). Ruota la vista con il tasto destro.',
  component: 'Seleziona un intero corpo separato (non collegato al resto).',
};

function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll('#mode-toolbar button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  $('mode-help').textContent = MODE_HELP[mode];
  $('row-brush').hidden = mode !== 'brush';
  $('row-angle').hidden = mode !== 'surface';
  viewer.controls.mouseButtons.LEFT = mode === 'brush' ? null : THREE.MOUSE.ROTATE;
  viewer.controls.mouseButtons.RIGHT = mode === 'brush' ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN;
  setHover(null);
  updateBrushCursor(null);
  updateSmartNav();
}

document.querySelectorAll('#mode-toolbar button').forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
$('surface-angle').oninput = () => { $('surface-angle-val').textContent = `${$('surface-angle').value}°`; };
$('brush-radius').oninput = () => {
  if (state.active) $('brush-radius-val').textContent = `${fmt(brushRadius(state.active))} mm`;
};

$('btn-grow').onclick = () => { const p = state.active; if (p) setSelection(p, growMask(p.mesh, p.sel.slice(), Math.max(1, Math.round(p.mesh.nf / 200000)))); };
$('btn-shrink').onclick = () => { const p = state.active; if (p) setSelection(p, shrinkMask(p.mesh, p.sel.slice(), Math.max(1, Math.round(p.mesh.nf / 200000)))); };
$('btn-invert').onclick = () => { const p = state.active; if (p) setSelection(p, p.sel.map((v) => (v ? 0 : 1))); };
$('btn-clear').onclick = () => { const p = state.active; if (p) { state.smart = null; updateSmartNav(); setSelection(p, new Uint8Array(p.mesh.nf)); } };

// ---------------------------------------------------------------------------
// Auto segmentation & AI
// ---------------------------------------------------------------------------
async function runAutoSegment(part) {
  const an = await ensureAnalysis(part);
  await busy('Riconoscimento delle parti…', async () => {
    const t = parseFloat($('seg-detail').value) / 100;
    const res = autoSegment(an.graph, { threshold: 0.35 + 1.25 * t, minFraction: 0.03 * (1 - t) + 0.003 });
    part.segFace = refineFaceLabels(part.mesh, an.aff, an.graph, res.labels);
    part.segCount = res.count;
    part.segNames = null;
    refreshSegDisplay(part);
    renderSegList();
    status(`${res.count} parti riconosciute`);
  });
}

$('btn-autoseg').onclick = async () => {
  if (!state.active) return;
  await runAutoSegment(state.active);
  setMode('segment');
};
$('seg-detail').onchange = () => { if (state.active?.segFace && !state.active.segNames) runAutoSegment(state.active); };
$('chk-showseg').onchange = () => { viewer.uniforms.uShowSeg.value = $('chk-showseg').checked ? 1 : 0; viewer.requestRender(); };

function segmentMask(part, lab) {
  const m = new Uint8Array(part.mesh.nf);
  for (let f = 0; f < m.length; f++) if (part.segFace[f] === lab) m[f] = 1;
  return m;
}

/** fraction of each segment currently selected */
function segmentCoverage(part) {
  const tot = new Float64Array(part.segCount), sel = new Float64Array(part.segCount);
  for (let f = 0; f < part.mesh.nf; f++) {
    const l = part.segFace[f];
    if (l < 0) continue;
    const a = part.mesh.faceArea[f];
    tot[l] += a;
    if (part.sel[f]) sel[l] += a;
  }
  return { tot, cov: Array.from(tot, (t, l) => (t > 0 ? sel[l] / t : 0)) };
}

/** click on a segment: adds it, or removes it when it is already selected (Shift = add, Alt = remove) */
function toggleSegment(part, lab, mod) {
  const m = segmentMask(part, lab);
  let op = mod;
  if (op === 'replace') {
    let tot = 0, on = 0;
    for (let f = 0; f < m.length; f++) if (m[f]) { tot++; if (part.sel[f]) on++; }
    op = on > tot * 0.95 ? 'sub' : 'add';
  }
  const out = combine(part.sel, m, op);
  // keep the name only when the selection is exactly this one segment
  let only = true;
  for (let f = 0; f < out.length && only; f++) if (out[f] !== m[f]) only = false;
  setSelection(part, out, true, only ? part.segNames?.[lab] || null : null);
}

function segLabelName(part, l) {
  return part.segNames?.[l] || `Segmento ${l + 1}`;
}

function renderSegList() {
  const ul = $('seg-list');
  ul.innerHTML = '';
  const part = state.active;
  $('seg-tools').hidden = !part || !part.segFace;
  if (!part || !part.segFace) return;
  const { tot, cov } = segmentCoverage(part);
  const order = Array.from({ length: part.segCount }, (_, l) => l).sort((a, b) => tot[b] - tot[a]);
  let checked = 0;
  for (const l of order) {
    if (!tot[l] || tot[l] < part.mesh.totalArea * 2e-4) continue;
    const li = document.createElement('li');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = cov[l] > 0.95;
    cb.indeterminate = cov[l] > 0.02 && cov[l] <= 0.95;
    if (cb.checked) checked++;
    cb.title = 'Aggiungi / togli dalla selezione';
    cb.onclick = (e) => { e.stopPropagation(); toggleSegment(part, l, cov[l] > 0.95 ? 'sub' : 'add'); };
    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = `#${segmentColor(l).getHexString()}`;
    const nm = document.createElement('span');
    nm.className = 'name';
    nm.textContent = segLabelName(part, l);
    const meta = document.createElement('span');
    meta.className = 'meta';
    const pct = (100 * tot[l]) / part.mesh.totalArea;
    meta.textContent = `${pct < 0.1 ? '<0.1' : pct.toFixed(1)}%`;
    const cut = document.createElement('button');
    cut.className = 'icon-btn';
    cut.textContent = '✂';
    cut.title = 'Ridividi questo segmento in parti più piccole';
    cut.onclick = (e) => { e.stopPropagation(); resegment(part, segmentMask(part, l), segLabelName(part, l)); };
    li.append(cb, sw, nm, meta, cut);
    li.classList.toggle('sel', cov[l] > 0.95);
    li.title = 'Clic: seleziona solo questo · casella: aggiungi/togli';
    li.onclick = (e) => {
      if (e.shiftKey) { toggleSegment(part, l, 'add'); return; }
      setSelection(part, segmentMask(part, l), true, part.segNames?.[l] || null);
    };
    li.onmouseenter = () => setHover({ part, key: `segl:${l}`, mask: segmentMask(part, l) });
    li.onmouseleave = () => setHover(null);
    ul.appendChild(li);
  }
  $('btn-seg-merge').disabled = checked < 2;
}

function snapshotSeg(part) {
  return { segFace: part.segFace ? part.segFace.slice() : null, segCount: part.segCount, segNames: part.segNames ? part.segNames.slice() : null };
}

function restoreSeg(part, snap) {
  part.segFace = snap.segFace ? snap.segFace.slice() : null;
  part.segCount = snap.segCount;
  part.segNames = snap.segNames ? snap.segNames.slice() : null;
}

/** renumber labels 0..n-1 (dropping empty ones), keeping names */
function compactSegments(part) {
  const map = new Map();
  const names = [];
  for (let f = 0; f < part.segFace.length; f++) {
    const l = part.segFace[f];
    if (l < 0) continue;
    let k = map.get(l);
    if (k === undefined) { k = map.size; map.set(l, k); names.push(part.segNames?.[l] ?? null); }
    part.segFace[f] = k;
  }
  part.segCount = map.size;
  part.segNames = names.some((n) => n) ? names : null;
}

/** re-run part detection only inside `mask`, leaving the other segments untouched */
async function resegment(part, mask, baseName = null) {
  if (!mask.some((v) => v)) { toast('Seleziona prima la zona da ridividere.', 'error'); return; }
  await busy('Nuovo riconoscimento solo nella zona…', async () => {
    const before = snapshotSeg(part);
    const t = parseFloat($('seg-detail').value) / 100;
    const r = segmentRegion(part.mesh, mask, { threshold: 0.6 + 1.3 * t, minFraction: 0.08 * (1 - t) + 0.01 });
    if (!part.segFace) { part.segFace = new Int32Array(part.mesh.nf).fill(-1); part.segCount = 0; part.segNames = null; }
    if (part.segCount + r.count > 60000) compactSegments(part);
    const base = part.segCount;
    for (let i = 0; i < r.faces.length; i++) part.segFace[r.faces[i]] = base + r.labels[i];
    if (part.segNames || baseName) {
      const names = part.segNames ? part.segNames.slice() : [];
      for (let k = names.length; k < base; k++) names[k] = null;
      for (let k = 0; k < r.count; k++) names[base + k] = baseName && !/^Segmento \d+$/.test(baseName) ? `${baseName} ${k + 1}` : null;
      part.segNames = names;
    }
    part.segCount = base + r.count; // existing segments keep their number and colour
    pushUndo({ type: 'seg', part, before, after: snapshotSeg(part) });
    refreshSegDisplay(part);
    renderSegList();
    setMode('segment');
    status(`Zona ridivisa: ${r.count} nuove parti`);
    toast(r.count > 1 ? `Zona divisa in ${r.count} parti: clicca quelle da staccare.` : 'In questa zona non ho trovato altre divisioni: prova ad alzare il Dettaglio o usa il pennello.', r.count > 1 ? 'ok' : 'error', 6000);
  });
}

$('btn-resegment').onclick = () => { const p = state.active; if (p) resegment(p, p.sel.slice(), state.selName); };

$('btn-seg-merge').onclick = () => {
  const part = state.active;
  if (!part || !part.segFace) return;
  const { cov } = segmentCoverage(part);
  const labs = cov.map((c, l) => (c > 0.95 ? l : -1)).filter((l) => l >= 0);
  if (labs.length < 2) return;
  const before = snapshotSeg(part);
  const target = labs[0];
  const set = new Set(labs);
  for (let f = 0; f < part.segFace.length; f++) if (set.has(part.segFace[f])) part.segFace[f] = target;
  pushUndo({ type: 'seg', part, before, after: snapshotSeg(part) });
  refreshSegDisplay(part);
  renderSegList();
  toast(`${labs.length} segmenti uniti in uno.`, 'ok');
};

// focus view: show everything, dim what is not selected, or only the selection
document.querySelectorAll('[data-focus]').forEach((b) => (b.onclick = () => {
  state.focus = parseInt(b.dataset.focus, 10);
  document.querySelectorAll('[data-focus]').forEach((x) => x.classList.toggle('active', x === b));
  applyFocus();
}));

function applyFocus() {
  const has = state.active?.sel.some((v) => v);
  viewer.uniforms.uFocus.value = has ? state.focus || 0 : 0;
  viewer.requestRender();
}

function requireKey() {
  if (!state.settings.key) {
    toast('Inserisci la chiave API Gemini nelle Impostazioni per usare l\'AI.', 'error', 6000);
    openSettings();
    return false;
  }
  return true;
}

async function aiAnalyze() {
  const part = state.active;
  if (!part || !requireKey()) return;
  const an = await ensureAnalysis(part);
  const { key, model } = state.settings;
  try {
    await busy('Rendering delle viste…', async () => {
      const views = AI.renderViews(viewer, part);
      $('busy-text').textContent = 'Gemini sta riconoscendo le parti…';
      const disc = await AI.discoverParts({ key, model, views });
      if (!disc.parts.length) throw new Error('Gemini non ha riconosciuto parti.');
      $('ai-status').textContent = disc.object ? `Oggetto: ${disc.object}` : '';
      const labelsEn = disc.parts.map((p) => p.en);
      const votes = labelsEn.map(() => new Float32Array(an.graph.n));
      const visible = new Float32Array(an.graph.n);
      let done = 0;
      $('busy-text').textContent = `Segmentazione con Gemini (0/${views.length} viste)…`;
      await runLimited(views, 3, async (v) => {
        try {
          const items = await AI.segmentView({ key, model, view: v, labels: labelsEn });
          await AI.accumulateVotes(v, items, labelsEn, an.graph.patchOf, votes, visible);
        } catch (err) {
          console.warn('view failed', v.name, err);
        }
        done++;
        $('busy-text').textContent = `Segmentazione con Gemini (${done}/${views.length} viste)…`;
      });
      const lab = AI.propagateLabels(an.graph, votes, visible);
      // labels -> contiguous segments with names
      const used = [...new Set(Array.from(lab).filter((l) => l >= 0))];
      if (!used.length) throw new Error('Le maschere restituite non coprono il modello. Riprova o usa "Riconosci parti".');
      const remap = new Map(used.map((l, i) => [l, i]));
      const patchLab = new Int32Array(an.graph.n);
      for (let p = 0; p < an.graph.n; p++) patchLab[p] = lab[p] >= 0 ? remap.get(lab[p]) : used.length;
      // snap each AI region to the matching geometric part, smallest parts first
      const order = used.map((l, i) => i).sort((a, b) => regionArea(an.graph, patchLab, a) - regionArea(an.graph, patchLab, b));
      const claimed = new Uint8Array(an.graph.n);
      const snappedLab = patchLab.slice();
      for (const i of order) {
        const pm = new Uint8Array(an.graph.n);
        for (let p = 0; p < an.graph.n; p++) if (patchLab[p] === i) pm[p] = 1;
        const sn = snapToGeometry(an, pm);
        if (sn.iou < 0.7) continue;
        for (let p = 0; p < an.graph.n; p++) {
          if (sn.mask[p] && !claimed[p]) { snappedLab[p] = i; claimed[p] = 1; }
          else if (!sn.mask[p] && snappedLab[p] === i && !claimed[p]) snappedLab[p] = -2; // released
        }
      }
      // released patches take the label of their strongest-connected neighbour
      for (let it = 0; it < 50; it++) {
        let left = 0;
        for (let p = 0; p < an.graph.n; p++) {
          if (snappedLab[p] !== -2) continue;
          let best = -2, bw = 0;
          const acc = new Map();
          for (let k = an.graph.start[p]; k < an.graph.start[p + 1]; k++) {
            const l = snappedLab[an.graph.nbr[k]];
            if (l === -2) continue;
            const w = (acc.get(l) || 0) + an.graph.w[k];
            acc.set(l, w);
            if (w > bw) { bw = w; best = l; }
          }
          if (best === -2) left++; else snappedLab[p] = best;
        }
        if (!left) break;
      }
      for (let p = 0; p < an.graph.n; p++) if (snappedLab[p] === -2) snappedLab[p] = used.length;
      patchLab.set(snappedLab);
      const names = used.map((l) => disc.parts[l].it);
      names.push('altro');
      part.segFace = refineFaceLabels(part.mesh, an.aff, an.graph, patchLab);
      part.segCount = names.length;
      part.segNames = names;
      refreshSegDisplay(part);
      renderSegList();
      setMode('segment');
      toast(`Riconosciute: ${names.slice(0, -1).join(', ')}`, 'ok', 6000);
    });
  } catch (err) {
    console.error(err);
    toast(err.message, 'error', 8000);
  }
}

async function aiSelect() {
  const part = state.active;
  const q = $('ai-query').value.trim();
  if (!part || !q || !requireKey()) return;
  const an = await ensureAnalysis(part);
  const { key, model } = state.settings;
  try {
    await busy(`Gemini cerca «${q}»…`, async () => {
      const views = AI.renderViews(viewer, part);
      const votes = [new Float32Array(an.graph.n)];
      const visible = new Float32Array(an.graph.n);
      let ok = 0;
      await runLimited(views, 3, async (v) => {
        try {
          const items = await AI.segmentView({ key, model, view: v, labels: [q] });
          await AI.accumulateVotes(v, items, [q], an.graph.patchOf, votes, visible);
          ok++;
        } catch (err) { console.warn(err); }
      });
      if (!ok) throw new Error('Nessuna risposta valida da Gemini.');
      const lab = AI.propagateLabels(an.graph, votes, visible, { minScore: 0 });
      const pm = new Uint8Array(an.graph.n);
      let any = 0;
      for (let p = 0; p < an.graph.n; p++) if (lab[p] === 0) { pm[p] = 1; any++; }
      if (!any) throw new Error(`«${q}» non trovato nel modello.`);
      const snapped = snapToGeometry(an, pm);
      setSelection(part, patchMaskToFaces(part, snapped.mask), true, q);
      toast(`Selezionato: ${q}`, 'ok');
    });
  } catch (err) {
    console.error(err);
    toast(err.message, 'error', 8000);
  }
}

function regionArea(g, lab, l) {
  let a = 0;
  for (let p = 0; p < g.n; p++) if (lab[p] === l) a += g.area[p];
  return a;
}

async function runLimited(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const it = items[i++]; await fn(it); }
  });
  await Promise.all(workers);
}

$('btn-ai-analyze').onclick = aiAnalyze;
$('btn-ai-select').onclick = aiSelect;
$('ai-query').addEventListener('keydown', (e) => { if (e.key === 'Enter') aiSelect(); });

// ---------------------------------------------------------------------------
// Split: method, plane gizmo, connector preview
// ---------------------------------------------------------------------------
document.querySelectorAll('[data-method]').forEach((b) => (b.onclick = () => setMethod(b.dataset.method)));

function setMethod(m) {
  state.method = m;
  document.querySelectorAll('[data-method]').forEach((b) => b.classList.toggle('active', b.dataset.method === m));
  $('plane-controls').hidden = m !== 'plane';
  if (m === 'plane') {
    if (!state.plane && state.active) fitPlane();
  } else removePlane();
  $('btn-plane-fit').textContent = state.active?.sel.some((v) => v) ? 'Adatta alla selezione' : 'Piano orizzontale';
  updateConnUI();
  updateSelInfo();
  schedulePreview();
}

function modelSize() {
  const p = state.active;
  return p ? p.mesh.bounds.diag : 100;
}

function ensurePlaneObject() {
  if (state.plane) return state.plane;
  const size = 1;
  const g = new THREE.PlaneGeometry(size, size);
  const mat = new THREE.MeshBasicMaterial({ color: 0x4fc3ff, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false });
  const obj = new THREE.Mesh(g, mat);
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(g), new THREE.LineBasicMaterial({ color: 0x4fc3ff }));
  obj.add(edges);
  const arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(), 0.25, 0xff8a1f, 0.06, 0.04);
  obj.add(arrow);
  obj.renderOrder = 5;
  viewer.modelRoot.add(obj);
  state.plane = { object: obj, base: new THREE.Vector3(), normal: new THREE.Vector3(0, 0, 1) };
  viewer.transform.attach(obj);
  viewer.transform.setMode('translate');
  viewer.transform.enabled = false;
  viewer.transform.getHelper().visible = false;
  viewer.transform.addEventListener('objectChange', onPlaneMoved);
  return state.plane;
}

function onPlaneMoved() {
  schedulePreview();
}

function removePlane() {
  if (!state.plane) return;
  viewer.transform.detach();
  viewer.transform.removeEventListener('objectChange', onPlaneMoved);
  viewer.modelRoot.remove(state.plane.object);
  state.plane.object.traverse((o) => { o.geometry?.dispose(); o.material?.dispose?.(); });
  state.plane = null;
  $('btn-plane-move').classList.remove('on');
  $('btn-plane-rotate').classList.remove('on');
  viewer.requestRender();
}

function fitPlane() {
  const part = state.active;
  if (!part) return;
  const pl = ensurePlaneObject();
  let fit = fitPlaneToSelection(part.mesh, part.sel);
  if (!fit) {
    const b = part.mesh.bounds;
    fit = { normal: state.zUp ? [0, 0, 1] : [0, 1, 0], origin: [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2] };
  }
  const n = new THREE.Vector3(...fit.normal).normalize();
  const o = new THREE.Vector3(...fit.origin).add(part.object.position);
  pl.object.position.copy(o);
  pl.object.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
  const s = part.mesh.bounds.diag * 0.75;
  pl.object.scale.setScalar(s);
  pl.base.copy(o);
  $('plane-offset').value = 0;
  $('plane-offset-val').textContent = '0 mm';
  viewer.requestRender();
  schedulePreview();
}

function currentPlane(part) {
  const pl = state.plane;
  if (!pl) return null;
  pl.object.updateMatrix();
  const n = new THREE.Vector3(0, 0, 1).applyQuaternion(pl.object.quaternion).normalize();
  const o = pl.object.position.clone().sub(part.object.position);
  return { normal: [n.x, n.y, n.z], origin: [o.x, o.y, o.z] };
}

$('btn-plane-fit').onclick = () => fitPlane();
$('plane-offset').oninput = () => {
  const pl = state.plane;
  if (!pl) return;
  const v = parseFloat($('plane-offset').value) / 100;
  const d = (v * modelSize()) / 2;
  const n = new THREE.Vector3(0, 0, 1).applyQuaternion(pl.object.quaternion);
  pl.object.position.copy(pl.base).addScaledVector(n, d);
  $('plane-offset-val').textContent = `${fmt(d)} mm`;
  viewer.requestRender();
  schedulePreview();
};
function toggleGizmo(mode) {
  const pl = ensurePlaneObject();
  const t = viewer.transform;
  const on = !(t.enabled && t.mode === mode);
  t.enabled = on;
  t.getHelper().visible = on;
  t.setMode(mode);
  t.setSpace('local');
  $('btn-plane-move').classList.toggle('on', on && mode === 'translate');
  $('btn-plane-rotate').classList.toggle('on', on && mode === 'rotate');
  if (!on) pl.base.copy(pl.object.position);
  viewer.requestRender();
}
$('btn-plane-move').onclick = () => toggleGizmo('translate');
$('btn-plane-rotate').onclick = () => toggleGizmo('rotate');
viewer.transform.addEventListener('dragging-changed', (e) => { if (!e.value && state.plane) { state.plane.base.copy(state.plane.object.position); $('plane-offset').value = 0; $('plane-offset-val').textContent = '0 mm'; } });
$('chk-plane-only-sel').onchange = () => schedulePreview();

const CONN_LABELS = {
  'peg-round': ['Diametro', 'Lunghezza', 'Perno su'],
  'peg-square': ['Lato', 'Lunghezza', 'Perno su'],
  magnet: ['Ø magnete', 'Spessore', null],
  dovetail: ['Larghezza', 'Altezza', 'Linguetta su'],
};
const CONN_DEFAULTS = { 'peg-round': [5, 6], 'peg-square': [5, 6], magnet: [6, 3], dovetail: [8, 4] };
let lastConnType = 'peg-round';

function updateConnUI() {
  const t = $('conn-type').value;
  if (t !== lastConnType && CONN_DEFAULTS[t]) {
    $('conn-diam').value = CONN_DEFAULTS[t][0];
    $('conn-len').value = CONN_DEFAULTS[t][1];
  }
  lastConnType = t;
  $('conn-params').hidden = t === 'none';
  $('row-auto').hidden = t === 'none';
  if (t === 'none') $('conn-auto').hidden = true;
  if (t !== 'none') {
    const [a, b, c] = CONN_LABELS[t];
    $('lbl-diam').textContent = a;
    $('lbl-len').textContent = b;
    $('row-male').hidden = !c;
    if (c) $('row-male').firstChild.textContent = c + ' ';
    $('row-angle-dt').hidden = t !== 'dovetail';
    $('row-count').hidden = t === 'dovetail';
  }
  let hint = '';
  if (t === 'dovetail' && state.method !== 'plane') hint = 'La coda di rondine funziona solo con il taglio a piano.';
  else if (t === 'magnet') hint = 'Crea una sede su entrambi i pezzi: inserisci i magneti dopo la stampa (attenzione alla polarità).';
  else if (t === 'dovetail') hint = 'La linguetta scorre lungo l\'asse principale della sezione.';
  else if (t.startsWith('peg')) hint = 'Tolleranza consigliata 0.15–0.3 mm per lato (dipende dalla stampante).';
  $('conn-hint').textContent = hint;
}

$('conn-type').onchange = () => { updateConnUI(); schedulePreview(); };
for (const id of ['conn-diam', 'conn-len', 'conn-tol', 'conn-count', 'conn-male', 'conn-angle']) $(id).addEventListener('input', () => schedulePreview());
// typing a size switches to manual sizes
for (const id of ['conn-diam', 'conn-len', 'conn-count']) {
  $(id).addEventListener('input', (e) => {
    if (e.isTrusted && $('chk-auto').checked) { $('chk-auto').checked = false; updateAutoUI(); }
  });
}
$('chk-auto').onchange = () => { updateAutoUI(); schedulePreview(); };

function updateAutoUI(note = null) {
  const auto = $('chk-auto').checked;
  $('conn-params').classList.toggle('auto', auto);
  const box = $('conn-auto');
  if (note) { box.textContent = note; box.hidden = false; }
  else if (!auto) box.hidden = true;
}

/** write the automatically chosen sizes into the fields (without switching to manual) */
function showAutoSpec(spec) {
  if (!spec) return;
  $('conn-diam').value = spec.diameter;
  $('conn-len').value = spec.length;
  $('conn-count').value = spec.count || 1;
}

function readSpec() {
  return {
    type: $('conn-type').value,
    diameter: Math.max(0.5, parseFloat($('conn-diam').value) || 5),
    length: Math.max(0.5, parseFloat($('conn-len').value) || 6),
    tolerance: Math.max(0, parseFloat($('conn-tol').value) || 0),
    count: Math.max(1, Math.min(6, parseInt($('conn-count').value, 10) || 1)),
    maleOn: $('conn-male').value,
    angle: parseFloat($('conn-angle').value) || 15,
    auto: $('chk-auto').checked,
  };
}

function schedulePreview() {
  clearTimeout(state.previewTimer);
  state.previewTimer = setTimeout(updatePreview, 260);
}

function clearPreview() {
  for (const p of state.parts) {
    if (p._preview) { p.object?.remove(p._preview); p._preview.traverse((o) => { o.geometry?.dispose(); o.material?.dispose?.(); }); p._preview = null; }
  }
  viewer.requestRender();
}

async function updatePreview() {
  clearPreview();
  const part = state.active;
  if (!part || !part.object) return;
  const spec = readSpec();
  const hasSel = part.sel.some((v) => v);
  if ((state.method === 'membrane' && !hasSel) || (state.method === 'plane' && !state.plane) || spec.type === 'none') {
    $('conn-auto').hidden = true;
    if (state.method === 'membrane' && spec.type === 'none') return;
    return;
  }
  let plan;
  const seq = ++state.previewSeq;
  const hint = $('conn-hint');
  hint.textContent = 'Calcolo anteprima del taglio…';
  try {
    await geo.ensurePart(part);
    plan = await geo.call('plan', { partId: part.id, sel: part.sel, method: state.method, plane: currentPlane(part), spec, onlySelected: $('chk-plane-only-sel').checked && hasSel });
  } catch (err) {
    if (seq === state.previewSeq) hint.textContent = err.message;
    return;
  }
  if (seq !== state.previewSeq || part !== state.active || !part.object) return; // stale
  clearPreview();
  const g = new THREE.Group();
  for (const line of plan.outline) {
    if (line.length < 2) continue;
    const pts = line.map((q) => new THREE.Vector3(q[0], q[1], q[2]));
    pts.push(pts[0].clone());
    const lg = new THREE.BufferGeometry().setFromPoints(pts);
    const l = new THREE.Line(lg, new THREE.LineBasicMaterial({ color: 0x4fc3ff, depthTest: false, transparent: true }));
    l.renderOrder = 6;
    g.add(l);
  }
  const used = plan.spec || spec;
  for (const pl of plan.placements) g.add(connectorGhost(used, pl));
  part._preview = g;
  part.object.add(g);
  if (plan.spec) showAutoSpec(plan.spec);
  updateConnUI();
  if (spec.type !== 'none') {
    if (spec.auto) updateAutoUI(plan.spec ? `Automatico: ${plan.note}` : null);
    else updateAutoUI(plan.note || null);
    if (!plan.note && !plan.spec) $('conn-auto').hidden = true;
  }
  if (plan.warning) hint.textContent = plan.warning;
  viewer.requestRender();
}

function connectorGhost(spec, pl) {
  const r = spec.diameter / 2;
  const mat = new THREE.MeshBasicMaterial({ color: 0xff8a1f, transparent: true, opacity: 0.45, depthTest: false, depthWrite: false });
  let geo;
  const axis = new THREE.Vector3(...pl.axis).normalize();
  let dir = axis.clone();
  if ((spec.type === 'peg-round' || spec.type === 'peg-square' || spec.type === 'dovetail') && spec.maleOn === 'B') dir.negate();
  if (spec.type === 'peg-round') geo = new THREE.CylinderGeometry(r, r, spec.length, 32);
  else if (spec.type === 'peg-square') geo = new THREE.BoxGeometry(2 * r, spec.length, 2 * r);
  else if (spec.type === 'magnet') geo = new THREE.CylinderGeometry(r, r, spec.length * 2, 32);
  else {
    const L = 20;
    geo = new THREE.BoxGeometry(spec.diameter, spec.length, L);
  }
  const m = new THREE.Mesh(geo, mat);
  m.renderOrder = 7;
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  if (spec.type === 'dovetail' && pl.slide) {
    const s = new THREE.Vector3(...pl.slide);
    const x = new THREE.Vector3().crossVectors(dir, s).normalize();
    const basis = new THREE.Matrix4().makeBasis(x, dir, new THREE.Vector3().crossVectors(x, dir));
    q.setFromRotationMatrix(basis);
  }
  m.quaternion.copy(q);
  const p = new THREE.Vector3(...pl.point);
  if (spec.type === 'magnet') m.position.copy(p);
  else m.position.copy(p).addScaledVector(dir, spec.length / 2);
  return m;
}

$('btn-split').onclick = () => doSplit();

async function doSplit() {
  const part = state.active;
  if (!part) return;
  const spec = readSpec();
  const hasSel = part.sel.some((v) => v);
  if (state.method === 'membrane' && !hasSel) { toast('Seleziona prima una parte.', 'error'); return; }
  try {
    await busy('Taglio in corso…', async () => {
      const t0 = performance.now();
      state.previewSeq++;
      await geo.ensurePart(part);
      const res = await geo.call('cut', { partId: part.id, sel: part.sel, method: state.method, plane: currentPlane(part), spec, onlySelected: $('chk-plane-only-sel').checked && hasSel });
      const nameA = state.selName ? capitalize(state.selName) : state.method === 'plane' && !hasSel ? `${part.name} (sopra)` : `${part.name} – parte`;
      const nameB = state.method === 'plane' && !hasSel ? `${part.name} (sotto)` : `${part.name} – resto`;
      const wA = weld(res.A.pos, res.A.tri), wB = weld(res.B.pos, res.B.tri);
      const pA = new Part(nameA, wA.pos, wA.tri);
      const pB = new Part(nameB, wB.pos, wB.tri, { color: part.color });
      pA.color = PART_COLORS[(state.parts.length + 1) % PART_COLORS.length];
      if (pA.color === pB.color) pA.color = PART_COLORS[(state.parts.length + 2) % PART_COLORS.length];
      // explode direction
      const ca = selectionCentroid(pA.mesh, new Uint8Array(pA.mesh.nf).fill(1));
      const cb = selectionCentroid(pB.mesh, new Uint8Array(pB.mesh.nf).fill(1));
      const dir = new THREE.Vector3(ca[0] - cb[0], ca[1] - cb[1], ca[2] - cb[2]).normalize();
      pA.explodeDir.copy(part.explodeDir).add(dir);
      pB.explodeDir.copy(part.explodeDir);
      const before = state.parts.slice();
      const idx = state.parts.indexOf(part);
      viewer.disposePart(part);
      disposePartManifold(part);
      state.parts.splice(idx, 1);
      addPart(pB, idx);
      addPart(pA, idx + 1);
      pushUndo({ type: 'parts', before, after: state.parts.slice(), activeBefore: part, activeAfter: pA });
      state.active = pA;
      state.smart = null;
      state.selName = null;
      removePlane();
      clearPreview();
      applyExplode();
      refreshAll();
      for (const w of res.warnings) toast(w, 'error', 7000);
      if (res.spec && res.note) toast(`Connettori: ${res.note}`, 'ok', 7000);
      if (state.method === 'plane' && hasSel) {
        const selArea = selectedStats(part).area;
        if (pA.mesh.totalArea > selArea * 1.8 + part.mesh.totalArea * 0.02) {
          toast('Il piano ha staccato molto più della selezione (attraversa anche altre parti). Se non è quello che volevi, premi Annulla e usa «Bordo naturale».', 'error', 10000);
        }
      }
      status(`Separato in ${((performance.now() - t0) / 1000).toFixed(1)} s: «${pA.name}» e «${pB.name}»`);
      toast(`Parte separata: «${pA.name}». Puoi esportarla da Esporta ▾`, 'ok');
    });
  } catch (err) {
    console.error(err);
    toast(err.message || String(err), 'error', 8000);
  }
}

function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// ---------------------------------------------------------------------------
// Explode & view options
// ---------------------------------------------------------------------------
function applyExplode() {
  const v = parseFloat($('explode').value) / 100;
  const size = Math.max(...state.parts.map((p) => p.mesh.bounds.diag), 1);
  for (const p of state.parts) {
    if (!p.object) continue;
    p.object.position.copy(p.explodeDir).multiplyScalar(v * size * 0.35);
  }
  viewer.requestRender();
}
$('explode').oninput = () => { applyExplode(); if (state.plane && state.active) fitPlane(); };
$('chk-wire').onchange = () => {
  state.wire = $('chk-wire').checked;
  for (const p of state.parts) {
    if (!p.object) continue;
    if (state.wire && !p._wire) {
      const w = new THREE.LineSegments(new THREE.WireframeGeometry(p.object.geometry), new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.25 }));
      p._wire = w;
      p.object.add(w);
    } else if (!state.wire && p._wire) {
      p.object.remove(p._wire); p._wire.geometry.dispose(); p._wire.material.dispose(); p._wire = null;
    }
  }
  viewer.requestRender();
};
document.querySelectorAll('[data-view]').forEach((b) => (b.onclick = () => viewer.setView(b.dataset.view)));
$('btn-frame').onclick = () => viewer.frameObjects(state.parts.filter((p) => p.visible).map((p) => p.object));

// ---------------------------------------------------------------------------
// Parts list, info panel
// ---------------------------------------------------------------------------
function renderPartsList() {
  const ul = $('parts-list');
  ul.innerHTML = '';
  if (!state.parts.length) { ul.innerHTML = '<li class="empty">Nessun modello caricato</li>'; return; }
  for (const p of state.parts) {
    const li = document.createElement('li');
    li.classList.toggle('active', p === state.active);
    li.classList.toggle('hidden-part', !p.visible);
    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = `#${new THREE.Color(p.color).getHexString()}`;
    const nm = document.createElement('span');
    nm.className = 'name';
    nm.textContent = p.name;
    nm.title = 'Doppio clic per rinominare';
    nm.ondblclick = (e) => {
      e.stopPropagation();
      const v = prompt('Nome della parte', p.name);
      if (v) { p.name = v.trim(); renderPartsList(); }
    };
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = shortCount(p.mesh.nf);
    const eye = document.createElement('button');
    eye.className = 'icon-btn';
    eye.textContent = p.visible ? '👁' : '◌';
    eye.title = p.visible ? 'Nascondi' : 'Mostra';
    eye.onclick = (e) => { e.stopPropagation(); p.visible = !p.visible; p.object.visible = p.visible; viewer.requestRender(); renderPartsList(); };
    const dl = document.createElement('button');
    dl.className = 'icon-btn';
    dl.textContent = '⤓';
    dl.title = 'Scarica STL';
    dl.onclick = (e) => { e.stopPropagation(); downloadBytes(toSTL(p.mesh, p.name), `${safeFileName(p.name)}.stl`, 'model/stl'); };
    li.append(sw, nm, meta, eye, dl);
    li.onclick = () => {
      if (state.active === p) return;
      const prev = state.active;
      state.active = p;
      state.smart = null;
      if (prev) refreshSelectionDisplay(prev);
      refreshAll();
      if (state.method === 'plane') fitPlane();
    };
    ul.appendChild(li);
  }
}

function shortCount(n) {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M △` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k △` : `${n} △`;
}

function renderInfo() {
  const p = state.active;
  const dl = $('model-info');
  dl.innerHTML = '';
  $('btn-repair').disabled = !p;
  if (!p) return;
  const m = p.mesh;
  const b = m.bounds;
  const dims = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
  const closed = m.isClosed();
  const rows = [
    ['Triangoli', m.nf.toLocaleString('it-IT')],
    ['Dimensioni', `${fmt(dims[0])} × ${fmt(dims[1])} × ${fmt(dims[2])} mm`],
    ['Corpi separati', String(m.numComponents)],
    ['Chiusa (stampabile)', closed ? 'sì' : `no (${m.boundaryEdges} bordi aperti${m.nonManifoldEdges ? `, ${m.nonManifoldEdges} non-manifold` : ''}${m.inconsistentEdges ? `, ${m.inconsistentEdges} invertiti` : ''})`, closed ? 'good' : 'bad'],
  ];
  if (closed) rows.push(['Volume', `${fmt(Math.abs(m.signedVolume()) / 1000, 2)} cm³`]);
  if (document.activeElement !== $('model-height')) $('model-height').value = fmt(modelHeight(), 2);
  for (const [k, v, cls] of rows) {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v; if (cls) dd.className = cls;
    dl.append(dt, dd);
  }
}

function refreshAll() {
  const has = !!state.active;
  for (const id of ['btn-autoseg', 'btn-ai-analyze', 'btn-ai-select', 'ai-query']) $(id).disabled = !has;
  $('btn-export').disabled = !state.parts.length;
  renderPartsList();
  renderSegList();
  renderInfo();
  updateSelInfo();
  updateSmartNav();
  updateUndoButtons();
  if (state.active) $('brush-radius-val').textContent = `${fmt(brushRadius(state.active))} mm`;
  for (const p of state.parts) refreshSelectionDisplay(p);
  schedulePreview();
}

function modelHeight() {
  const ax = state.zUp ? 2 : 1;
  let lo = Infinity, hi = -Infinity;
  for (const p of state.parts) { lo = Math.min(lo, p.mesh.bounds.min[ax]); hi = Math.max(hi, p.mesh.bounds.max[ax]); }
  return isFinite(hi - lo) ? hi - lo : 0;
}

$('btn-scale').onclick = async () => {
  const target = parseFloat($('model-height').value);
  const cur = modelHeight();
  if (!(target > 0) || !(cur > 0)) return;
  const k = target / cur;
  if (Math.abs(k - 1) < 1e-6) return;
  await busy('Scalatura del modello…', async () => {
    const before = state.parts.slice();
    const activeIdx = state.parts.indexOf(state.active);
    const next = before.map((p) => {
      const pos = Float32Array.from(p.mesh.pos, (v) => v * k);
      const np = new Part(p.name, pos, p.mesh.tri, { faceGroup: p.mesh.faceGroup, groupKind: p.groupKind, color: p.color });
      np.explodeDir.copy(p.explodeDir);
      np.visible = p.visible;
      return np;
    });
    for (const p of before) { viewer.disposePart(p); disposePartManifold(p); }
    state.parts = [];
    for (const p of next) { addPart(p); p.object.visible = p.visible; }
    state.active = next[Math.max(0, activeIdx)];
    pushUndo({ type: 'parts', before, after: next.slice(), activeBefore: before[Math.max(0, activeIdx)], activeAfter: state.active });
    removePlane();
    applyExplode();
    viewer.frameObjects(state.parts.map((p) => p.object));
    refreshAll();
    toast(`Modello scalato ×${k.toFixed(3)} (altezza ${fmt(target)} mm)`, 'ok');
  });
};

// ---------------------------------------------------------------------------
// Repair
// ---------------------------------------------------------------------------
$('btn-repair').onclick = async () => {
  const part = state.active;
  if (!part) return;
  try {
    await busy('Riparazione mesh…', async () => {
      const before = state.parts.slice();
      const { mesh: fixed, report } = repairMesh(part.mesh);
      const np = new Part(part.name, null, null, { mesh: fixed, color: part.color });
      np.explodeDir.copy(part.explodeDir);
      const idx = state.parts.indexOf(part);
      viewer.disposePart(part);
      disposePartManifold(part);
      state.parts.splice(idx, 1);
      addPart(np, idx);
      state.active = np;
      pushUndo({ type: 'parts', before, after: state.parts.slice(), activeBefore: part, activeAfter: np });
      applyExplode();
      refreshAll();
      const bits = [];
      if (report.holesFilled) bits.push(`${report.holesFilled} buchi chiusi`);
      if (report.removedFaces) bits.push(`${report.removedFaces} triangoli non-manifold rimossi`);
      if (report.flipped) bits.push(`${report.flipped} triangoli riorientati`);
      if (report.removedSpecks) bits.push(`${report.removedSpecks} frammenti eliminati`);
      toast(`Riparazione: ${bits.join(', ') || 'nessun difetto trovato'}. ${np.mesh.isClosed() ? 'La mesh ora è chiusa.' : 'Restano difetti non riparabili automaticamente.'}`, np.mesh.isClosed() ? 'ok' : 'error', 8000);
    });
  } catch (err) {
    toast(err.message, 'error');
  }
};

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
$('btn-export').onclick = (e) => { e.stopPropagation(); $('export-menu').hidden = !$('export-menu').hidden; };
document.addEventListener('click', () => { $('export-menu').hidden = true; });
document.querySelectorAll('[data-export]').forEach((b) => (b.onclick = () => doExport(b.dataset.export)));

function doExport(kind) {
  const parts = state.parts.filter((p) => p.visible);
  if (!parts.length) return;
  const base = safeFileName(state.fileName);
  const names = uniqueNames(parts.map((p) => safeFileName(p.name)));
  if (kind === '3mf') {
    downloadBytes(to3MF(parts.map((p) => ({ name: p.name, pos: p.mesh.pos, tri: p.mesh.tri, color: `#${new THREE.Color(p.color).getHexString()}` }))), `${base}.3mf`, 'model/3mf');
  } else if (kind === 'stl-zip' || kind === 'obj-zip') {
    const files = {};
    parts.forEach((p, i) => { files[`${names[i]}.${kind === 'stl-zip' ? 'stl' : 'obj'}`] = kind === 'stl-zip' ? toSTL(p.mesh, p.name) : toOBJ(p.mesh, p.name); });
    downloadBytes(zipFiles(files), `${base}.zip`, 'application/zip');
  } else if (kind === 'stl-active' && state.active) {
    downloadBytes(toSTL(state.active.mesh, state.active.name), `${safeFileName(state.active.name)}.stl`, 'model/stl');
  }
  $('export-menu').hidden = true;
}

function uniqueNames(list) {
  const seen = new Map();
  return list.map((n) => {
    const c = seen.get(n) || 0;
    seen.set(n, c + 1);
    return c ? `${n}_${c + 1}` : n;
  });
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
function openSettings() {
  $('set-key').value = state.settings.key || '';
  $('set-model').value = state.settings.model || AI.DEFAULT_MODEL;
  $('set-units').value = state.settings.units || '1';
  $('key-test-result').textContent = '';
  $('dlg-settings').showModal();
}
$('btn-settings').onclick = openSettings;
$('btn-save-settings').onclick = () => {
  state.settings.key = $('set-key').value.trim();
  state.settings.model = $('set-model').value.trim() || AI.DEFAULT_MODEL;
  state.settings.units = $('set-units').value;
  AI.saveSettings(state.settings);
  toast('Impostazioni salvate (l\'unità vale per i prossimi file aperti).', 'ok');
};
$('btn-test-key').onclick = async () => {
  const out = $('key-test-result');
  out.textContent = 'Verifica in corso…';
  try {
    const r = await AI.testKey($('set-key').value.trim(), $('set-model').value.trim() || AI.DEFAULT_MODEL);
    out.textContent = `✓ La chiave funziona (risposta: ${r.slice(0, 40)})`;
  } catch (err) {
    out.textContent = `✗ ${err.message}`;
  }
};

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------
window.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea') || $('dlg-settings').open) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
  if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); redo(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (k === 'escape') $('btn-clear').click();
  else if (k === 's') setMode('smart');
  else if (k === 'g') setMode('segment');
  else if (k === 'u') setMode('surface');
  else if (k === 'b') setMode('brush');
  else if (k === 'c') setMode('component');
  else if (k === 'i') $('btn-invert').click();
  else if (k === '+' || k === '=') $('btn-grow').click();
  else if (k === '-') $('btn-shrink').click();
  else if (k === 'f') $('btn-frame').click();
  else if (k === '[' || k === ']') {
    const r = $('brush-radius');
    r.value = String(Math.max(1, Math.min(100, parseFloat(r.value) + (k === ']' ? 3 : -3))));
    r.oninput();
  }
});
$('btn-undo').onclick = undo;
$('btn-redo').onclick = redo;

setMode('smart');
updateConnUI();
updateAutoUI();
refreshAll();
window.__app.loadDemo = loadDemo;
window.__app.openFile = openFile;
// test helper: screen position (client px) of a model-space point of the active part
window.__app.screenOf = (p, part = state.active) => {
  const v = new THREE.Vector3(...p).applyMatrix4(part.object.matrixWorld).project(viewer.camera);
  const r = viewer.renderer.domElement.getBoundingClientRect();
  return [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height];
};
