// Robust booleans via manifold-3d: plane cuts and connectors (pegs, magnet seats, dovetails).

let modulePromise = null;
let W = null;

/** Load manifold-3d WASM. `locate` returns the wasm URL (browser) or null (node). */
export async function initManifold(locate = null) {
  if (W) return W;
  if (!modulePromise) {
    modulePromise = (async () => {
      const mod = await import('manifold-3d');
      const Module = mod.default;
      const w = await Module(locate ? { locateFile: () => locate } : undefined);
      w.setup();
      W = w;
      return w;
    })();
  }
  return modulePromise;
}

export function getW() {
  if (!W) throw new Error('Manifold non inizializzato');
  return W;
}

/** Convert {pos, tri} into a Manifold. Throws with an Italian message if not closed. */
export function toManifold(m, opts = {}) {
  const w = getW();
  const mesh = new w.Mesh({
    numProp: 3,
    vertProperties: m.pos instanceof Float32Array ? m.pos : Float32Array.from(m.pos),
    triVerts: m.tri instanceof Uint32Array ? m.tri : Uint32Array.from(m.tri),
    ...(opts.faceID ? { faceID: opts.faceID, runIndex: Uint32Array.from([0, m.tri.length]), runOriginalID: Uint32Array.from([opts.originalID]) } : {}),
  });
  mesh.merge();
  let man;
  try {
    man = new w.Manifold(mesh);
  } catch (e) {
    throw new Error('La mesh non è chiusa (non "manifold"): usa "Ripara mesh" prima di tagliare con connettori.');
  }
  const st = man.status();
  if (st && st !== 'NoError' && st.value !== 0) {
    man.delete();
    throw new Error('La mesh non è valida per le operazioni booleane: ' + (st.constructor?.name || st));
  }
  return man;
}

export function fromManifold(man) {
  const mesh = man.getMesh();
  const np = mesh.numProp;
  const nv = mesh.vertProperties.length / np;
  let pos;
  if (np === 3) pos = Float32Array.from(mesh.vertProperties);
  else {
    pos = new Float32Array(nv * 3);
    for (let i = 0; i < nv; i++) for (let k = 0; k < 3; k++) pos[3 * i + k] = mesh.vertProperties[i * np + k];
  }
  return { pos, tri: Uint32Array.from(mesh.triVerts), mesh };
}

// ---------------------------------------------------------------------------
// Frames & small vector helpers
// ---------------------------------------------------------------------------
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const add = (a, b, s = 1) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];

/** orthonormal basis (u, v, n) with u,v spanning the plane */
export function planeBasis(n) {
  n = norm(n);
  const ref = Math.abs(n[0]) < 0.8 ? [1, 0, 0] : [0, 1, 0];
  const u = norm(cross(ref, n));
  const v = cross(n, u);
  return { u, v, n };
}

/** column-major 4x4 from basis columns X,Y,Z and translation P (local -> world) */
function mat(X, Y, Z, P) {
  return [X[0], X[1], X[2], 0, Y[0], Y[1], Y[2], 0, Z[0], Z[1], Z[2], 0, P[0], P[1], P[2], 1];
}

/** world -> local (rows of basis) */
function invMat(X, Y, Z, P) {
  const t = [-dot(X, P), -dot(Y, P), -dot(Z, P)];
  return [X[0], Y[0], Z[0], 0, X[1], Y[1], Z[1], 0, X[2], Y[2], Z[2], 0, t[0], t[1], t[2], 1];
}

// ---------------------------------------------------------------------------
// Plane split
// ---------------------------------------------------------------------------

/**
 * Cut `man` with a plane. Pieces on the positive side that contain selected faces form A,
 * everything else forms B. Planes that coincide with flat faces of the model produce
 * degenerate slivers, so the result is validated and the plane nudged if needed.
 * @param plane {{normal:number[], origin:number[]}} normal points towards A
 * @param sel Uint8Array face mask of the original mesh (or null => whole positive side)
 * @param originalID id used in toManifold({faceID})
 */
export function planeSplit(man, plane, sel, originalID, faceArea, opts = {}) {
  const n = norm(plane.normal);
  const d = dot(n, plane.origin);
  const bb = man.boundingBox ? man.boundingBox() : null;
  const diag = opts.diag ?? (bb ? Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]) : 100);
  const delta = Math.max(1e-4 * diag, 0.005);
  let last = null;
  for (const k of [0, 1, -2, 5]) {
    const res = planeSplitOnce(man, n, d + k * delta, sel, originalID, faceArea, diag);
    res.offset = k * delta;
    if (res.error || (isClean(res.A, diag) && isClean(res.B, diag))) { if (last) disposeSplit(last); return res; }
    if (last) disposeSplit(last);
    last = res;
  }
  return last;
}

function disposeSplit(r) { r.A?.delete(); r.B?.delete(); }

/**
 * Detect degenerate slivers produced by planes coinciding with flat faces: pieces whose
 * thickness (volume / area) is essentially zero. Legitimately tiny pieces are fine.
 */
function isClean(m, diag) {
  if (!m) return true;
  const parts = m.decompose();
  let ok = true;
  for (const p of parts) {
    const v = Math.abs(manifoldVolume(p));
    const a = typeof p.surfaceArea === 'function' ? p.surfaceArea() : 0;
    if (a > 0 && v / a < diag * 1e-6) ok = false;
    p.delete();
  }
  return ok;
}

function planeSplitOnce(man, n, d, sel, originalID, faceArea, diag) {
  const w = getW();
  const [pos, neg] = man.splitByPlane(n, d);
  if (pos.isEmpty()) { pos.delete(); return { A: null, B: neg, error: 'Il piano non taglia il modello.' }; }
  if (neg.isEmpty()) { neg.delete(); return { A: pos, B: null, error: 'Il piano non taglia il modello.' }; }
  const comps = pos.decompose();
  let A = [], Bextra = [];
  if (!sel || comps.length === 1) {
    A = comps;
  } else {
    const scored = comps.map((c) => {
      const mesh = c.getMesh();
      let selA = 0, totA = 0;
      const runs = mesh.runOriginalID;
      const ri = mesh.runIndex;
      for (let r = 0; r < runs.length; r++) {
        if (runs[r] !== originalID) continue;
        for (let t = ri[r] / 3; t < ri[r + 1] / 3; t++) {
          const fid = mesh.faceID[t];
          const a = faceArea ? faceArea[fid] : 1;
          totA += a;
          if (sel[fid]) selA += a;
        }
      }
      return { c, selA, totA };
    });
    const totalSel = scored.reduce((s, x) => s + x.selA, 0);
    for (const s of scored) {
      if (s.selA > 0 && (s.selA / (s.totA || 1) > 0.15 || s.selA > 0.2 * totalSel)) A.push(s.c);
      else Bextra.push(s.c);
    }
    if (!A.length) { // fallback: biggest selected share
      scored.sort((x, y) => y.selA - x.selA);
      A = [scored[0].c];
      Bextra = scored.slice(1).map((s) => s.c);
    }
  }
  const Am = A.length === 1 ? A[0] : w.Manifold.union(A);
  if (A.length > 1) A.forEach((m) => m.delete());
  if (!Bextra.length) {
    pos.delete();
    return { A: Am, B: neg };
  }
  // unselected pieces go back to B. They touch the lower half only on the cut plane, so a
  // union is cheap; if it leaves slivers, fall back to subtracting A from the original.
  let Bm = w.Manifold.union([neg, ...Bextra]);
  if (!isClean(Bm, diag)) {
    Bm.delete();
    Bm = man.subtract(Am);
  }
  Bextra.forEach((m) => m.delete());
  pos.delete();
  neg.delete();
  return { A: Am, B: Bm };
}

/** Cross-section of a whole solid by a plane (cheap: no boolean). */
export function sliceAtPlane(man, plane, eps = 1e-4) {
  const { u, v, n } = planeBasis(plane.normal);
  const local = man.transform(invMat(u, v, n, plane.origin));
  const cs = local.slice(eps);
  local.delete();
  return { cs, basis: { u, v, n }, origin: plane.origin };
}

/** Cross-section of manifold `A` lying on the plane, in plane-local 2D coordinates. */
export function sectionOnPlane(A, plane) {
  const { u, v, n } = planeBasis(plane.normal);
  const T = invMat(u, v, n, plane.origin);
  const local = A.transform(T);
  const cs = local.slice(1e-4);
  local.delete();
  return { cs, basis: { u, v, n }, origin: plane.origin };
}

// ---------------------------------------------------------------------------
// Connector placement on a 2D section
// ---------------------------------------------------------------------------

export function pointInPolys(polys, x, y) {
  let inside = false;
  for (const poly of polys) {
    const m = poly.length;
    for (let i = 0, j = m - 1; i < m; j = i++) {
      const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

function distToPolys(polys, x, y) {
  let best = Infinity;
  for (const poly of polys) {
    const m = poly.length;
    for (let i = 0, j = m - 1; i < m; j = i++) {
      const ax = poly[j][0], ay = poly[j][1], bx = poly[i][0], by = poly[i][1];
      const dx = bx - ax, dy = by - ay;
      const L = dx * dx + dy * dy;
      let t = L > 0 ? ((x - ax) * dx + (y - ay) * dy) / L : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = ax + t * dx - x, ey = ay + t * dy - y;
      const d = ex * ex + ey * ey;
      if (d < best) best = d;
    }
  }
  return Math.sqrt(best);
}

const toPts = (poly) => (poly.length && Array.isArray(poly[0]) ? poly : poly.map((p) => [p[0] ?? p.x, p[1] ?? p.y]));

/**
 * Choose `count` connector centres inside a section, at least `clearance` from its border.
 * @returns {{points:number[][], maxDepth:number, polys:number[][][]}}
 */
export function placeConnectors(cs, count, clearance) {
  const polys = cs.toPolygons().map(toPts);
  if (!polys.length) return { points: [], maxDepth: 0, polys };
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const p of polys) for (const q of p) {
    if (q[0] < minx) minx = q[0]; if (q[0] > maxx) maxx = q[0];
    if (q[1] < miny) miny = q[1]; if (q[1] > maxy) maxy = q[1];
  }
  const G = 72;
  const sx = (maxx - minx) / G, sy = (maxy - miny) / G;
  const samples = [];
  let maxDepth = 0;
  for (let i = 0; i <= G; i++) for (let j = 0; j <= G; j++) {
    const x = minx + i * sx, y = miny + j * sy;
    if (!pointInPolys(polys, x, y)) continue;
    const d = distToPolys(polys, x, y);
    if (d > maxDepth) maxDepth = d;
    samples.push([x, y, d]);
  }
  let ok = samples.filter((s) => s[2] >= clearance);
  if (!ok.length) return { points: [], maxDepth, polys };
  if (count <= 1) {
    let b = ok[0];
    for (const s of ok) if (s[2] > b[2]) b = s;
    return { points: [[b[0], b[1]]], maxDepth, polys };
  }
  // k-means on admissible samples, initialised by farthest point sampling from the deepest
  let centers = [ok.reduce((a, b) => (b[2] > a[2] ? b : a))];
  while (centers.length < count) {
    let best = null, bd = -1;
    for (const s of ok) {
      let dm = Infinity;
      for (const c of centers) dm = Math.min(dm, (s[0] - c[0]) ** 2 + (s[1] - c[1]) ** 2);
      if (dm > bd) { bd = dm; best = s; }
    }
    if (!best || bd <= 0) break;
    centers.push(best);
  }
  for (let it = 0; it < 12; it++) {
    const acc = centers.map(() => [0, 0, 0]);
    for (const s of ok) {
      let bi = 0, bd = Infinity;
      centers.forEach((c, i) => { const d = (s[0] - c[0]) ** 2 + (s[1] - c[1]) ** 2; if (d < bd) { bd = d; bi = i; } });
      acc[bi][0] += s[0]; acc[bi][1] += s[1]; acc[bi][2]++;
    }
    centers = centers.map((c, i) => {
      if (!acc[i][2]) return c;
      const mx = acc[i][0] / acc[i][2], my = acc[i][1] / acc[i][2];
      // snap to nearest admissible sample
      let b = ok[0], bd = Infinity;
      for (const s of ok) { const d = (s[0] - mx) ** 2 + (s[1] - my) ** 2; if (d < bd) { bd = d; b = s; } }
      return b;
    });
  }
  let minDist = Infinity;
  for (let i = 0; i < centers.length; i++) for (let j = i + 1; j < centers.length; j++) {
    minDist = Math.min(minDist, Math.hypot(centers[i][0] - centers[j][0], centers[i][1] - centers[j][1]));
  }
  return { points: centers.map((c) => [c[0], c[1]]), maxDepth, polys, minDist };
}

/**
 * Shape statistics of a 2D section: area, inscribed radius (maxDepth), deepest point and
 * elongation (ratio of principal axes from exact area moments).
 */
export function sectionStats(cs) {
  const pc = placeConnectors(cs, 1, 0);
  let A = 0, Sx = 0, Sy = 0, Mxx = 0, Myy = 0, Mxy = 0;
  for (const poly of pc.polys) {
    const m = poly.length;
    for (let i = 0; i < m; i++) {
      const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % m];
      const c = x0 * y1 - x1 * y0;
      A += c / 2;
      Sx += ((x0 + x1) * c) / 6;
      Sy += ((y0 + y1) * c) / 6;
      Mxx += ((x0 * x0 + x0 * x1 + x1 * x1) * c) / 12;
      Myy += ((y0 * y0 + y0 * y1 + y1 * y1) * c) / 12;
      Mxy += ((x0 * y1 + 2 * x0 * y0 + 2 * x1 * y1 + x1 * y0) * c) / 24;
    }
  }
  let elong = 1, axis = [1, 0];
  if (Math.abs(A) > 1e-12) {
    const cx = Sx / A, cy = Sy / A;
    const a = Mxx / A - cx * cx, b = Mxy / A - cx * cy, d = Myy / A - cy * cy;
    const tr = a + d, det = a * d - b * b;
    const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
    const l1 = tr / 2 + disc, l2 = Math.max(1e-12, tr / 2 - disc);
    elong = Math.sqrt(Math.max(1, l1 / l2));
    const ang = 0.5 * Math.atan2(2 * b, a - d);
    axis = [Math.cos(ang), Math.sin(ang)];
  }
  return { area: Math.abs(A), maxDepth: pc.maxDepth, deepest: pc.points[0] || [0, 0], elong, axis, polys: pc.polys };
}

/** principal direction of a section (for dovetail sliding direction) */
export function sectionPrincipalAxis(polys) {
  let cx = 0, cy = 0, n = 0;
  for (const p of polys) for (const q of p) { cx += q[0]; cy += q[1]; n++; }
  cx /= n || 1; cy /= n || 1;
  let sxx = 0, sxy = 0, syy = 0;
  for (const p of polys) for (const q of p) { const dx = q[0] - cx, dy = q[1] - cy; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return [Math.cos(ang), Math.sin(ang)];
}

// ---------------------------------------------------------------------------
// Connector solids
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} ConnectorSpec
 * @property {'none'|'peg-round'|'peg-square'|'magnet'|'dovetail'} type
 * @property {'A'|'B'} maleOn   which piece carries the peg / tongue
 * @property {number} diameter  peg diameter / magnet diameter / dovetail width (mm)
 * @property {number} length    peg length / magnet thickness / dovetail height (mm)
 * @property {number} tolerance clearance per side (mm)
 * @property {number} angle     dovetail angle (deg)
 * @property {number} count
 */

/**
 * Connector placement description in world space.
 * point: on the cut surface; axis: unit vector from A into B; hmin/hmax: surface height range
 * around the footprint along axis (0 for planar cuts).
 */
export function buildConnectorSolids(spec, placements, extra = {}) {
  const w = getW();
  const M = w.Manifold;
  const segs = 48;
  const addA = [], subA = [], addB = [], subB = [], extras = [];
  const r = spec.diameter / 2;
  const tol = spec.tolerance;
  for (const pl of placements) {
    const axisAB = norm(pl.axis);
    const hmin = pl.hmin ?? 0, hmax = pl.hmax ?? 0;
    if (spec.type === 'peg-round' || spec.type === 'peg-square') {
      const maleA = spec.maleOn !== 'B';
      const d = maleA ? axisAB : [-axisAB[0], -axisAB[1], -axisAB[2]];
      // heights along d
      const lo = maleA ? hmin : -hmax;
      const { u, v } = planeBasis(d);
      const X = u, Y = cross(d, u);
      void v;
      const T = mat(X, Y, d, pl.point);
      const L = spec.length;
      const z0 = lo - 0.15 - (pl.embed ?? 0);
      const ch = Math.min(0.6, r * 0.25, L * 0.2);
      let peg, hole;
      if (spec.type === 'peg-round') {
        const body = M.cylinder(L - ch - z0, r, r, segs).translate([0, 0, z0]);
        const tip = M.cylinder(ch + 0.05, r, r - ch, segs).translate([0, 0, L - ch - 0.05]);
        peg = body.add(tip);
        body.delete(); tip.delete();
        hole = M.cylinder(L + tol + 0.3 - (lo - 0.3), r + tol, r + tol, segs).translate([0, 0, lo - 0.3]);
      } else {
        const body = M.cube([2 * r, 2 * r, L - z0]).translate([-r, -r, z0]);
        peg = body;
        hole = M.cube([2 * (r + tol), 2 * (r + tol), L + tol + 0.3 - (lo - 0.3)]).translate([-(r + tol), -(r + tol), lo - 0.3]);
      }
      const pw = peg.transform(T), hw = hole.transform(T);
      peg.delete(); hole.delete();
      if (maleA) { addA.push(pw); subB.push(hw); } else { addB.push(pw); subA.push(hw); }
    } else if (spec.type === 'magnet') {
      const { u } = planeBasis(axisAB);
      const T = mat(u, cross(axisAB, u), axisAB, pl.point);
      const R = r + tol;
      const depth = spec.length + tol;
      // A lies on -axis side, B on +axis side
      const ha = M.cylinder(hmax + 0.3 + depth, R, R, segs).translate([0, 0, -depth]);
      const hb = M.cylinder(depth + 0.3 - hmin, R, R, segs).translate([0, 0, hmin - 0.3]);
      subA.push(ha.transform(T));
      subB.push(hb.transform(T));
      ha.delete(); hb.delete();
    } else if (spec.type === 'dovetail') {
      const maleA = spec.maleOn !== 'B';
      const d = maleA ? axisAB : [-axisAB[0], -axisAB[1], -axisAB[2]];
      const slide = norm(pl.slide);
      const across = norm(cross(d, slide));
      const s2 = cross(across, d); // right-handed (across, d, s2)
      const T = mat(across, d, s2, pl.point);
      const h = spec.length;
      const wb = spec.diameter / 2;
      const ta = Math.tan(((spec.angle ?? 15) * Math.PI) / 180);
      const wt = wb + h * ta;
      const span = (extra.span ?? 200) * 2;
      const tongue2D = [[-wb, -0.15], [wb, -0.15], [wt + 0.15 * ta, h], [-(wt + 0.15 * ta), h]];
      const slot2D = [[-(wb + tol), -0.3], [wb + tol, -0.3], [wt + tol + ta * (tol + 0.3), h + tol], [-(wt + tol + ta * (tol + 0.3)), h + tol]];
      const tongue = M.extrude([tongue2D], span, 0, 0, [1, 1], true);
      const slot = M.extrude([slot2D], span + 1, 0, 0, [1, 1], true);
      const tw = tongue.transform(T), sw = slot.transform(T);
      tongue.delete(); slot.delete();
      extras.push({ tongue: tw, slot: sw, maleA });
    }
  }
  return { addA, subA, addB, subB, dovetails: extras };
}

/** apply connector solids to A and B manifolds; returns new manifolds (inputs deleted) */
export function applyConnectors(A, B, solids, opts = {}) {
  const w = getW();
  let a = A, b = B;
  const swap = (oldM, newM) => { oldM.delete(); return newM; };
  // dovetails: the tongue is clipped to the original solid so it never pokes outside the
  // model, while keeping its overlap with the male piece (touching faces would not fuse)
  for (const dv of solids.dovetails) {
    const clipped = dv.tongue.intersect(opts.whole || (dv.maleA ? b : a));
    if (dv.maleA) {
      a = swap(a, a.add(clipped));
      b = swap(b, b.subtract(dv.slot));
    } else {
      b = swap(b, b.add(clipped));
      a = swap(a, a.subtract(dv.slot));
    }
    clipped.delete(); dv.tongue.delete(); dv.slot.delete();
  }
  if (solids.subA.length) { const u = w.Manifold.union(solids.subA); a = swap(a, a.subtract(u)); u.delete(); }
  if (solids.subB.length) { const u = w.Manifold.union(solids.subB); b = swap(b, b.subtract(u)); u.delete(); }
  if (solids.addA.length) { const u = w.Manifold.union(solids.addA); a = swap(a, a.add(u)); u.delete(); }
  if (solids.addB.length) { const u = w.Manifold.union(solids.addB); b = swap(b, b.add(u)); u.delete(); }
  for (const list of [solids.subA, solids.subB, solids.addA, solids.addB]) list.forEach((m) => m.delete());
  return { A: a, B: b };
}

/** world-space connector placements from section 2D points (planar cut) */
export function planarPlacements(points2D, basis, origin, slide2D = null) {
  const { u, v, n } = basis;
  // axis from A into B: A is on +n side
  const axis = [-n[0], -n[1], -n[2]];
  return points2D.map((p) => {
    const point = add(add(origin, u, p[0]), v, p[1]);
    const pl = { point, axis, hmin: 0, hmax: 0 };
    if (slide2D) pl.slide = norm(add([u[0] * slide2D[0], u[1] * slide2D[0], u[2] * slide2D[0]], v, slide2D[1]));
    return pl;
  });
}

/**
 * Placements on a curved membrane cap: project the loop to its fit plane, choose
 * points in 2D, then lift them onto the cap surface along the cap normal.
 */
/** Project a membrane cap to its fit plane: 2D section + helpers to lift points back onto the cap. */
export function capSection(cap) {
  const w = getW();
  const N = norm(cap.normal); // A -> B
  const { u, v } = planeBasis(N);
  const C = cap.centroid;
  const P = cap.loopPositions;
  const n = P.length / 3;
  const loop2D = [];
  for (let i = 0; i < n; i++) {
    const d = [P[3 * i] - C[0], P[3 * i + 1] - C[1], P[3 * i + 2] - C[2]];
    loop2D.push([dot(d, u), dot(d, v)]);
  }
  const cs = new w.CrossSection([loop2D], 'NonZero');
  const heightAt = (x, y) => {
    const o = add(add(C, u, x), v, y);
    let best = null;
    const T = cap.capTris, Q = cap.capPositions;
    for (let t = 0; t < T.length; t += 3) {
      const h = rayTri(o, N, Q, T[t], T[t + 1], T[t + 2]);
      if (h !== null && (best === null || Math.abs(h) < Math.abs(best))) best = h;
    }
    return best ?? 0;
  };
  const lift = (x, y) => add(add(add(C, u, x), v, y), N, heightAt(x, y));
  return { cs, basis: { u, v, n: N }, origin: C, heightAt, lift };
}

export function membranePlacements(cap, spec) {
  const sec = capSection(cap);
  const { cs } = sec;
  const { u, v } = sec.basis;
  const N = sec.basis.n;
  const C = sec.origin;
  const clearance = connectorClearance(spec);
  const res = placeConnectors(cs, spec.count, clearance);
  let slide2D = null;
  if (spec.type === 'dovetail') slide2D = sectionPrincipalAxis(res.polys);
  cs.delete();
  const heightAt = sec.heightAt;
  const r = spec.diameter / 2 + spec.tolerance;
  const placements = res.points.map((p) => {
    const h0 = heightAt(p[0], p[1]);
    let hmin = 0, hmax = 0;
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      const h = heightAt(p[0] + r * Math.cos(a), p[1] + r * Math.sin(a)) - h0;
      hmin = Math.min(hmin, h); hmax = Math.max(hmax, h);
    }
    const base = add(add(C, u, p[0]), v, p[1]);
    const point = add(base, N, h0);
    const pl = { point, axis: N, hmin, hmax };
    if (slide2D) pl.slide = norm(add([u[0] * slide2D[0], u[1] * slide2D[0], u[2] * slide2D[0]], v, slide2D[1]));
    return pl;
  });
  return { placements, maxDepth: res.maxDepth, polys: res.polys, basis: { u, v, n: N }, origin: C, minDist: res.minDist };
}

function rayTri(o, d, Q, i0, i1, i2) {
  const a = [Q[3 * i0], Q[3 * i0 + 1], Q[3 * i0 + 2]];
  const e1 = [Q[3 * i1] - a[0], Q[3 * i1 + 1] - a[1], Q[3 * i1 + 2] - a[2]];
  const e2 = [Q[3 * i2] - a[0], Q[3 * i2 + 1] - a[1], Q[3 * i2 + 2] - a[2]];
  const p = cross(d, e2);
  const det = dot(e1, p);
  if (Math.abs(det) < 1e-14) return null;
  const inv = 1 / det;
  const s = [o[0] - a[0], o[1] - a[1], o[2] - a[2]];
  const uu = dot(s, p) * inv;
  if (uu < -1e-9 || uu > 1 + 1e-9) return null;
  const q = cross(s, e1);
  const vv = dot(d, q) * inv;
  if (vv < -1e-9 || uu + vv > 1 + 1e-9) return null;
  return dot(e2, q) * inv;
}

export function connectorClearance(spec) {
  const wall = Math.max(0.8, spec.diameter * 0.25);
  if (spec.type === 'dovetail') return spec.diameter / 2 + spec.length * Math.tan(((spec.angle ?? 15) * Math.PI) / 180) + spec.tolerance + 1;
  if (spec.type === 'peg-square') return spec.diameter * 0.71 + spec.tolerance + wall;
  return spec.diameter / 2 + spec.tolerance + wall;
}

export function manifoldVolume(m) {
  return typeof m.volume === 'function' ? m.volume() : m.getProperties?.().volume ?? 0;
}

/** Largest connector size (diameter / width, mm) that fits a section with the given inscribed radius. */
export function maxConnectorSize(spec, maxDepth) {
  const tol = spec.tolerance;
  if (spec.type === 'dovetail') {
    const ta = Math.tan(((spec.angle ?? 15) * Math.PI) / 180);
    return Math.max(0, 2 * (maxDepth - tol - 1 - spec.length * ta));
  }
  const k = spec.type === 'peg-square' ? 0.71 : 0.5;
  // clearance = k d + tol + max(0.8, 0.25 d)
  const d1 = (maxDepth - tol - 0.8) / k; // wall = 0.8 (d <= 3.2)
  const d2 = (maxDepth - tol) / (k + 0.25); // wall = 0.25 d
  const d = d1 <= 3.2 ? d1 : d2;
  return Math.max(0, Math.floor(d * 10) / 10);
}
