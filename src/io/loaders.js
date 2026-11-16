// File import: STL, OBJ, 3MF, PLY, GLB/GLTF, OFF, STEP/IGES/BREP (via occt-import-js WASM).
import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js';
import { parse3MF } from './threemf.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import occtJsUrl from 'occt-import-js/dist/occt-import-js.js?url';
import occtWasmUrl from 'occt-import-js/dist/occt-import-js.wasm?url';

export const ACCEPTED = '.stl,.obj,.3mf,.ply,.glb,.gltf,.off,.step,.stp,.iges,.igs,.brep,.brp';

// Formats whose convention is Z-up (displayed rotated so that Z points up)
const Z_UP = new Set(['stl', '3mf', 'ply', 'off', 'step', 'stp', 'iges', 'igs', 'brep', 'brp']);

/**
 * @typedef {{name:string, positions:Float32Array, indices:Uint32Array|null, groups:Int32Array|null, color:number[]|null}} RawMesh
 * @returns {Promise<{meshes: RawMesh[], zUp: boolean, format: string}>}
 */
export async function loadModelFile(file, onProgress = () => {}) {
  const name = file.name;
  const ext = name.split('.').pop().toLowerCase();
  const buf = await file.arrayBuffer();
  return loadModelBuffer(buf, name, ext, onProgress);
}

export async function loadModelBuffer(buf, name, ext, onProgress = () => {}) {
  let meshes;
  switch (ext) {
    case 'stl': {
      const g = new STLLoader().parse(buf);
      meshes = [geometryToRaw(g, baseName(name))];
      break;
    }
    case 'obj': {
      const text = new TextDecoder().decode(buf);
      meshes = objectToRaw(new OBJLoader().parse(text));
      break;
    }
    case '3mf': {
      try {
        meshes = parse3MF(buf);
      } catch (e) {
        console.warn('fast 3MF parser failed, falling back to three.js loader', e);
        meshes = objectToRaw(new ThreeMFLoader().parse(buf));
      }
      if (meshes.length > 64) meshes = [mergeRaw(meshes, 'Modello')];
      break;
    }
    case 'ply': {
      const g = new PLYLoader().parse(buf);
      meshes = [geometryToRaw(g, baseName(name))];
      break;
    }
    case 'glb':
    case 'gltf': {
      const gltf = await new GLTFLoader().parseAsync(buf, '');
      meshes = objectToRaw(gltf.scene);
      break;
    }
    case 'off':
      meshes = [parseOFF(new TextDecoder().decode(buf), baseName(name))];
      break;
    case 'step':
    case 'stp':
    case 'iges':
    case 'igs':
    case 'brep':
    case 'brp':
      onProgress('Caricamento motore CAD (OpenCascade)…');
      meshes = await loadCAD(new Uint8Array(buf), ext);
      break;
    default:
      throw new Error(`Formato non supportato: .${ext}`);
  }
  meshes = meshes.filter((m) => m.positions.length >= 9);
  if (!meshes.length) throw new Error('Il file non contiene triangoli.');
  return { meshes, zUp: Z_UP.has(ext), format: ext };
}

function baseName(n) {
  return n.replace(/\.[^.]+$/, '');
}

function geometryToRaw(g, name, matrix = null) {
  g = g.clone();
  if (matrix) g.applyMatrix4(matrix);
  const pos = g.getAttribute('position');
  const positions = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    positions[3 * i] = pos.getX(i);
    positions[3 * i + 1] = pos.getY(i);
    positions[3 * i + 2] = pos.getZ(i);
  }
  let indices = null;
  if (g.index) indices = new Uint32Array(g.index.array);
  const ntri = indices ? indices.length / 3 : pos.count / 3;
  let groups = null;
  if (g.groups && g.groups.length > 1) {
    groups = new Int32Array(ntri);
    g.groups.forEach((gr, gi) => {
      const a = Math.floor(gr.start / 3), b = Math.min(ntri, Math.floor((gr.start + gr.count) / 3));
      for (let t = a; t < b; t++) groups[t] = gi;
    });
  }
  return { name, positions, indices, groups, color: null };
}

function objectToRaw(root) {
  root.updateMatrixWorld(true);
  const out = [];
  let idx = 0;
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry?.getAttribute('position')) return;
    const r = geometryToRaw(o.geometry, o.name || `Oggetto ${++idx}`, o.matrixWorld);
    const mat = Array.isArray(o.material) ? o.material[0] : o.material;
    if (mat?.color) r.color = [mat.color.r, mat.color.g, mat.color.b];
    out.push(r);
  });
  if (out.length > 64) {
    // too many objects: merge into one with per-object groups
    return [mergeRaw(out, 'Modello')];
  }
  return out;
}

export function mergeRaw(list, name) {
  let nv = 0, nt = 0;
  for (const m of list) {
    nv += m.positions.length / 3;
    nt += m.indices ? m.indices.length / 3 : m.positions.length / 9;
  }
  const positions = new Float32Array(nv * 3);
  const indices = new Uint32Array(nt * 3);
  const groups = new Int32Array(nt);
  let vo = 0, to = 0;
  list.forEach((m, gi) => {
    positions.set(m.positions, vo * 3);
    const n = m.positions.length / 3;
    const tcount = m.indices ? m.indices.length / 3 : n / 3;
    for (let t = 0; t < tcount; t++) {
      for (let k = 0; k < 3; k++) indices[3 * (to + t) + k] = vo + (m.indices ? m.indices[3 * t + k] : 3 * t + k);
      groups[to + t] = gi;
    }
    vo += n;
    to += tcount;
  });
  return { name, positions, indices, groups, color: null };
}

function parseOFF(text, name) {
  const tokens = text.replace(/#.*$/gm, '').split(/\s+/).filter(Boolean);
  let i = 0;
  if (/^C?OFF$/i.test(tokens[0])) i++;
  const nv = +tokens[i++], nf = +tokens[i++];
  i++;
  const positions = new Float32Array(nv * 3);
  for (let v = 0; v < nv; v++) for (let k = 0; k < 3; k++) positions[3 * v + k] = +tokens[i++];
  const idx = [];
  for (let f = 0; f < nf; f++) {
    const n = +tokens[i++];
    const vs = [];
    for (let k = 0; k < n; k++) vs.push(+tokens[i++]);
    for (let k = 1; k + 1 < n; k++) idx.push(vs[0], vs[k], vs[k + 1]);
  }
  return { name, positions, indices: new Uint32Array(idx), groups: null, color: null };
}

let occtPromise = null;
function getOcct() {
  if (!occtPromise) {
    occtPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = occtJsUrl;
      s.onload = () => {
        // eslint-disable-next-line no-undef
        window.occtimportjs({ locateFile: () => occtWasmUrl }).then(resolve, reject);
      };
      s.onerror = () => reject(new Error('Impossibile caricare il motore CAD'));
      document.head.appendChild(s);
    });
  }
  return occtPromise;
}

async function loadCAD(bytes, ext) {
  const occt = await getOcct();
  const params = { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', linearDeflection: 0.001, angularDeflection: 0.35 };
  let res;
  if (ext === 'step' || ext === 'stp') res = occt.ReadStepFile(bytes, params);
  else if (ext === 'iges' || ext === 'igs') res = occt.ReadIgesFile(bytes, params);
  else res = occt.ReadBrepFile(bytes, params);
  if (!res || !res.success) throw new Error('Lettura del file CAD non riuscita');
  return res.meshes.map((m, i) => {
    const positions = new Float32Array(m.attributes.position.array);
    const indices = new Uint32Array(m.index.array);
    const ntri = indices.length / 3;
    const groups = new Int32Array(ntri);
    (m.brep_faces || []).forEach((bf, fi) => {
      for (let t = bf.first; t <= bf.last && t < ntri; t++) groups[t] = fi;
    });
    return { name: m.name || `Corpo ${i + 1}`, positions, indices, groups: m.brep_faces?.length ? groups : null, color: m.color || null };
  });
}

/** Units guess: most print files are millimetres; tiny models are probably metres/inches. */
export function guessScaleHint(diag) {
  if (diag < 5) return 'Il modello è molto piccolo: forse è in metri o pollici?';
  return null;
}

export { THREE };
