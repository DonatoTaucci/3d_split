// Splitting along the selection boundary with smooth "membrane" caps (no CSG needed).
import { extractFaces } from './meshdata.js';

/**
 * Boundary loops between selected (mask=1) and unselected faces, oriented like the
 * selected faces' half-edges (a -> b).
 * @returns {number[][]} loops of vertex ids
 */
export function boundaryLoops(mesh, mask) {
  const { tri, nf, heEdge, edgeHEStart, edgeHE } = mesh;
  const out = new Map(); // a -> [b...]
  let count = 0;
  for (let f = 0; f < nf; f++) {
    if (!mask[f]) continue;
    for (let k = 0; k < 3; k++) {
      const he = 3 * f + k;
      const e = heEdge[he];
      const s = edgeHEStart[e], t = edgeHEStart[e + 1];
      if (t - s !== 2) continue;
      const other = edgeHE[s] === he ? edgeHE[s + 1] : edgeHE[s];
      const g = (other / 3) | 0;
      if (mask[g]) continue;
      const a = tri[he], b = tri[3 * f + ((k + 1) % 3)];
      if (!out.has(a)) out.set(a, []);
      out.get(a).push(b);
      count++;
    }
  }
  const loops = [];
  while (count > 0) {
    let start = -1;
    for (const [a, list] of out) if (list.length) { start = a; break; }
    if (start < 0) break;
    const loop = [start];
    let cur = out.get(start).pop();
    count--;
    let guard = 0;
    while (cur !== start && guard++ < 1e7) {
      loop.push(cur);
      const list = out.get(cur);
      if (!list || !list.length) break; // open chain (should not happen on manifold input)
      cur = list.pop();
      count--;
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

/** Newell normal + centroid of a closed polyline */
export function loopFrame(P) {
  const n = P.length / 3;
  let nx = 0, ny = 0, nz = 0, cx = 0, cy = 0, cz = 0, L = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = P[3 * i], ay = P[3 * i + 1], az = P[3 * i + 2];
    const bx = P[3 * j], by = P[3 * j + 1], bz = P[3 * j + 2];
    nx += (ay - by) * (az + bz);
    ny += (az - bz) * (ax + bx);
    nz += (ax - bx) * (ay + by);
    const l = Math.hypot(bx - ax, by - ay, bz - az);
    cx += (ax + bx) * 0.5 * l; cy += (ay + by) * 0.5 * l; cz += (az + bz) * 0.5 * l;
    L += l;
  }
  const nl = Math.hypot(nx, ny, nz) || 1;
  return { normal: [nx / nl, ny / nl, nz / nl], centroid: [cx / L, cy / L, cz / L], perimeter: L, area: nl / 2 };
}

/**
 * Triangulate a disk spanning the loop with concentric rings, then relax it into a
 * smooth membrane. Triangles are oriented with the loop direction (a->b) i.e. they
 * pair with faces on the *other* side of the loop.
 * @param {Float64Array|number[]} P loop positions (3n)
 * @returns {{verts:number[], tris:number[]}} vertex ids < n refer to the loop, >= n to `verts`
 */
export function buildCap(P, targetLen) {
  const n = P.length / 3;
  const fr = loopFrame(P);
  const C = fr.centroid;
  // arclength params
  const s = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    s[i + 1] = s[i] + Math.hypot(P[3 * j] - P[3 * i], P[3 * j + 1] - P[3 * i + 1], P[3 * j + 2] - P[3 * i + 2]);
  }
  const S = s[n] || 1;
  const radius = S / (2 * Math.PI);
  const R = Math.max(1, Math.min(60, Math.round(radius / Math.max(targetLen, 1e-9))));
  const verts = [];
  const rings = []; // each: {ids:[], u:[]}
  rings.push({ ids: Array.from({ length: n }, (_, i) => i), u: Array.from({ length: n }, (_, i) => s[i] / S) });
  const pointAt = (u) => {
    const t = u * S;
    let lo = 0, hi = n;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (s[m] <= t) lo = m; else hi = m; }
    const i = lo, j = (lo + 1) % n;
    const seg = s[lo + 1] - s[lo] || 1;
    const w = (t - s[lo]) / seg;
    return [P[3 * i] + (P[3 * j] - P[3 * i]) * w, P[3 * i + 1] + (P[3 * j + 1] - P[3 * i + 1]) * w, P[3 * i + 2] + (P[3 * j + 2] - P[3 * i + 2]) * w];
  };
  for (let r = 1; r < R; r++) {
    const m = Math.max(3, Math.round((n * (R - r)) / R));
    if (m >= rings[rings.length - 1].ids.length && rings.length > 1) continue;
    const ids = [], u = [];
    const f = r / R;
    for (let k = 0; k < m; k++) {
      const uk = k / m;
      const q = pointAt(uk);
      ids.push(n + verts.length / 3);
      verts.push(q[0] + (C[0] - q[0]) * f, q[1] + (C[1] - q[1]) * f, q[2] + (C[2] - q[2]) * f);
      u.push(uk);
    }
    rings.push({ ids, u });
  }
  const centerId = n + verts.length / 3;
  verts.push(C[0], C[1], C[2]);
  const tris = [];
  for (let r = 0; r < rings.length; r++) {
    const O = rings[r];
    const isLast = r === rings.length - 1;
    if (isLast) {
      const m = O.ids.length;
      for (let i = 0; i < m; i++) tris.push(O.ids[i], O.ids[(i + 1) % m], centerId);
      break;
    }
    const I = rings[r + 1];
    const mo = O.ids.length, mi = I.ids.length;
    let i = 0, j = 0;
    while (i < mo || j < mi) {
      const uo = i + 1 <= mo ? (i + 1 < mo ? O.u[i + 1] : 1) : Infinity;
      const ui = j + 1 <= mi ? (j + 1 < mi ? I.u[j + 1] : 1) : Infinity;
      if (uo <= ui) {
        tris.push(O.ids[i % mo], O.ids[(i + 1) % mo], I.ids[j % mi]);
        i++;
      } else {
        tris.push(O.ids[i % mo], I.ids[(j + 1) % mi], I.ids[j % mi]);
        j++;
      }
    }
  }
  relaxCap(P, verts, tris, n);
  return { verts, tris, frame: fr };
}

function relaxCap(P, verts, tris, n, iters = 160) {
  const nv = verts.length / 3;
  if (!nv) return;
  const nbrs = Array.from({ length: nv }, () => new Set());
  for (let t = 0; t < tris.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = tris[t + k], b = tris[t + ((k + 1) % 3)];
      if (a >= n) nbrs[a - n].add(b);
      if (b >= n) nbrs[b - n].add(a);
    }
  }
  const adj = nbrs.map((s) => Array.from(s));
  const get = (id, k) => (id < n ? P[3 * id + k] : verts[3 * (id - n) + k]);
  for (let it = 0; it < iters; it++) {
    for (let v = 0; v < nv; v++) {
      const a = adj[v];
      if (!a.length) continue;
      let x = 0, y = 0, z = 0;
      for (const id of a) { x += get(id, 0); y += get(id, 1); z += get(id, 2); }
      const m = a.length;
      verts[3 * v] = verts[3 * v] * 0.2 + (x / m) * 0.8;
      verts[3 * v + 1] = verts[3 * v + 1] * 0.2 + (y / m) * 0.8;
      verts[3 * v + 2] = verts[3 * v + 2] * 0.2 + (z / m) * 0.8;
    }
  }
}

/** Membrane caps for every boundary loop of the selection (no piece meshes). */
export function computeCaps(mesh, mask) {
  const loops = boundaryLoops(mesh, mask);
  const target = mesh.avgEdgeLen * 1.5;
  const caps = loops.map((loop) => {
    const n = loop.length;
    const P = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) P[3 * i + k] = mesh.pos[3 * loop[i] + k];
    const cap = buildCap(P, target);
    const capPos = new Float64Array(n * 3 + cap.verts.length);
    capPos.set(P, 0);
    capPos.set(cap.verts, n * 3);
    // cap normal pointing from A into B = outward normal of A's (flipped) cap
    let nx = 0, ny = 0, nz = 0, area = 0;
    const T = cap.tris;
    for (let t = 0; t < T.length; t += 3) {
      const a = T[t], b = T[t + 2], c = T[t + 1];
      const ax = capPos[3 * a], ay = capPos[3 * a + 1], az = capPos[3 * a + 2];
      const ux = capPos[3 * b] - ax, uy = capPos[3 * b + 1] - ay, uz = capPos[3 * b + 2] - az;
      const vx = capPos[3 * c] - ax, vy = capPos[3 * c + 1] - ay, vz = capPos[3 * c + 2] - az;
      const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      nx += cx; ny += cy; nz += cz;
      area += 0.5 * Math.hypot(cx, cy, cz);
    }
    const nl = Math.hypot(nx, ny, nz) || 1;
    return {
      loop,
      loopPositions: P,
      capPositions: capPos,
      capTris: Uint32Array.from(T), // oriented like B's cap
      normal: [nx / nl, ny / nl, nz / nl], // A -> B
      centroid: cap.frame.centroid,
      perimeter: cap.frame.perimeter,
      area,
      newVerts: cap.verts,
    };
  });
  return caps.sort((a, b) => b.area - a.area);
}

/**
 * Split `mesh` into the selected faces (A) and the rest (B); every boundary loop is
 * closed on both pieces with the same membrane so they mate perfectly.
 */
export function splitByMask(mesh, mask, caps = null) {
  caps = caps || computeCaps(mesh, mask);
  const notMask = new Uint8Array(mesh.nf);
  for (let f = 0; f < mesh.nf; f++) notMask[f] = mask[f] ? 0 : 1;
  const A = extractFaces(mesh, mask);
  const B = extractFaces(mesh, notMask);
  let extraV = 0, extraT = 0;
  for (const c of caps) { extraV += c.newVerts.length / 3; extraT += c.capTris.length / 3; }
  const build = (piece, flip) => {
    const nv0 = piece.pos.length / 3, nt0 = piece.tri.length / 3;
    const pos = new Float32Array((nv0 + extraV) * 3);
    pos.set(piece.pos);
    const tri = new Uint32Array((nt0 + extraT) * 3);
    tri.set(piece.tri);
    let vo = nv0, to = nt0 * 3;
    for (const c of caps) {
      const n = c.loop.length;
      pos.set(c.newVerts, vo * 3);
      const base = vo;
      const map = (id) => (id < n ? piece.vmap[c.loop[id]] : base + id - n);
      const T = c.capTris;
      for (let t = 0; t < T.length; t += 3) {
        if (flip) { tri[to++] = map(T[t]); tri[to++] = map(T[t + 2]); tri[to++] = map(T[t + 1]); }
        else { tri[to++] = map(T[t]); tri[to++] = map(T[t + 1]); tri[to++] = map(T[t + 2]); }
      }
      vo += c.newVerts.length / 3;
    }
    return { pos, tri };
  };
  return { A: build(A, true), B: build(B, false), caps, loops: caps.length };
}

/** Fill every open boundary loop of the mesh (repair holes in scans). */
export function fillHoles(mesh, maxLoopFrac = 1) {
  const { tri, nf, heEdge, edgeHEStart } = mesh;
  const out = new Map();
  for (let f = 0; f < nf; f++) {
    for (let k = 0; k < 3; k++) {
      const he = 3 * f + k;
      const e = heEdge[he];
      if (edgeHEStart[e + 1] - edgeHEStart[e] !== 1) continue;
      // hole loop must run opposite to the face half-edge
      const a = tri[he], b = tri[3 * f + ((k + 1) % 3)];
      if (!out.has(b)) out.set(b, []);
      out.get(b).push(a);
    }
  }
  const loops = [];
  for (const [startV] of out) {
    const list = out.get(startV);
    while (list && list.length) {
      const loop = [startV];
      const at = new Map([[startV, 0]]);
      let cur = list.pop();
      let guard = 0;
      let closed = false;
      while (guard++ < 1e7) {
        if (at.has(cur)) {
          // revisited a vertex: the part after its first visit is a simple loop
          const j = at.get(cur);
          const sub = loop.splice(j);
          for (const v of sub) at.delete(v);
          if (sub.length >= 3) loops.push(sub);
          if (cur === startV && j === 0) { closed = true; break; }
        }
        at.set(cur, loop.length);
        loop.push(cur);
        const l2 = out.get(cur);
        if (!l2 || !l2.length) break;
        cur = l2.pop();
      }
      void closed;
    }
  }
  const pos = Array.from(mesh.pos);
  const tris = Array.from(mesh.tri);
  let filled = 0;
  const diag = mesh.bounds.diag;
  for (const loop of loops) {
    const n = loop.length;
    const P = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) P[3 * i + k] = mesh.pos[3 * loop[i] + k];
    const fr = loopFrame(P);
    if (fr.perimeter > diag * 4 * maxLoopFrac) continue;
    const cap = buildCap(P, mesh.avgEdgeLen * 1.5);
    const base = pos.length / 3;
    for (const v of cap.verts) pos.push(v);
    const map = (id) => (id < n ? loop[id] : base + id - n);
    for (let t = 0; t < cap.tris.length; t += 3) tris.push(map(cap.tris[t]), map(cap.tris[t + 1]), map(cap.tris[t + 2]));
    filled++;
  }
  return { pos: Float32Array.from(pos), tri: Uint32Array.from(tris), filled, loops: loops.length };
}

/** Make face orientation consistent per component and outward (positive volume). */
export function orientConsistently(mesh) {
  const { nf, tri, faceLinkStart, faceLinks, linkE, edgeV } = mesh;
  const out = Uint32Array.from(tri);
  const visited = new Uint8Array(nf);
  const flip = new Uint8Array(nf);
  const stack = [];
  const hasDirected = (f, a, b) => {
    const t = out;
    for (let k = 0; k < 3; k++) if (t[3 * f + k] === a && t[3 * f + ((k + 1) % 3)] === b) return true;
    return false;
  };
  let flips = 0;
  for (let s = 0; s < nf; s++) {
    if (visited[s]) continue;
    visited[s] = 1;
    stack.push(s);
    const compFaces = [];
    while (stack.length) {
      const f = stack.pop();
      compFaces.push(f);
      for (let i = faceLinkStart[f]; i < faceLinkStart[f + 1]; i++) {
        const l = faceLinks[i];
        const g = mesh.other(l, f);
        if (visited[g]) continue;
        const e = linkE[l];
        if (mesh.edgeHEStart[e + 1] - mesh.edgeHEStart[e] !== 2) continue; // only across manifold edges
        const a = edgeV[2 * e], b = edgeV[2 * e + 1];
        // consistent if f has a->b and g has b->a (or vice versa)
        const fab = hasDirected(f, a, b);
        const gab = hasDirected(g, a, b);
        if (fab === gab) {
          const t0 = out[3 * g + 1];
          out[3 * g + 1] = out[3 * g + 2];
          out[3 * g + 2] = t0;
          flip[g] ^= 1;
          flips++;
        }
        visited[g] = 1;
        stack.push(g);
      }
    }
    // outward: signed volume of this component
    let vol = 0;
    const p = mesh.pos;
    for (const f of compFaces) {
      const a = 3 * out[3 * f], b = 3 * out[3 * f + 1], c = 3 * out[3 * f + 2];
      vol += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
    }
    if (vol < 0) {
      for (const f of compFaces) {
        const t0 = out[3 * f + 1];
        out[3 * f + 1] = out[3 * f + 2];
        out[3 * f + 2] = t0;
      }
      flips += compFaces.length;
    }
  }
  return { tri: out, flips };
}
