// Gemini integration: render views of the model, ask for part names and segmentation
// masks, and project the 2D masks back onto mesh faces through a face-ID buffer.
import * as THREE from 'three';

export const DEFAULT_MODEL = 'gemini-2.5-flash';
const LS_KEY = '3dsplit.settings';

export function loadSettings() {
  try {
    return { model: DEFAULT_MODEL, key: '', units: '1', ...JSON.parse(localStorage.getItem(LS_KEY) || '{}') };
  } catch {
    return { model: DEFAULT_MODEL, key: '', units: '1' };
  }
}

export function saveSettings(s) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch { /* storage unavailable */ }
}

export async function callGemini({ key, model, parts, json = false, signal }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const wantsNoThinking = /2\.5-flash/.test(model);
  const makeBody = (noThinking) => ({
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature: 0.3,
      ...(json ? { responseMimeType: 'application/json' } : {}),
      ...(noThinking ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
    },
  });
  let tryNoThinking = wantsNoThinking;
  for (let attempt = 0; attempt < 3; attempt++) {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(makeBody(tryNoThinking)),
      signal,
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const msg = data?.error?.message || `HTTP ${resp.status}`;
      if (tryNoThinking && /thinking/i.test(msg)) { tryNoThinking = false; continue; }
      if (resp.status === 429 || resp.status === 503) {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      throw new Error(`Gemini: ${msg}`);
    }
    const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
    if (!text) throw new Error('Gemini non ha restituito testo' + (data.promptFeedback?.blockReason ? ` (${data.promptFeedback.blockReason})` : ''));
    return text;
  }
  throw new Error('Gemini: troppe richieste, riprova tra poco.');
}

export function parseJSONLoose(text) {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  try { return JSON.parse(t); } catch { /* try to locate the JSON */ }
  const a = t.indexOf('['), o = t.indexOf('{');
  const start = a >= 0 && (o < 0 || a < o) ? a : o;
  if (start < 0) throw new Error('Risposta AI non valida');
  const end = Math.max(t.lastIndexOf(']'), t.lastIndexOf('}'));
  return JSON.parse(t.slice(start, end + 1));
}

export async function testKey(key, model) {
  const t = await callGemini({ key, model, parts: [{ text: 'Rispondi solo con la parola OK.' }] });
  return t.trim();
}

// ---------------------------------------------------------------------------
// Rendering views with a face-id pass
// ---------------------------------------------------------------------------

const VIEW_DIRS = [
  { name: 'fronte', dir: [0, 0.15, 1] },
  { name: 'retro', dir: [0, 0.15, -1] },
  { name: 'sinistra', dir: [-1, 0.15, 0] },
  { name: 'destra', dir: [1, 0.15, 0] },
  { name: '3/4 fronte', dir: [0.7, 0.45, 0.7] },
  { name: 'alto', dir: [0.0001, 1, 0.25] },
];

export function renderViews(viewer, part, opts = {}) {
  const S = opts.size ?? 768;
  const renderer = viewer.renderer;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xffffff);
  const geom = part.object.geometry;
  const shadedMat = opts.material || new THREE.MeshStandardMaterial({ color: 0xb9b9b9, roughness: 0.7, metalness: 0.0, side: THREE.DoubleSide });
  const idMat = new THREE.ShaderMaterial({
    vertexShader: `flat varying int vFace;
void main() { vFace = gl_VertexID / 3; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `flat varying int vFace;
void main() { int id = vFace + 1; gl_FragColor = vec4(float(id & 255) / 255.0, float((id >> 8) & 255) / 255.0, float((id >> 16) & 255) / 255.0, 1.0); }`,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geom, shadedMat);
  part.object.updateMatrixWorld();
  mesh.matrixAutoUpdate = false;
  mesh.matrix.copy(part.object.matrixWorld);
  mesh.matrixWorld.copy(part.object.matrixWorld);
  scene.add(mesh);
  const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 1e6);
  scene.add(cam);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x666666, 1.4));
  const key = new THREE.DirectionalLight(0xffffff, 2.0);
  key.position.set(0.4, 0.8, 1);
  cam.add(key);
  key.target.position.set(0, 0, -1);
  cam.add(key.target);
  const box = new THREE.Box3().setFromObject(part.object);
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const dist = sphere.radius / Math.sin((cam.fov * Math.PI) / 360) * 1.02;
  const rtColor = new THREE.WebGLRenderTarget(S, S, { samples: 4, type: THREE.UnsignedByteType });
  rtColor.texture.colorSpace = THREE.SRGBColorSpace;
  const rtId = new THREE.WebGLRenderTarget(S, S, { type: THREE.UnsignedByteType });
  const px = new Uint8Array(S * S * 4);
  const canvas = document.createElement('canvas');
  canvas.width = S; canvas.height = S;
  const ctx = canvas.getContext('2d');
  const views = [];
  const prevTarget = renderer.getRenderTarget();
  const prevClear = renderer.getClearColor(new THREE.Color());
  const prevAlpha = renderer.getClearAlpha();
  const dirs = opts.dirs || VIEW_DIRS;
  for (const v of dirs) {
    const d = new THREE.Vector3(...v.dir).normalize();
    cam.position.copy(sphere.center).addScaledVector(d, dist);
    cam.up.set(0, 1, 0);
    if (Math.abs(d.y) > 0.95) cam.up.set(0, 0, -1);
    cam.lookAt(sphere.center);
    cam.near = dist - sphere.radius * 1.5 > 0 ? dist - sphere.radius * 1.5 : dist / 100;
    cam.far = dist + sphere.radius * 2;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    // shaded
    mesh.material = shadedMat;
    scene.background = new THREE.Color(0xffffff);
    renderer.setRenderTarget(rtColor);
    renderer.render(scene, cam);
    renderer.readRenderTargetPixels(rtColor, 0, 0, S, S, px);
    const img = ctx.createImageData(S, S);
    for (let y = 0; y < S; y++) {
      const src = (S - 1 - y) * S * 4;
      img.data.set(px.subarray(src, src + S * 4), y * S * 4);
    }
    ctx.putImageData(img, 0, 0);
    const jpeg = canvas.toDataURL('image/jpeg', 0.9).split(',')[1];
    // ids
    mesh.material = idMat;
    scene.background = new THREE.Color(0x000000);
    renderer.setRenderTarget(rtId);
    renderer.setClearColor(0x000000, 1);
    renderer.render(scene, cam);
    renderer.readRenderTargetPixels(rtId, 0, 0, S, S, px);
    const ids = new Int32Array(S * S);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const o = ((S - 1 - y) * S + x) * 4;
        ids[y * S + x] = (px[o] | (px[o + 1] << 8) | (px[o + 2] << 16)) - 1;
      }
    }
    views.push({ name: v.name, jpeg, ids, size: S, ...(opts.keepImage ? { image: img } : {}) });
  }
  renderer.setRenderTarget(prevTarget);
  renderer.setClearColor(prevClear, prevAlpha);
  rtColor.dispose(); rtId.dispose(); idMat.dispose();
  if (!opts.material) shadedMat.dispose();
  return views;
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

export async function discoverParts({ key, model, views, signal }) {
  const parts = [{
    text: `Queste immagini mostrano lo stesso modello 3D (una mesh grigia, sfondo bianco) da diverse angolazioni.
Individua le parti principali, distinte e non sovrapposte, che una persona potrebbe voler separare per stamparle in 3D
(ad esempio per un personaggio: capelli, testa, busto, braccia, mani, gambe, piedi, accessori, basamento).
Rispondi SOLO con JSON nel formato:
{"oggetto": "breve descrizione in italiano", "parti": [{"it": "nome breve in italiano", "en": "short english name"}]}
Al massimo 12 parti, che insieme coprano tutto il modello.`,
  }];
  for (const v of views.slice(0, 4)) parts.push({ inline_data: { mime_type: 'image/jpeg', data: v.jpeg } });
  const text = await callGemini({ key, model, parts, json: true, signal });
  const data = parseJSONLoose(text);
  const list = (data.parti || data.parts || []).map((p) => (typeof p === 'string' ? { it: p, en: p } : { it: p.it || p.en, en: p.en || p.it })).filter((p) => p.it);
  return { object: data.oggetto || data.object || '', parts: list.slice(0, 12) };
}

export async function segmentView({ key, model, view, labels, signal }) {
  const names = labels.map((l) => JSON.stringify(l)).join(', ');
  const parts = [
    { inline_data: { mime_type: 'image/jpeg', data: view.jpeg } },
    {
      text: `This is a render of a 3D model (grey mesh on white background). Give the segmentation masks for these parts of the model: ${names}.
Output a JSON list of segmentation masks where each entry contains the 2D bounding box in the key "box_2d", the segmentation mask in key "mask", and the text label in the key "label".
The "label" must be exactly one of: ${names}. Only include parts that are visible in this image; never segment the white background.`,
    },
  ];
  const text = await callGemini({ key, model, parts, signal });
  let items = parseJSONLoose(text);
  if (!Array.isArray(items)) items = items.masks || items.items || [];
  return items.filter((it) => it && Array.isArray(it.box_2d) && it.box_2d.length === 4);
}

async function decodeMask(mask, w, h) {
  if (!mask) return null;
  const src = mask.startsWith('data:') ? mask : `data:image/png;base64,${mask}`;
  const img = new Image();
  img.src = src;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = Math.max(d[4 * i], d[4 * i + 3] < 255 ? d[4 * i + 3] : 0);
  return out;
}

/**
 * Accumulate per-patch votes. votes: Float32Array[L], visible: Float32Array (per patch)
 */
export async function accumulateVotes(view, items, labels, patchOf, votes, visible, opts = {}) {
  const S = view.size;
  if (!opts.skipVisible) {
    for (let i = 0; i < S * S; i++) {
      const f = view.ids[i];
      if (f >= 0) visible[patchOf[f]] += 1;
    }
  }
  const norm = (s) => String(s || '').toLowerCase().trim();
  const lmap = new Map(labels.map((l, i) => [norm(l), i]));
  for (const it of items) {
    let li = lmap.get(norm(it.label));
    if (li === undefined) {
      // tolerate small label variations
      for (const [k, v] of lmap) if (norm(it.label).includes(k) || k.includes(norm(it.label))) { li = v; break; }
    }
    if (li === undefined) continue;
    let [y0, x0, y1, x1] = it.box_2d.map(Number);
    y0 = Math.max(0, Math.floor((y0 / 1000) * S)); x0 = Math.max(0, Math.floor((x0 / 1000) * S));
    y1 = Math.min(S, Math.ceil((y1 / 1000) * S)); x1 = Math.min(S, Math.ceil((x1 / 1000) * S));
    const bw = x1 - x0, bh = y1 - y0;
    if (bw <= 0 || bh <= 0) continue;
    let m = null;
    try { m = await decodeMask(it.mask, bw, bh); } catch { m = null; }
    const v = votes[li];
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        const prob = m ? m[y * bw + x] : 255;
        if (prob < 128) continue;
        const f = view.ids[(y0 + y) * S + (x0 + x)];
        if (f >= 0) v[patchOf[f]] += m ? 1 : 0.5;
      }
    }
  }
}

/**
 * Turn votes into smooth patch labels with graph label propagation.
 * @returns {Int32Array} label per patch (-1 = none/other)
 */
export function propagateLabels(graph, votes, visible, opts = {}) {
  const P = graph.n, L = votes.length;
  const bgIdx = L; // "other"
  const D = new Float32Array(P * (L + 1));
  const conf = new Float32Array(P);
  for (let p = 0; p < P; p++) {
    const vis = visible[p];
    if (vis <= 0) continue;
    let s = 0;
    for (let l = 0; l < L; l++) { const x = Math.min(1, votes[l][p] / vis); D[p * (L + 1) + l] = x; s += x; }
    D[p * (L + 1) + bgIdx] = opts.noBackground ? 0 : Math.max(0, 1 - s);
    conf[p] = Math.min(1, vis / 40);
  }
  let Q = Float32Array.from(D);
  let Q2 = new Float32Array(Q.length);
  const iters = opts.iters ?? 60;
  for (let it = 0; it < iters; it++) {
    for (let p = 0; p < P; p++) {
      const deg = graph.deg[p] || 1;
      const k = conf[p] * deg * 1.5;
      for (let l = 0; l <= L; l++) {
        let s = k * D[p * (L + 1) + l];
        for (let q = graph.start[p]; q < graph.start[p + 1]; q++) s += graph.w[q] * Q[graph.nbr[q] * (L + 1) + l];
        Q2[p * (L + 1) + l] = s / (k + deg);
      }
    }
    const t = Q; Q = Q2; Q2 = t;
  }
  const lab = new Int32Array(P).fill(-1);
  for (let p = 0; p < P; p++) {
    let best = -1, bv = opts.minScore ?? 0.02;
    for (let l = 0; l <= L; l++) { const x = Q[p * (L + 1) + l]; if (x > bv) { bv = x; best = l; } }
    lab[p] = best === bgIdx ? -1 : best;
  }
  return lab;
}

export { VIEW_DIRS };
