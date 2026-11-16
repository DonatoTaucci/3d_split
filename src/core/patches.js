// Surface analysis: concavity-aware link affinities, super-face patches and the patch graph.
import { MinHeap } from './heap.js';

/**
 * Per-link boundary strength ("barrier") and affinity based on concavity
 * (minima rule: parts meet along concave creases).
 */
export function computeAffinity(mesh, opts = {}) {
  const b0 = opts.b0 ?? 0.4; // radians: concavity scale
  const { nf, nl, linkF, linkLen, linkAngle, faceLinkStart, faceLinks } = mesh;
  // signed face concavity field: length-weighted average of incident link angles
  let fc = new Float32Array(nf);
  for (let f = 0; f < nf; f++) {
    let s = 0, w = 0;
    for (let i = faceLinkStart[f]; i < faceLinkStart[f + 1]; i++) {
      const l = faceLinks[i];
      s += linkAngle[l] * linkLen[l];
      w += linkLen[l];
    }
    fc[f] = w > 0 ? s / w : 0;
  }
  // smooth the field a few iterations (gives valley floors on rounded creases)
  let tmp = new Float32Array(nf);
  const iters = opts.smoothIters ?? 4;
  for (let it = 0; it < iters; it++) {
    for (let f = 0; f < nf; f++) {
      let s = 0, c = 0;
      for (let i = faceLinkStart[f]; i < faceLinkStart[f + 1]; i++) {
        s += fc[mesh.other(faceLinks[i], f)];
        c++;
      }
      tmp[f] = c ? 0.5 * fc[f] + 0.5 * (s / c) : fc[f];
    }
    const t = fc; fc = tmp; tmp = t;
  }
  const barrier = new Float32Array(nl);
  const affinity = new Float32Array(nl);
  for (let l = 0; l < nl; l++) {
    const a = linkAngle[l] > 0 ? linkAngle[l] : 0;
    const sm = 0.5 * (fc[linkF[2 * l]] + fc[linkF[2 * l + 1]]);
    const b = Math.max(a, sm > 0 ? 2.5 * sm : 0);
    barrier[l] = b;
    const r = b / b0;
    affinity[l] = Math.exp(-r * r);
  }
  return { barrier, affinity, faceConcavity: fc };
}

/**
 * Cluster faces into roughly uniform patches whose borders prefer concave creases.
 * @returns {{patchOf: Int32Array, numPatches: number}}
 */
export function buildPatches(mesh, aff, opts = {}) {
  const { nf, faceCenter: C, faceArea, faceLinkStart, faceLinks, linkF, faceGroup } = mesh;
  const target = Math.max(1, Math.min(nf, opts.targetPatches ?? Math.round(Math.min(4000, Math.max(300, nf / 30)))));
  const avgArea = mesh.totalArea / target;
  const rho = Math.sqrt(avgArea) * 1.25;
  const bmin = mesh.bounds.min;
  // grid seeding: one seed face per occupied cell (closest to the cell center)
  const cells = new Map();
  for (let f = 0; f < nf; f++) {
    const x = C[3 * f], y = C[3 * f + 1], z = C[3 * f + 2];
    const ix = Math.floor((x - bmin[0]) / rho), iy = Math.floor((y - bmin[1]) / rho), iz = Math.floor((z - bmin[2]) / rho);
    const key = (ix * 4096 + iy) * 4096 + iz;
    const dx = x - (bmin[0] + (ix + 0.5) * rho), dy = y - (bmin[1] + (iy + 0.5) * rho), dz = z - (bmin[2] + (iz + 0.5) * rho);
    const d = dx * dx + dy * dy + dz * dz;
    const cur = cells.get(key);
    if (cur === undefined || d < cur[1]) cells.set(key, [f, d]);
  }
  const label = new Int32Array(nf).fill(-1);
  const dist = new Float64Array(nf).fill(Infinity);
  const heap = new MinHeap(Math.max(1024, nf));
  let np = 0;
  for (const [, v] of cells) {
    const f = v[0];
    label[f] = np++;
    dist[f] = 0;
    heap.push(f, 0);
  }
  const affinity = aff.affinity;
  const run = () => {
    while (heap.size) {
      const f = heap.pop();
      const df = heap.lastKey;
      if (df > dist[f]) continue;
      const fx = C[3 * f], fy = C[3 * f + 1], fz = C[3 * f + 2];
      for (let i = faceLinkStart[f]; i < faceLinkStart[f + 1]; i++) {
        const l = faceLinks[i];
        const g = linkF[2 * l] === f ? linkF[2 * l + 1] : linkF[2 * l];
        if (faceGroup && faceGroup[g] !== faceGroup[f]) continue;
        const dx = C[3 * g] - fx, dy = C[3 * g + 1] - fy, dz = C[3 * g + 2] - fz;
        const nd = df + Math.sqrt(dx * dx + dy * dy + dz * dz) * (1 + 6 * (1 - affinity[l]));
        if (nd < dist[g]) {
          dist[g] = nd;
          label[g] = label[f];
          heap.push(g, nd);
        }
      }
    }
  };
  run();
  // faces not reached (tiny components / isolated groups): seed them
  for (let f = 0; f < nf; f++) {
    if (label[f] !== -1) continue;
    label[f] = np++;
    dist[f] = 0;
    heap.push(f, 0);
    run();
  }
  // merge tiny patches into their best neighbour
  const area = new Float64Array(np);
  for (let f = 0; f < nf; f++) area[label[f]] += faceArea[f];
  const parent = new Int32Array(np);
  for (let i = 0; i < np; i++) parent[i] = i;
  const find = (x) => {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  };
  const minArea = avgArea * 0.25;
  const small = [];
  for (let p = 0; p < np; p++) if (area[p] < minArea) small.push(p);
  if (small.length) {
    // neighbour weights per small patch
    const nbrW = new Map();
    const isSmall = new Uint8Array(np);
    for (const p of small) { isSmall[p] = 1; nbrW.set(p, new Map()); }
    for (let l = 0; l < mesh.nl; l++) {
      const pa = label[linkF[2 * l]], pb = label[linkF[2 * l + 1]];
      if (pa === pb) continue;
      if (faceGroup && faceGroup[linkF[2 * l]] !== faceGroup[linkF[2 * l + 1]]) continue;
      const w = mesh.linkLen[l] * (0.05 + affinity[l]);
      if (isSmall[pa]) { const m = nbrW.get(pa); m.set(pb, (m.get(pb) || 0) + w); }
      if (isSmall[pb]) { const m = nbrW.get(pb); m.set(pa, (m.get(pa) || 0) + w); }
    }
    small.sort((a, b) => area[a] - area[b]);
    for (const p of small) {
      const rp = find(p);
      if (area[rp] >= minArea) continue;
      let best = -1, bw = -1;
      for (const [q, w] of nbrW.get(p)) {
        const rq = find(q);
        if (rq !== rp && w > bw) { bw = w; best = rq; }
      }
      if (best >= 0) {
        parent[rp] = best;
        area[best] += area[rp];
      }
    }
  }
  const remap = new Int32Array(np).fill(-1);
  let n2 = 0;
  for (let p = 0; p < np; p++) {
    const r = find(p);
    if (remap[r] === -1) remap[r] = n2++;
  }
  const patchOf = new Int32Array(nf);
  for (let f = 0; f < nf; f++) patchOf[f] = remap[find(label[f])];
  return { patchOf, numPatches: n2 };
}

/**
 * Weighted graph of patches. Edge weight = shared border length x concavity affinity
 * (at both face scale and patch scale).
 */
export class PatchGraph {
  constructor(mesh, aff, patchOf, numPatches, opts = {}) {
    const phi0 = opts.phi0 ?? 0.6;
    const P = numPatches;
    this.n = P;
    this.patchOf = patchOf;
    const { nf, faceArea, faceNormal: N, faceCenter: C, linkF, linkLen, nl } = mesh;
    const area = new Float64Array(P);
    const cen = new Float64Array(P * 3);
    const nrm = new Float64Array(P * 3);
    const fcount = new Int32Array(P + 1);
    for (let f = 0; f < nf; f++) {
      const p = patchOf[f], a = faceArea[f];
      area[p] += a;
      cen[3 * p] += C[3 * f] * a; cen[3 * p + 1] += C[3 * f + 1] * a; cen[3 * p + 2] += C[3 * f + 2] * a;
      nrm[3 * p] += N[3 * f] * a; nrm[3 * p + 1] += N[3 * f + 1] * a; nrm[3 * p + 2] += N[3 * f + 2] * a;
      fcount[p + 1]++;
    }
    for (let p = 0; p < P; p++) {
      const a = area[p] || 1;
      cen[3 * p] /= a; cen[3 * p + 1] /= a; cen[3 * p + 2] /= a;
      const l = Math.hypot(nrm[3 * p], nrm[3 * p + 1], nrm[3 * p + 2]) || 1;
      nrm[3 * p] /= l; nrm[3 * p + 1] /= l; nrm[3 * p + 2] /= l;
      fcount[p + 1] += fcount[p];
    }
    const faces = new Int32Array(nf);
    const fill = fcount.slice(0, P);
    for (let f = 0; f < nf; f++) faces[fill[patchOf[f]]++] = f;
    this.area = area;
    this.centroid = cen;
    this.normal = nrm;
    this.faceStart = fcount;
    this.faces = faces;

    // adjacency accumulation
    const acc = new Map();
    for (let l = 0; l < nl; l++) {
      const a = patchOf[linkF[2 * l]], b = patchOf[linkF[2 * l + 1]];
      if (a === b) continue;
      const lo = a < b ? a : b, hi = a < b ? b : a;
      const key = lo * P + hi;
      let e = acc.get(key);
      if (!e) { e = [0, 0]; acc.set(key, e); }
      e[0] += linkLen[l];
      e[1] += linkLen[l] * aff.affinity[l];
    }
    const ne = acc.size;
    const ea = new Int32Array(ne), eb = new Int32Array(ne);
    const ew = new Float64Array(ne), elen = new Float64Array(ne), econc = new Float32Array(ne);
    let i = 0;
    const minW = 1e-4 * (mesh.avgEdgeLen || 1);
    for (const [key, v] of acc) {
      const lo = Math.floor(key / P), hi = key - lo * P;
      ea[i] = lo; eb[i] = hi;
      elen[i] = v[0];
      // patch-scale concavity
      const n0x = nrm[3 * lo], n0y = nrm[3 * lo + 1], n0z = nrm[3 * lo + 2];
      const n1x = nrm[3 * hi], n1y = nrm[3 * hi + 1], n1z = nrm[3 * hi + 2];
      let d = n0x * n1x + n0y * n1y + n0z * n1z;
      d = d > 1 ? 1 : d < -1 ? -1 : d;
      const th = Math.acos(d);
      const s = (cen[3 * hi] - cen[3 * lo]) * (n0x - n1x) + (cen[3 * hi + 1] - cen[3 * lo + 1]) * (n0y - n1y) +
        (cen[3 * hi + 2] - cen[3 * lo + 2]) * (n0z - n1z);
      const conc = s > 0 ? th : 0;
      econc[i] = s > 0 ? th : -th;
      const r = conc / phi0;
      const pf = Math.exp(-r * r);
      ew[i] = Math.max(minW, v[1] * pf);
      i++;
    }
    this.edgeA = ea; this.edgeB = eb; this.edgeW = ew; this.edgeLen = elen; this.edgeConc = econc;
    this.ne = ne;
    this._buildCSR();
    this._components();
  }

  _buildCSR() {
    const { n, ne, edgeA, edgeB, edgeW } = this;
    const start = new Int32Array(n + 1);
    for (let e = 0; e < ne; e++) { start[edgeA[e] + 1]++; start[edgeB[e] + 1]++; }
    for (let i = 0; i < n; i++) start[i + 1] += start[i];
    const nbr = new Int32Array(2 * ne), w = new Float64Array(2 * ne), eid = new Int32Array(2 * ne);
    const fill = start.slice(0, n);
    for (let e = 0; e < ne; e++) {
      let k = fill[edgeA[e]]++; nbr[k] = edgeB[e]; w[k] = edgeW[e]; eid[k] = e;
      k = fill[edgeB[e]]++; nbr[k] = edgeA[e]; w[k] = edgeW[e]; eid[k] = e;
    }
    const deg = new Float64Array(n);
    for (let i = 0; i < n; i++) for (let k = start[i]; k < start[i + 1]; k++) deg[i] += w[k];
    this.start = start; this.nbr = nbr; this.w = w; this.eid = eid; this.deg = deg;
  }

  _components() {
    const { n, start, nbr } = this;
    const comp = new Int32Array(n).fill(-1);
    const stack = new Int32Array(n);
    let nc = 0;
    const compArea = [];
    for (let s = 0; s < n; s++) {
      if (comp[s] !== -1) continue;
      let sp = 0, a = 0;
      stack[sp++] = s; comp[s] = nc;
      while (sp) {
        const i = stack[--sp];
        a += this.area[i];
        for (let k = start[i]; k < start[i + 1]; k++) {
          const j = nbr[k];
          if (comp[j] === -1) { comp[j] = nc; stack[sp++] = j; }
        }
      }
      compArea.push(a);
      nc++;
    }
    this.comp = comp;
    this.numComp = nc;
    this.compArea = compArea;
  }

  /** face mask (Uint8Array nf) from a patch mask */
  toFaceMask(patchMask, nf, out = null) {
    const m = out || new Uint8Array(nf);
    if (out) m.fill(0);
    for (let p = 0; p < this.n; p++) {
      if (!patchMask[p]) continue;
      for (let k = this.faceStart[p]; k < this.faceStart[p + 1]; k++) m[this.faces[k]] = 1;
    }
    return m;
  }
}

export function analyzeMesh(mesh, opts = {}) {
  const aff = computeAffinity(mesh, opts);
  const { patchOf, numPatches } = buildPatches(mesh, aff, opts);
  const graph = new PatchGraph(mesh, aff, patchOf, numPatches, opts);
  return { aff, graph };
}
