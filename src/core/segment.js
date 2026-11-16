// Segmentation algorithms on the patch graph and face level.
import { MinHeap } from './heap.js';

// ---------------------------------------------------------------------------
// Linear algebra helpers on (sub)graphs
// ---------------------------------------------------------------------------

/** Local CSR subgraph for a list of global node ids */
export function subgraph(graph, nodes) {
  const n = nodes.length;
  const loc = new Map();
  for (let i = 0; i < n; i++) loc.set(nodes[i], i);
  const start = new Int32Array(n + 1);
  const nbrList = [];
  const wList = [];
  for (let i = 0; i < n; i++) {
    const g = nodes[i];
    for (let k = graph.start[g]; k < graph.start[g + 1]; k++) {
      const j = loc.get(graph.nbr[k]);
      if (j !== undefined) { nbrList.push(j); wList.push(graph.w[k]); }
    }
    start[i + 1] = nbrList.length;
  }
  const nbr = Int32Array.from(nbrList);
  const w = Float64Array.from(wList);
  const deg = new Float64Array(n);
  const area = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    for (let k = start[i]; k < start[i + 1]; k++) deg[i] += w[k];
    area[i] = graph.area[nodes[i]];
  }
  return { n, nodes, start, nbr, w, deg, area, loc };
}

/**
 * Preconditioned CG for (a*D - b*W) x = rhs   (b=1,a=1 => graph Laplacian)
 * Optional `project(x)` removes null-space components.
 */
function cgSolve(sg, a, b, rhs, opts = {}) {
  const { n, start, nbr, w, deg } = sg;
  const maxIt = opts.maxIt ?? 400;
  const tol = opts.tol ?? 1e-7;
  const reg = opts.reg ?? 0;
  const x = new Float64Array(n);
  const r = Float64Array.from(rhs);
  const z = new Float64Array(n);
  const p = new Float64Array(n);
  const Ap = new Float64Array(n);
  const diag = new Float64Array(n);
  for (let i = 0; i < n; i++) diag[i] = a * deg[i] + reg || 1;
  let rr0 = 0;
  for (let i = 0; i < n; i++) rr0 += r[i] * r[i];
  if (rr0 === 0) return x;
  for (let i = 0; i < n; i++) { z[i] = r[i] / diag[i]; p[i] = z[i]; }
  let rz = 0;
  for (let i = 0; i < n; i++) rz += r[i] * z[i];
  for (let it = 0; it < maxIt; it++) {
    // Ap = (a D + reg) p - b W p
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let k = start[i]; k < start[i + 1]; k++) s += w[k] * p[nbr[k]];
      Ap[i] = (a * deg[i] + reg) * p[i] - b * s;
    }
    let pAp = 0;
    for (let i = 0; i < n; i++) pAp += p[i] * Ap[i];
    if (pAp <= 0) break;
    const alpha = rz / pAp;
    let rr = 0;
    for (let i = 0; i < n; i++) { x[i] += alpha * p[i]; r[i] -= alpha * Ap[i]; rr += r[i] * r[i]; }
    if (rr < tol * tol * rr0) break;
    let rz2 = 0;
    for (let i = 0; i < n; i++) { z[i] = r[i] / diag[i]; rz2 += r[i] * z[i]; }
    const beta = rz2 / rz;
    rz = rz2;
    for (let i = 0; i < n; i++) p[i] = z[i] + beta * p[i];
    if (opts.project) opts.project(p);
  }
  return x;
}

// ---------------------------------------------------------------------------
// Sweep cuts (isoperimetric score: cut / sqrt(min area))
// ---------------------------------------------------------------------------

function sweepScores(sg, order, totalArea) {
  const K = order.length;
  const inS = new Uint8Array(sg.n);
  const scores = new Float64Array(K);
  const areas = new Float64Array(K);
  let A = 0, cut = 0;
  for (let k = 0; k < K; k++) {
    const i = order[k];
    inS[i] = 1;
    A += sg.area[i];
    let s = 0;
    for (let q = sg.start[i]; q < sg.start[i + 1]; q++) if (inS[sg.nbr[q]]) s += sg.w[q];
    cut += sg.deg[i] - 2 * s;
    const m = Math.min(A, totalArea - A);
    scores[k] = m > totalArea * 1e-4 ? Math.max(0, cut) / Math.sqrt(m) : Infinity;
    areas[k] = A;
  }
  return { scores, areas };
}

function cutScore(sg, mask, totalArea) {
  let A = 0, cut = 0;
  for (let i = 0; i < sg.n; i++) {
    if (!mask[i]) continue;
    A += sg.area[i];
    for (let q = sg.start[i]; q < sg.start[i + 1]; q++) if (!mask[sg.nbr[q]]) cut += sg.w[q];
  }
  const m = Math.min(A, totalArea - A);
  return m > 0 ? cut / Math.sqrt(m) : Infinity;
}

/** connected components of a mask inside the subgraph */
function maskComponents(sg, mask, value = 1) {
  const comp = new Int32Array(sg.n).fill(-1);
  const comps = [];
  const stack = new Int32Array(sg.n);
  for (let s = 0; s < sg.n; s++) {
    if ((mask[s] ? 1 : 0) !== value || comp[s] !== -1) continue;
    let sp = 0, area = 0;
    const nodes = [];
    stack[sp++] = s;
    comp[s] = comps.length;
    while (sp) {
      const i = stack[--sp];
      nodes.push(i);
      area += sg.area[i];
      for (let q = sg.start[i]; q < sg.start[i + 1]; q++) {
        const j = sg.nbr[q];
        if ((mask[j] ? 1 : 0) === value && comp[j] === -1) { comp[j] = comps.length; stack[sp++] = j; }
      }
    }
    comps.push({ nodes, area });
  }
  return { comp, comps };
}

/** keep component containing `seed` (local idx) and fill holes */
function cleanLocalMask(sg, mask, seed, totalArea) {
  const out = new Uint8Array(sg.n);
  const { comp, comps } = maskComponents(sg, mask, 1);
  let keep = seed >= 0 && mask[seed] ? comp[seed] : -1;
  if (keep < 0) {
    let best = -1;
    comps.forEach((c, i) => { if (best < 0 || c.area > comps[best].area) best = i; });
    keep = best;
  }
  if (keep < 0) return out;
  for (const i of comps[keep].nodes) out[i] = 1;
  const selArea = comps[keep].area;
  // holes = complement components other than the largest
  const cc = maskComponents(sg, out, 0);
  if (cc.comps.length > 1) {
    let big = 0;
    cc.comps.forEach((c, i) => { if (c.area > cc.comps[big].area) big = i; });
    cc.comps.forEach((c, i) => {
      if (i === big) return;
      if (c.area < Math.max(0.35 * selArea, 0.02 * totalArea)) for (const j of c.nodes) out[j] = 1;
    });
  }
  return out;
}

function jaccard(sg, a, b) {
  let inter = 0, uni = 0;
  for (let i = 0; i < sg.n; i++) {
    const x = a[i], y = b[i];
    if (x || y) { uni += sg.area[i]; if (x && y) inter += sg.area[i]; }
  }
  return uni > 0 ? inter / uni : 1;
}

// ---------------------------------------------------------------------------
// Smart click selection: personalized PageRank + sweep cut (local graph partitioning)
// ---------------------------------------------------------------------------

/**
 * @returns {{candidates: {mask: Uint8Array, score: number, area: number}[], best: number}}
 *   masks are global patch masks (length graph.n)
 */
export function smartSelect(graph, seedPatch, opts = {}) {
  const compId = graph.comp[seedPatch];
  const nodes = [];
  for (let i = 0; i < graph.n; i++) if (graph.comp[i] === compId) nodes.push(i);
  const sg = subgraph(graph, nodes);
  const total = graph.compArea[compId];
  const seed = sg.loc.get(seedPatch);
  const toGlobal = (lm) => {
    const g = new Uint8Array(graph.n);
    for (let i = 0; i < sg.n; i++) if (lm[i]) g[nodes[i]] = 1;
    return g;
  };
  const whole = new Uint8Array(sg.n).fill(1);
  if (sg.n <= 2) {
    return { candidates: [{ mask: toGlobal(whole), score: 0, area: total, whole: true }], best: 0 };
  }
  const alphas = opts.alphas ?? [0.2, 0.06, 0.02, 0.006, 0.002, 0.0006];
  const raw = [];
  const rhs = new Float64Array(sg.n);
  for (const alpha of alphas) {
    rhs.fill(0);
    rhs[seed] = alpha;
    // ((1+a)/2 D - (1-a)/2 W) x = a e_s ; x = p / d
    const x = cgSolve(sg, (1 + alpha) / 2, (1 - alpha) / 2, rhs, { maxIt: 600, tol: 1e-9 });
    const order = [];
    for (let i = 0; i < sg.n; i++) if (x[i] > 1e-14) order.push(i);
    order.sort((a, b) => x[b] - x[a]);
    if (order[0] !== seed) {
      const idx = order.indexOf(seed);
      if (idx > 0) { order.splice(idx, 1); order.unshift(seed); }
    }
    const { scores, areas } = sweepScores(sg, order, total);
    const K = order.length;
    const win = Math.max(2, Math.round(K * 0.03));
    for (let k = 0; k < K; k++) {
      const s = scores[k];
      if (!isFinite(s)) continue;
      let isMin = true;
      for (let j = Math.max(0, k - win); j <= Math.min(K - 1, k + win); j++) {
        if (scores[j] < s) { isMin = false; break; }
      }
      if (!isMin) continue;
      raw.push({ alpha, k, score: s, area: areas[k], order });
    }
  }
  raw.sort((a, b) => a.score - b.score);
  const cands = [];
  const maxCands = opts.maxCandidates ?? 8;
  for (const r of raw) {
    if (cands.length >= maxCands) break;
    if (cands.length && r.score > Math.max(cands[0].score * 3, cands[0].score + 1.5)) break;
    const lm = new Uint8Array(sg.n);
    for (let k = 0; k <= r.k; k++) lm[r.order[k]] = 1;
    const cm = cleanLocalMask(sg, lm, seed, total);
    let area = 0, cnt = 0;
    for (let i = 0; i < sg.n; i++) if (cm[i]) { area += sg.area[i]; cnt++; }
    if (cnt === 0 || area > total * 0.995) continue;
    const score = cutScore(sg, cm, total);
    let dup = false;
    for (const c of cands) if (jaccard(sg, c.local, cm) > 0.85) { dup = true; break; }
    if (dup) continue;
    cands.push({ local: cm, score, area });
  }
  cands.sort((a, b) => a.score - b.score);
  const wholeThreshold = opts.wholeThreshold ?? 1.1;
  const out = cands.map((c) => ({ mask: toGlobal(c.local), score: c.score, area: c.area }));
  out.push({ mask: toGlobal(whole), score: wholeThreshold, area: total, whole: true });
  out.sort((a, b) => a.score - b.score);
  // default: the best real sub-part unless every cut is poor
  let best = out.findIndex((c) => !c.whole);
  if (best < 0 || out[best].score > (opts.maxPartScore ?? 2.2)) best = out.findIndex((c) => c.whole);
  return { candidates: out, best };
}

// ---------------------------------------------------------------------------
// Automatic segmentation: recursive spectral bisection with isoperimetric sweep
// ---------------------------------------------------------------------------

function lowEigenvectors(sg, k, iters, centroids) {
  const n = sg.n;
  const M = sg.area;
  let Msum = 0;
  for (let i = 0; i < n; i++) Msum += M[i];
  const projConst = (v) => {
    let s = 0;
    for (let i = 0; i < n; i++) s += M[i] * v[i];
    s /= Msum;
    for (let i = 0; i < n; i++) v[i] -= s;
  };
  const mdot = (a, b) => {
    let s = 0;
    for (let i = 0; i < n; i++) s += M[i] * a[i] * b[i];
    return s;
  };
  const orthonormalize = (V) => {
    const out = [];
    for (const v of V) {
      projConst(v);
      for (const u of out) {
        const d = mdot(u, v);
        for (let i = 0; i < n; i++) v[i] -= d * u[i];
      }
      const l = Math.sqrt(mdot(v, v));
      if (l < 1e-12) continue;
      for (let i = 0; i < n; i++) v[i] /= l;
      out.push(v);
    }
    return out;
  };
  // initial guesses: principal axes of centroids + noise
  let V = [];
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  for (let c = 0; c < k; c++) {
    const v = new Float64Array(n);
    for (let i = 0; i < n; i++) v[i] = (c < 3 ? centroids[3 * i + c] : 0) + 0.05 * rnd() * (c < 3 ? 1 : 20);
    V.push(v);
  }
  V = orthonormalize(V);
  const rhs = new Float64Array(n);
  for (let it = 0; it < iters; it++) {
    const W = [];
    for (const v of V) {
      for (let i = 0; i < n; i++) rhs[i] = M[i] * v[i];
      projConst(rhs);
      const y = cgSolve(sg, 1, 1, rhs, { maxIt: 300, tol: 1e-6, reg: 1e-9 });
      W.push(y);
    }
    V = orthonormalize(W);
  }
  return V;
}

/**
 * @returns {{labels: Int32Array, count: number}} patch labels
 */
export function autoSegment(graph, opts = {}) {
  const threshold = opts.threshold ?? 0.9;
  const totalArea = graph.compArea.reduce((a, b) => a + b, 0);
  const minArea = (opts.minFraction ?? 0.01) * totalArea;
  const maxSegments = opts.maxSegments ?? 64;
  const labels = new Int32Array(graph.n).fill(-1);
  let count = 0;
  const queue = [];
  // start: one region per connected component
  const byComp = new Map();
  for (let i = 0; i < graph.n; i++) {
    const c = graph.comp[i];
    if (!byComp.has(c)) byComp.set(c, []);
    byComp.get(c).push(i);
  }
  for (const nodes of byComp.values()) queue.push({ nodes, depth: 0 });
  const leaves = [];
  while (queue.length) {
    const reg = queue.shift();
    const { nodes } = reg;
    let A = 0;
    for (const i of nodes) A += graph.area[i];
    if (nodes.length < 6 || A < 2 * minArea || reg.depth > 10 || leaves.length + queue.length >= maxSegments) {
      leaves.push(nodes);
      continue;
    }
    const sg = subgraph(graph, nodes);
    const cen = new Float64Array(sg.n * 3);
    for (let i = 0; i < sg.n; i++) {
      const g = nodes[i];
      cen[3 * i] = graph.centroid[3 * g];
      cen[3 * i + 1] = graph.centroid[3 * g + 1];
      cen[3 * i + 2] = graph.centroid[3 * g + 2];
    }
    const V = lowEigenvectors(sg, opts.k ?? 3, opts.iters ?? 6, cen);
    let best = null;
    for (const v of V) {
      const order = Array.from({ length: sg.n }, (_, i) => i).sort((a, b) => v[a] - v[b]);
      const { scores, areas } = sweepScores(sg, order, A);
      for (let k = 0; k < order.length; k++) {
        const s = scores[k];
        if (!isFinite(s)) continue;
        if (areas[k] < minArea || A - areas[k] < minArea) continue;
        if (!best || s < best.score) best = { score: s, k, order };
      }
    }
    if (!best || best.score > threshold) {
      leaves.push(nodes);
      continue;
    }
    const mask = new Uint8Array(sg.n);
    for (let k = 0; k <= best.k; k++) mask[best.order[k]] = 1;
    // split both sides into connected pieces; tiny pieces get merged back later
    for (const val of [1, 0]) {
      const { comps } = maskComponents(sg, mask, val);
      for (const c of comps) queue.push({ nodes: c.nodes.map((i) => nodes[i]), depth: reg.depth + 1 });
    }
  }
  for (const nodes of leaves) {
    for (const i of nodes) labels[i] = count;
    count++;
  }
  return mergeSmallSegments(graph, labels, count, minArea * 0.5);
}

/** merge segments smaller than minArea into the neighbour with strongest connection */
export function mergeSmallSegments(graph, labels, count, minArea) {
  for (let pass = 0; pass < 3; pass++) {
    const area = new Float64Array(count);
    for (let i = 0; i < graph.n; i++) if (labels[i] >= 0) area[labels[i]] += graph.area[i];
    let changed = false;
    const order = Array.from({ length: count }, (_, i) => i).sort((a, b) => area[a] - area[b]);
    for (const s of order) {
      if (area[s] >= minArea || area[s] === 0) continue;
      const conn = new Map();
      for (let i = 0; i < graph.n; i++) {
        if (labels[i] !== s) continue;
        for (let k = graph.start[i]; k < graph.start[i + 1]; k++) {
          const t = labels[graph.nbr[k]];
          if (t !== s && t >= 0) conn.set(t, (conn.get(t) || 0) + graph.w[k]);
        }
      }
      let best = -1, bw = -1;
      for (const [t, w] of conn) if (w > bw) { bw = w; best = t; }
      if (best < 0) continue; // isolated component: keep
      for (let i = 0; i < graph.n; i++) if (labels[i] === s) labels[i] = best;
      area[best] += area[s];
      area[s] = 0;
      changed = true;
    }
    if (!changed) break;
  }
  // compact labels
  const remap = new Map();
  for (let i = 0; i < graph.n; i++) {
    const l = labels[i];
    if (l < 0) continue;
    if (!remap.has(l)) remap.set(l, remap.size);
    labels[i] = remap.get(l);
  }
  return { labels, count: remap.size };
}

// ---------------------------------------------------------------------------
// Face-level boundary refinement (marker based minimax watershed in a band)
// ---------------------------------------------------------------------------

/**
 * @param patchLabel Int32Array per patch (labels >= 0, -1 = unlabeled)
 * @returns Int32Array per face
 */
export function refineFaceLabels(mesh, aff, graph, patchLabel, opts = {}) {
  const { nf, faceLinkStart, faceLinks, linkF, faceCenter: C } = mesh;
  const patchOf = graph.patchOf;
  const P = graph.n;
  const rings = opts.rings ?? 1;
  const faceLabel = new Int32Array(nf);
  for (let f = 0; f < nf; f++) faceLabel[f] = patchLabel[patchOf[f]];
  // band patches
  let band = new Uint8Array(P);
  for (let p = 0; p < P; p++) {
    for (let k = graph.start[p]; k < graph.start[p + 1]; k++) {
      if (patchLabel[graph.nbr[k]] !== patchLabel[p]) { band[p] = 1; break; }
    }
  }
  for (let r = 1; r < rings; r++) {
    const nb = band.slice();
    for (let p = 0; p < P; p++) {
      if (!band[p]) continue;
      for (let k = graph.start[p]; k < graph.start[p + 1]; k++) nb[graph.nbr[k]] = 1;
    }
    band = nb;
  }
  // labels whose patches are all in band keep their patches as markers
  const labelCore = new Map();
  for (let p = 0; p < P; p++) {
    const l = patchLabel[p];
    if (!band[p]) labelCore.set(l, true);
    else if (!labelCore.has(l)) labelCore.set(l, false);
  }
  for (let p = 0; p < P; p++) if (band[p] && labelCore.get(patchLabel[p]) === false) band[p] = 0;

  const UNASSIGNED = -2;
  const keyB = new Float64Array(nf).fill(Infinity);
  const keyD = new Float64Array(nf).fill(Infinity);
  let any = false;
  for (let f = 0; f < nf; f++) if (band[patchOf[f]]) { faceLabel[f] = UNASSIGNED; any = true; }
  if (!any) return faceLabel;
  const heap = new MinHeap(4096);
  const Q = 0.01; // barrier quantization (radians)
  const BIG = mesh.bounds.diag * 20 + 1;
  for (let f = 0; f < nf; f++) {
    if (faceLabel[f] === UNASSIGNED) continue;
    let touches = false;
    for (let i = faceLinkStart[f]; i < faceLinkStart[f + 1]; i++) {
      if (faceLabel[mesh.other(faceLinks[i], f)] === UNASSIGNED) { touches = true; break; }
    }
    if (touches) { keyB[f] = 0; keyD[f] = 0; heap.push(f, 0); }
  }
  const barrier = aff.barrier;
  const final = new Uint8Array(nf);
  while (heap.size) {
    const f = heap.pop();
    if (final[f]) continue;
    final[f] = 1;
    const lab = faceLabel[f];
    for (let i = faceLinkStart[f]; i < faceLinkStart[f + 1]; i++) {
      const l = faceLinks[i];
      const g = linkF[2 * l] === f ? linkF[2 * l + 1] : linkF[2 * l];
      if (final[g] || !band[patchOf[g]]) continue;
      const qb = Math.max(keyB[f], Math.round(barrier[l] / Q));
      const dx = C[3 * g] - C[3 * f], dy = C[3 * g + 1] - C[3 * f + 1], dz = C[3 * g + 2] - C[3 * f + 2];
      const qd = keyD[f] + Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (qb < keyB[g] || (qb === keyB[g] && qd < keyD[g])) {
        keyB[g] = qb; keyD[g] = qd;
        faceLabel[g] = lab;
        heap.push(g, qb * BIG + qd);
      }
    }
  }
  for (let f = 0; f < nf; f++) if (faceLabel[f] === UNASSIGNED) faceLabel[f] = patchLabel[patchOf[f]];
  if (opts.smooth !== false) smoothFaceLabels(mesh, aff, faceLabel, opts.smoothIters ?? 2);
  return faceLabel;
}

/** majority filter across low-barrier links to reduce jagged borders */
export function smoothFaceLabels(mesh, aff, faceLabel, iters = 2) {
  const { nf, faceLinkStart, faceLinks } = mesh;
  for (let it = 0; it < iters; it++) {
    const next = faceLabel.slice();
    let changed = 0;
    for (let f = 0; f < nf; f++) {
      const s = faceLinkStart[f], e = faceLinkStart[f + 1];
      if (e - s !== 3) continue;
      const l0 = faceLinks[s], l1 = faceLinks[s + 1], l2 = faceLinks[s + 2];
      const a = faceLabel[mesh.other(l0, f)], b = faceLabel[mesh.other(l1, f)], c = faceLabel[mesh.other(l2, f)];
      const me = faceLabel[f];
      let maj = null;
      if (a === b && a !== me) maj = a;
      else if (a === c && a !== me) maj = a;
      else if (b === c && b !== me) maj = b;
      if (maj === null) continue;
      // do not move off a crease: the links to the majority label must be weak barriers
      let maxB = 0;
      for (const l of [l0, l1, l2]) if (faceLabel[mesh.other(l, f)] === maj) maxB = Math.max(maxB, aff.barrier[l]);
      if (maxB > 0.25) continue;
      next[f] = maj;
      changed++;
    }
    faceLabel.set(next);
    if (!changed) break;
  }
}

// ---------------------------------------------------------------------------
// Simple face-level tools
// ---------------------------------------------------------------------------

/** region growing over smooth surface (unsigned dihedral below threshold) */
export function growSurface(mesh, seedFace, angleThr, groupAware = true) {
  const { nf, faceLinkStart, faceLinks, linkAngle, faceGroup } = mesh;
  const mask = new Uint8Array(nf);
  const stack = [seedFace];
  mask[seedFace] = 1;
  const g0 = faceGroup && groupAware ? faceGroup[seedFace] : null;
  while (stack.length) {
    const f = stack.pop();
    for (let i = faceLinkStart[f]; i < faceLinkStart[f + 1]; i++) {
      const l = faceLinks[i];
      const g = mesh.other(l, f);
      if (mask[g]) continue;
      if (g0 !== null) { if (faceGroup[g] !== g0) continue; }
      else if (Math.abs(linkAngle[l]) > angleThr) continue;
      mask[g] = 1;
      stack.push(g);
    }
  }
  return mask;
}

export function selectComponent(mesh, face) {
  const mask = new Uint8Array(mesh.nf);
  const c = mesh.faceComp[face];
  for (let f = 0; f < mesh.nf; f++) if (mesh.faceComp[f] === c) mask[f] = 1;
  return mask;
}

/** faces within `radius` of `center`, connected to seedFace */
export function brushFaces(mesh, seedFace, center, radius) {
  const { faceLinkStart, faceLinks, faceCenter: C, pos, tri } = mesh;
  const r2 = radius * radius;
  const out = [seedFace];
  const seen = new Set([seedFace]);
  const stack = [seedFace];
  const near = (f) => {
    for (let k = 0; k < 3; k++) {
      const v = 3 * tri[3 * f + k];
      const dx = pos[v] - center[0], dy = pos[v + 1] - center[1], dz = pos[v + 2] - center[2];
      if (dx * dx + dy * dy + dz * dz <= r2) return true;
    }
    const dx = C[3 * f] - center[0], dy = C[3 * f + 1] - center[1], dz = C[3 * f + 2] - center[2];
    return dx * dx + dy * dy + dz * dz <= r2;
  };
  while (stack.length) {
    const f = stack.pop();
    for (let i = faceLinkStart[f]; i < faceLinkStart[f + 1]; i++) {
      const g = mesh.other(faceLinks[i], f);
      if (seen.has(g)) continue;
      seen.add(g);
      if (near(g)) { out.push(g); stack.push(g); }
    }
  }
  return out;
}

export function growMask(mesh, mask, steps = 1) {
  for (let s = 0; s < steps; s++) {
    const add = [];
    for (let f = 0; f < mesh.nf; f++) {
      if (!mask[f]) continue;
      for (let i = mesh.faceLinkStart[f]; i < mesh.faceLinkStart[f + 1]; i++) {
        const g = mesh.other(mesh.faceLinks[i], f);
        if (!mask[g]) add.push(g);
      }
    }
    for (const g of add) mask[g] = 1;
  }
  return mask;
}

export function shrinkMask(mesh, mask, steps = 1) {
  for (let s = 0; s < steps; s++) {
    const rem = [];
    for (let f = 0; f < mesh.nf; f++) {
      if (!mask[f]) continue;
      for (let i = mesh.faceLinkStart[f]; i < mesh.faceLinkStart[f + 1]; i++) {
        if (!mask[mesh.other(mesh.faceLinks[i], f)]) { rem.push(f); break; }
      }
    }
    for (const f of rem) mask[f] = 0;
  }
  return mask;
}

function faceMaskComponents(mesh, mask, value) {
  const { nf, faceLinkStart, faceLinks, faceArea } = mesh;
  const comp = new Int32Array(nf).fill(-1);
  const comps = [];
  const stack = new Int32Array(nf);
  for (let s = 0; s < nf; s++) {
    if ((mask[s] ? 1 : 0) !== value || comp[s] !== -1) continue;
    let sp = 0, area = 0;
    const faces = [];
    stack[sp++] = s;
    comp[s] = comps.length;
    while (sp) {
      const f = stack[--sp];
      faces.push(f);
      area += faceArea[f];
      for (let i = faceLinkStart[f]; i < faceLinkStart[f + 1]; i++) {
        const g = mesh.other(faceLinks[i], f);
        if ((mask[g] ? 1 : 0) === value && comp[g] === -1) { comp[g] = comps.length; stack[sp++] = g; }
      }
    }
    comps.push({ faces, area, meshComp: mesh.faceComp[s] });
  }
  return { comp, comps };
}

/**
 * Clean a face selection so it can be cut: drop specks, fill holes, remove pinch vertices.
 */
export function cleanFaceMask(mesh, mask, opts = {}) {
  const minIsland = opts.minIsland ?? 0.02;
  // islands
  let { comps } = faceMaskComponents(mesh, mask, 1);
  if (!comps.length) return mask;
  const largest = Math.max(...comps.map((c) => c.area));
  for (const c of comps) if (c.area < largest * minIsland) for (const f of c.faces) mask[f] = 0;
  // holes: per mesh component, unselected pieces other than the largest one
  const sel = faceMaskComponents(mesh, mask, 1).comps;
  const selArea = sel.reduce((a, c) => a + c.area, 0);
  const un = faceMaskComponents(mesh, mask, 0).comps;
  const bigByComp = new Map();
  for (const c of un) {
    const b = bigByComp.get(c.meshComp);
    if (!b || c.area > b.area) bigByComp.set(c.meshComp, c);
  }
  const holeMax = opts.holeFraction ?? 0.3;
  for (const c of un) {
    if (bigByComp.get(c.meshComp) === c) continue;
    if (c.area < selArea * holeMax) for (const f of c.faces) mask[f] = 1;
  }
  fixPinches(mesh, mask);
  return mask;
}

let _vfCache = new WeakMap();
export function vertexFaces(mesh) {
  let v = _vfCache.get(mesh);
  if (v) return v;
  const { nv, nf, tri } = mesh;
  const start = new Int32Array(nv + 1);
  for (let i = 0; i < nf * 3; i++) start[tri[i] + 1]++;
  for (let i = 0; i < nv; i++) start[i + 1] += start[i];
  const faces = new Int32Array(nf * 3);
  const fill = start.slice(0, nv);
  for (let f = 0; f < nf; f++) for (let k = 0; k < 3; k++) faces[fill[tri[3 * f + k]]++] = f;
  v = { start, faces };
  _vfCache.set(mesh, v);
  return v;
}

/** vertices where the selection boundary touches itself; fixed by adding the vertex fan */
export function fixPinches(mesh, mask, maxIter = 8) {
  const vf = vertexFaces(mesh);
  const { tri, nv } = mesh;
  for (let it = 0; it < maxIter; it++) {
    const cnt = new Int32Array(nv);
    // count boundary edges (between selected and unselected faces) per vertex
    for (let l = 0; l < mesh.nl; l++) {
      const a = mesh.linkF[2 * l], b = mesh.linkF[2 * l + 1];
      if ((mask[a] ? 1 : 0) === (mask[b] ? 1 : 0)) continue;
      const e = mesh.linkE[l];
      cnt[mesh.edgeV[2 * e]]++;
      cnt[mesh.edgeV[2 * e + 1]]++;
    }
    let fixed = 0;
    for (let v = 0; v < nv; v++) {
      if (cnt[v] <= 2) continue;
      for (let k = vf.start[v]; k < vf.start[v + 1]; k++) mask[vf.faces[k]] = 1;
      fixed++;
    }
    if (!fixed) break;
  }
  void tri;
  return mask;
}

/** boundary edges of a face mask, as vertex index pairs (for display) */
export function maskBoundaryEdges(mesh, mask) {
  const out = [];
  for (let l = 0; l < mesh.nl; l++) {
    const a = mesh.linkF[2 * l], b = mesh.linkF[2 * l + 1];
    if ((mask[a] ? 1 : 0) !== (mask[b] ? 1 : 0)) {
      const e = mesh.linkE[l];
      out.push(mesh.edgeV[2 * e], mesh.edgeV[2 * e + 1]);
    }
  }
  return out;
}
