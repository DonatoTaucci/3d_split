// Fast 3MF reader: scans the XML bytes directly (no DOM), so 100+ MB models load quickly.
// Supports multiple objects, components (with transforms), build items and the
// production extension (objects stored in separate .model files).
import { unzipSync } from 'fflate';

const LT = 60, GT = 62, SLASH = 47, QUOTE = 34, APOS = 39, EQ = 61, COLON = 58;

function isSpace(c) {
  return c === 32 || c === 9 || c === 10 || c === 13;
}

function parseNumber(b, s, e) {
  let i = s, sign = 1, v = 0;
  if (b[i] === 45) { sign = -1; i++; } else if (b[i] === 43) i++;
  while (i < e && b[i] >= 48 && b[i] <= 57) { v = v * 10 + (b[i] - 48); i++; }
  if (i < e && b[i] === 46) {
    i++;
    let f = 0, scale = 1;
    while (i < e && b[i] >= 48 && b[i] <= 57) { f = f * 10 + (b[i] - 48); scale *= 10; i++; }
    v += f / scale;
  }
  if (i < e && (b[i] === 101 || b[i] === 69)) {
    i++;
    let es = 1, ev = 0;
    if (b[i] === 45) { es = -1; i++; } else if (b[i] === 43) i++;
    while (i < e && b[i] >= 48 && b[i] <= 57) { ev = ev * 10 + (b[i] - 48); i++; }
    v *= Math.pow(10, es * ev);
  }
  return sign * v;
}

const dec = new TextDecoder();

class Growable {
  constructor(Type, n = 1 << 16) { this.T = Type; this.a = new Type(n); this.n = 0; }
  push3(x, y, z) {
    if (this.n + 3 > this.a.length) { const b = new this.T(this.a.length * 2); b.set(this.a); this.a = b; }
    this.a[this.n++] = x; this.a[this.n++] = y; this.a[this.n++] = z;
  }
  done() { return this.a.slice(0, this.n); }
}

/** parse one .model file; returns {objects: Map, items: [], unit} */
function parseModelBytes(b, path) {
  const objects = new Map();
  const items = [];
  let unit = 'millimeter';
  let cur = null;
  const len = b.length;
  let i = 0;
  const attrs = {};
  while (i < len) {
    // next tag
    while (i < len && b[i] !== LT) i++;
    if (i >= len) break;
    i++;
    if (b[i] === 63 || b[i] === 33) { // <? or <! (comments / declarations)
      while (i < len && b[i] !== GT) i++;
      continue;
    }
    let closing = false;
    if (b[i] === SLASH) { closing = true; i++; }
    const ns = i;
    while (i < len && !isSpace(b[i]) && b[i] !== GT && b[i] !== SLASH) i++;
    let nameStart = ns;
    for (let k = ns; k < i; k++) if (b[k] === COLON) nameStart = k + 1;
    const nlen = i - nameStart;
    const c0 = b[nameStart];
    // identify the few tags we care about by first char + length
    let tag = '';
    if (c0 === 118 && nlen === 6) tag = 'vertex';
    else if (c0 === 116 && nlen === 8) tag = 'triangle';
    else if (c0 === 111 && nlen === 6) tag = 'object';
    else if (c0 === 99 && nlen === 9) tag = 'component';
    else if (c0 === 105 && nlen === 4) tag = 'item';
    else if (c0 === 109 && nlen === 5) tag = 'model';
    if (closing) {
      if (tag === 'object') cur = null;
      while (i < len && b[i] !== GT) i++;
      continue;
    }
    if (!tag) { while (i < len && b[i] !== GT) i++; continue; }
    if (tag === 'vertex' || tag === 'triangle') {
      // fast attribute scan for numeric attributes
      let x = 0, y = 0, z = 0;
      while (i < len && b[i] !== GT) {
        while (i < len && isSpace(b[i])) i++;
        if (b[i] === SLASH || b[i] === GT) break;
        const as = i;
        while (i < len && b[i] !== EQ) i++;
        const alen = i - as;
        const a0 = b[as], a1 = b[as + 1];
        i++;
        const q = b[i];
        i++;
        const vs = i;
        while (i < len && b[i] !== q) i++;
        const ve = i;
        i++;
        if (tag === 'vertex' && alen === 1) {
          if (a0 === 120) x = parseNumber(b, vs, ve);
          else if (a0 === 121) y = parseNumber(b, vs, ve);
          else if (a0 === 122) z = parseNumber(b, vs, ve);
        } else if (tag === 'triangle' && alen === 2 && a0 === 118) {
          if (a1 === 49) x = parseNumber(b, vs, ve);
          else if (a1 === 50) y = parseNumber(b, vs, ve);
          else if (a1 === 51) z = parseNumber(b, vs, ve);
        }
      }
      while (i < len && b[i] !== GT) i++;
      if (!cur) continue;
      if (tag === 'vertex') cur.v.push3(x, y, z); else cur.t.push3(x, y, z);
      continue;
    }
    // generic attribute parse (rare tags)
    for (const k in attrs) delete attrs[k];
    let selfClose = false;
    while (i < len && b[i] !== GT) {
      while (i < len && isSpace(b[i])) i++;
      if (b[i] === SLASH) { selfClose = true; i++; continue; }
      if (b[i] === GT) break;
      const as = i;
      while (i < len && b[i] !== EQ && !isSpace(b[i]) && b[i] !== GT) i++;
      let name = dec.decode(b.subarray(as, i));
      const ci = name.indexOf(':');
      if (ci >= 0 && !name.startsWith('xmlns')) name = name.slice(ci + 1);
      while (i < len && b[i] !== QUOTE && b[i] !== APOS && b[i] !== GT) i++;
      if (b[i] === GT) break;
      const q = b[i];
      i++;
      const vs = i;
      while (i < len && b[i] !== q) i++;
      attrs[name] = dec.decode(b.subarray(vs, i));
      i++;
    }
    if (tag === 'model') { if (attrs.unit) unit = attrs.unit; }
    else if (tag === 'object') {
      cur = { id: attrs.id, name: attrs.name || '', v: new Growable(Float32Array), t: new Growable(Uint32Array), components: [], path };
      objects.set(attrs.id, cur);
      if (selfClose) cur = null;
    } else if (tag === 'component' && cur) {
      cur.components.push({ objectid: attrs.objectid, transform: parseTransform(attrs.transform), path: attrs.path || null });
    } else if (tag === 'item') {
      items.push({ objectid: attrs.objectid, transform: parseTransform(attrs.transform), path: attrs.path || null });
    }
  }
  return { objects, items, unit };
}

function parseTransform(s) {
  if (!s) return null;
  const m = s.trim().split(/\s+/).map(Number);
  return m.length === 12 ? m : null;
}

// 3MF matrices are row-vector 4x3: x' = x*m0 + y*m3 + z*m6 + m9 ...
function mul(a, b) {
  // apply a then b
  if (!a) return b;
  if (!b) return a;
  const r = new Array(12);
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 3; col++) {
      let v = 0;
      for (let k = 0; k < 3; k++) v += a[row * 3 + k] * b[k * 3 + col];
      if (row === 3) v += b[9 + col];
      r[row * 3 + col] = v;
    }
  }
  return r;
}

const UNIT_SCALE = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 };

/**
 * @returns {{name, positions: Float32Array, indices: Uint32Array, groups: null, color: null}[]}
 */
export function parse3MF(buffer) {
  const files = unzipSync(new Uint8Array(buffer), { filter: (f) => f.name.toLowerCase().endsWith('.model') });
  const names = Object.keys(files);
  if (!names.length) throw new Error('3MF non valido: nessun file .model');
  const root = names.find((n) => /^\/?3d\/3dmodel\.model$/i.test(n)) || names[0];
  const models = new Map();
  for (const n of names) {
    const key = '/' + n.replace(/^\//, '');
    models.set(key.toLowerCase(), parseModelBytes(files[n], key));
    files[n] = null; // free memory early
  }
  const rootKey = ('/' + root.replace(/^\//, '')).toLowerCase();
  const rootModel = models.get(rootKey);
  const scale = UNIT_SCALE[rootModel.unit] ?? 1;
  const getObj = (path, id) => models.get((path || rootKey).toLowerCase())?.objects.get(id) || rootModel.objects.get(id);

  const out = [];
  const collect = (obj, T, acc, depth = 0) => {
    if (!obj || depth > 16) return;
    if (obj.t.n) acc.push({ obj, T });
    for (const c of obj.components) collect(getObj(c.path || obj.path, c.objectid), mul(c.transform, T), acc, depth + 1);
  };
  let items = rootModel.items;
  if (!items.length) items = [...rootModel.objects.values()].filter((o) => o.t.n).map((o) => ({ objectid: o.id, transform: null }));
  items.forEach((it, idx) => {
    const obj = getObj(it.path, it.objectid);
    const acc = [];
    collect(obj, it.transform, acc);
    if (!acc.length) return;
    let nv = 0, nt = 0;
    for (const a of acc) { nv += a.obj.v.n / 3; nt += a.obj.t.n / 3; }
    const positions = new Float32Array(nv * 3);
    const indices = new Uint32Array(nt * 3);
    let vo = 0, to = 0;
    for (const a of acc) {
      const V = a.obj.v.a, n = a.obj.v.n / 3, T = a.T;
      for (let k = 0; k < n; k++) {
        let x = V[3 * k], y = V[3 * k + 1], z = V[3 * k + 2];
        if (T) {
          const X = x * T[0] + y * T[3] + z * T[6] + T[9];
          const Y = x * T[1] + y * T[4] + z * T[7] + T[10];
          const Z = x * T[2] + y * T[5] + z * T[8] + T[11];
          x = X; y = Y; z = Z;
        }
        positions[3 * (vo + k)] = x * scale;
        positions[3 * (vo + k) + 1] = y * scale;
        positions[3 * (vo + k) + 2] = z * scale;
      }
      const Tr = a.obj.t.a, m = a.obj.t.n;
      for (let k = 0; k < m; k++) indices[to + k] = Tr[k] + vo;
      vo += n;
      to += m;
    }
    out.push({ name: obj.name || `Oggetto ${idx + 1}`, positions, indices, groups: null, color: null });
  });
  return out;
}
