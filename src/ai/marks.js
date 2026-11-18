// "Set of marks" recognition for any vision model (Ollama, LM Studio, …): the geometric
// segments are drawn in distinct colours with their number on top, and the model only
// has to say which numbers are which part. No segmentation masks needed.
import * as THREE from 'three';
import { renderViews, parseJSONLoose } from './gemini.js';
import { chat } from './providers.js';

const MARK_DIRS = [
  { name: 'fronte', dir: [0, 0.15, 1] },
  { name: 'retro', dir: [0, 0.15, -1] },
  { name: 'tre quarti sinistra', dir: [-0.75, 0.35, 0.6] },
  { name: 'tre quarti destra', dir: [0.75, 0.35, 0.6] },
];

function segmentMaterial(viewer) {
  return new THREE.ShaderMaterial({
    uniforms: { uPalette: { value: viewer.paletteTex } },
    vertexShader: `attribute float aSeg;
varying float vSeg;
varying vec3 vN;
void main() {
  vSeg = aSeg;
  vN = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`,
    fragmentShader: `uniform sampler2D uPalette;
varying float vSeg;
varying vec3 vN;
void main() {
  float sg = floor(vSeg + 0.5);
  vec3 c = vec3(0.78);
  if (sg > 0.5) {
    float idx = sg - 1.0;
    c = texelFetch(uPalette, ivec2(int(mod(idx, 1024.0)), int(floor(idx / 1024.0))), 0).rgb;
  }
  vec3 n = normalize(vN) * (gl_FrontFacing ? 1.0 : -1.0);
  float l = 0.5 + 0.5 * max(dot(n, normalize(vec3(0.3, 0.5, 1.0))), 0.0);
  gl_FragColor = vec4(c * l, 1.0);
  #include <colorspace_fragment>
}`,
    side: THREE.DoubleSide,
  });
}

/**
 * Render views with numbered segments.
 * @returns views [{name, jpeg, visible: Map(label -> pixel count)}]
 */
export function renderMarkedViews(viewer, part, opts = {}) {
  const mat = segmentMaterial(viewer);
  const S = opts.size ?? 896;
  const views = renderViews(viewer, part, { dirs: opts.dirs || MARK_DIRS, material: mat, keepImage: true, size: S });
  mat.dispose();
  const seg = part.segFace;
  const minPix = Math.max(120, S * S * 0.0004);
  for (const v of views) {
    const count = new Map(), sx = new Map(), sy = new Map(), pix = new Map();
    for (let i = 0; i < S * S; i++) {
      const f = v.ids[i];
      if (f < 0) continue;
      const l = seg[f];
      if (l < 0) continue;
      count.set(l, (count.get(l) || 0) + 1);
      sx.set(l, (sx.get(l) || 0) + (i % S));
      sy.set(l, (sy.get(l) || 0) + Math.floor(i / S));
      let arr = pix.get(l);
      if (!arr) { arr = []; pix.set(l, arr); }
      if (arr.length < 4000 || Math.random() < 4000 / count.get(l)) arr.push(i);
    }
    const canvas = document.createElement('canvas');
    canvas.width = S; canvas.height = S;
    const ctx = canvas.getContext('2d');
    ctx.putImageData(v.image, 0, 0);
    const placed = [];
    const visible = new Map();
    const labels = [...count.keys()].filter((l) => count.get(l) >= minPix).sort((a, b) => count.get(b) - count.get(a));
    ctx.font = `bold ${Math.round(S / 40)}px system-ui, Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const l of labels) {
      const cx = sx.get(l) / count.get(l), cy = sy.get(l) / count.get(l);
      // a pixel of the segment near its centre, away from labels already placed
      let best = null, bestScore = -Infinity;
      for (const i of pix.get(l)) {
        const x = i % S, y = Math.floor(i / S);
        let dl = 60;
        for (const p of placed) dl = Math.min(dl, Math.hypot(p[0] - x, p[1] - y));
        const score = 2 * dl - Math.hypot(x - cx, y - cy) * 0.5;
        if (score > bestScore) { bestScore = score; best = [x, y]; }
      }
      if (!best) continue;
      placed.push(best);
      visible.set(l, count.get(l));
      const txt = String(l + 1);
      const w = ctx.measureText(txt).width + S / 70, h = S / 28;
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.strokeStyle = '#111';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect(best[0] - w / 2, best[1] - h / 2, w, h, h / 3);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#000';
      ctx.fillText(txt, best[0], best[1] + 1);
    }
    v.jpeg = canvas.toDataURL('image/jpeg', 0.9).split(',')[1];
    v.visible = visible;
    delete v.image;
    delete v.ids;
  }
  return views;
}

const normName = (s) => String(s || '').toLowerCase().trim().replace(/\s+/g, ' ');

function numbersIn(x) {
  if (Array.isArray(x)) return x.map((n) => parseInt(n, 10)).filter((n) => Number.isFinite(n));
  if (typeof x === 'string') return (x.match(/\d+/g) || []).map(Number);
  if (typeof x === 'number') return [x];
  return [];
}

/**
 * Ask the model to name every numbered zone. Views are sent one at a time so that small
 * local models (often single-image) work too.
 * @returns {{object:string, names: Map(label -> name)}}
 */
export async function nameSegments(cfg, views, onProgress = () => {}) {
  const votes = new Map(); // label -> Map(name -> count)
  let object = '';
  let answered = 0;
  for (let k = 0; k < views.length; k++) {
    const v = views[k];
    onProgress(k, views.length);
    const nums = [...v.visible.keys()].map((l) => l + 1).sort((a, b) => a - b);
    const text = `Questa immagine mostra un modello 3D visto da ${v.name}. La superficie è divisa in zone colorate e su ogni zona è scritto un numero (${nums.join(', ')}).
Dimmi cosa rappresenta ogni zona numerata, per esempio: capelli, viso, testa, collo, busto, vestito, braccio destro, mano sinistra, gamba, piede, basamento, accessorio, arma.
Rispondi SOLO con JSON in questo formato:
{"oggetto": "descrizione breve del modello", "zone": {"1": "capelli", "4": "viso", "7": "basamento"}}
Regole: nomi brevi in italiano; zone che fanno parte della stessa cosa devono avere esattamente lo stesso nome; usa solo i numeri che vedi nell'immagine.`;
    let data;
    try {
      data = parseJSONLoose(await chat(cfg, { text, images: [v.jpeg] }));
    } catch (err) {
      if (/contattare|non trovato|HTTP 4/i.test(err.message)) throw err;
      console.warn('vista', v.name, err);
      continue;
    }
    answered++;
    if (!object && data.oggetto) object = String(data.oggetto);
    let zones = data.zone || data.zones || data.parti || {};
    if (Array.isArray(zones)) {
      // [{"nome": "capelli", "numeri": [1,2]}] is accepted too
      const o = {};
      for (const z of zones) for (const n of numbersIn(z.numeri ?? z.numbers ?? z.numero)) o[n] = z.nome ?? z.name;
      zones = o;
    }
    for (const [num, name] of Object.entries(zones)) {
      const l = parseInt(num, 10) - 1;
      if (!v.visible.has(l) || !name) continue;
      let m = votes.get(l);
      if (!m) { m = new Map(); votes.set(l, m); }
      const n = normName(name);
      m.set(n, (m.get(n) || 0) + 1);
    }
  }
  if (!answered) throw new Error('Il modello non ha dato risposte valide. Usa un modello con visione (es. qwen2.5vl, gemma3, llama3.2-vision).');
  const names = new Map();
  for (const [l, m] of votes) {
    let best = null, bc = 0;
    for (const [n, c] of m) if (c > bc) { bc = c; best = n; }
    if (best) names.set(l, best);
  }
  return { object, names };
}

/**
 * Ask which numbered zones belong to `query`.
 * @returns Set of labels
 */
export async function findSegments(cfg, views, query, onProgress = () => {}) {
  const chosen = new Map(), seen = new Map();
  let answered = 0;
  for (let k = 0; k < views.length; k++) {
    const v = views[k];
    onProgress(k, views.length);
    for (const l of v.visible.keys()) seen.set(l, (seen.get(l) || 0) + 1);
    const text = `Questa immagine mostra un modello 3D diviso in zone colorate; su ogni zona è scritto un numero.
Quali numeri fanno parte di: «${query}»?
Rispondi SOLO con JSON: {"numeri": [3, 8]} (lista vuota se «${query}» non si vede in questa immagine).`;
    let data;
    try {
      data = parseJSONLoose(await chat(cfg, { text, images: [v.jpeg] }));
    } catch (err) {
      if (/contattare|non trovato|HTTP 4/i.test(err.message)) throw err;
      console.warn('vista', v.name, err);
      continue;
    }
    answered++;
    for (const n of numbersIn(data.numeri ?? data.numbers ?? data)) {
      const l = n - 1;
      if (v.visible.has(l)) chosen.set(l, (chosen.get(l) || 0) + 1);
    }
  }
  if (!answered) throw new Error('Il modello non ha dato risposte valide. Usa un modello con visione (es. qwen2.5vl, gemma3, llama3.2-vision).');
  const out = new Set();
  for (const [l, c] of chosen) if (c / (seen.get(l) || 1) >= 0.5 || c >= 2) out.add(l);
  return out;
}
