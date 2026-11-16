// High-level cut pipeline used by the UI: plane fitting, previews and final split.
import { boundaryLoops, loopFrame, computeCaps, splitByMask } from './split.js';
import * as csg from './csg.js';

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export function selectionCentroid(mesh, sel) {
  let x = 0, y = 0, z = 0, a = 0;
  for (let f = 0; f < mesh.nf; f++) {
    if (!sel[f]) continue;
    const w = mesh.faceArea[f];
    x += mesh.faceCenter[3 * f] * w; y += mesh.faceCenter[3 * f + 1] * w; z += mesh.faceCenter[3 * f + 2] * w;
    a += w;
  }
  return a > 0 ? [x / a, y / a, z / a] : null;
}

/** Best-fit plane through the (largest) boundary loop of the selection, normal towards the selection. */
export function fitPlaneToSelection(mesh, sel) {
  const c = selectionCentroid(mesh, sel);
  const loops = boundaryLoops(mesh, sel);
  if (!c) return null;
  if (!loops.length) return { normal: [0, 1, 0], origin: c, loops: 0 };
  let best = null;
  for (const loop of loops) {
    const P = new Float64Array(loop.length * 3);
    for (let i = 0; i < loop.length; i++) for (let k = 0; k < 3; k++) P[3 * i + k] = mesh.pos[3 * loop[i] + k];
    const fr = loopFrame(P);
    if (!best || fr.perimeter > best.perimeter) best = fr;
  }
  let n = best.normal;
  const d = [c[0] - best.centroid[0], c[1] - best.centroid[1], c[2] - best.centroid[2]];
  if (dot(n, d) < 0) n = [-n[0], -n[1], -n[2]];
  return { normal: n, origin: best.centroid, loops: loops.length };
}

/** Cached Manifold of the original part with face provenance. */
export function originalManifold(part) {
  if (part._manifold) return part._manifold;
  const w = csg.getW();
  const id = w.Manifold.reserveIDs(1);
  const faceID = new Uint32Array(part.mesh.nf);
  for (let i = 0; i < faceID.length; i++) faceID[i] = i;
  const man = csg.toManifold(part.mesh, { faceID, originalID: id });
  part._manifold = { man, id };
  return part._manifold;
}

export function disposePartManifold(part) {
  if (part._manifold) { part._manifold.man.delete(); part._manifold = null; }
}

function footprintFromSection(sec, depth) {
  const w = csg.getW();
  const { u, v, n } = sec.basis;
  const o = sec.origin;
  const ext = w.Manifold.extrude(sec.cs, depth * 2, 0, 0, [1, 1], true);
  const T = [u[0], u[1], u[2], 0, v[0], v[1], v[2], 0, n[0], n[1], n[2], 0, o[0], o[1], o[2], 1];
  const fw = ext.transform(T);
  ext.delete();
  return fw;
}

function sectionSpan(polys) {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const p of polys) for (const q of p) {
    minx = Math.min(minx, q[0]); maxx = Math.max(maxx, q[0]);
    miny = Math.min(miny, q[1]); maxy = Math.max(maxy, q[1]);
  }
  return Math.hypot(maxx - minx, maxy - miny) || 1;
}

/**
 * Compute connector placements (for preview and for the final cut).
 * ctx: {part, sel, method, plane, spec, onlySelected}
 * @returns {{placements, outline: number[][][] (3D polylines), warning?, planeSplit?}}
 */
export function planConnectors(ctx) {
  const { part, sel, method, plane, spec } = ctx;
  const mesh = part.mesh;
  const res = { placements: [], outline: [], warning: null };
  if (method === 'membrane') {
    const caps = ctx.caps || computeCaps(mesh, sel);
    res.caps = caps;
    if (!caps.length) { res.warning = 'La selezione non ha un bordo da tagliare (è un corpo intero?).'; return res; }
    for (const c of caps) {
      const P = c.loopPositions, line = [];
      for (let i = 0; i < P.length; i += 3) line.push([P[i], P[i + 1], P[i + 2]]);
      res.outline.push(line);
    }
    if (!spec || spec.type === 'none') return res;
    if (spec.type === 'dovetail') { res.warning = 'La coda di rondine richiede il taglio a piano.'; return res; }
    const mp = csg.membranePlacements(caps[0], spec);
    res.placements = mp.placements;
    if (!mp.placements.length) res.warning = `Sezione troppo piccola per il connettore (spessore utile ≈ ${(mp.maxDepth * 2).toFixed(1)} mm).`;
    return res;
  }
  // plane
  const { man, id } = originalManifold(part);
  const ps = csg.planeSplit(man, plane, ctx.onlySelected ? sel : null, id, mesh.faceArea, { diag: mesh.bounds.diag });
  res.planeSplit = ps;
  if (ps.error || !ps.A || !ps.B) { res.warning = ps.error || 'Il piano non taglia il modello.'; return res; }
  // the split may have nudged the plane slightly to avoid coplanar faces
  const nl = Math.hypot(...plane.normal) || 1;
  const nn = plane.normal.map((x) => x / nl);
  const eff = { normal: nn, origin: plane.origin.map((x, i) => x + nn[i] * (ps.offset || 0)) };
  const sec = csg.sectionOnPlane(ps.A, eff);
  res.section = sec;
  const polys = sec.cs.toPolygons().map((p) => p.map((q) => [q[0] ?? q.x, q[1] ?? q.y]));
  const { u, v } = sec.basis;
  const o = sec.origin;
  for (const p of polys) {
    res.outline.push(p.map((q) => [o[0] + u[0] * q[0] + v[0] * q[1], o[1] + u[1] * q[0] + v[1] * q[1], o[2] + u[2] * q[0] + v[2] * q[1]]));
  }
  if (!spec || spec.type === 'none') return res;
  const pc = csg.placeConnectors(sec.cs, spec.type === 'dovetail' ? 1 : spec.count, csg.connectorClearance(spec));
  const slide = spec.type === 'dovetail' ? csg.sectionPrincipalAxis(pc.polys) : null;
  res.placements = csg.planarPlacements(pc.points, sec.basis, sec.origin, slide);
  res.span = sectionSpan(pc.polys);
  if (!res.placements.length) res.warning = `Sezione troppo piccola per il connettore (spessore utile ≈ ${(pc.maxDepth * 2).toFixed(1)} mm).`;
  return res;
}

export function disposePlan(plan) {
  if (!plan) return;
  if (plan.planeSplit) { plan.planeSplit.A?.delete(); plan.planeSplit.B?.delete(); plan.planeSplit = null; }
  if (plan.section) { plan.section.cs.delete(); plan.section = null; }
}

/**
 * Perform the cut. Returns plain meshes {pos, tri} for A (selected side) and B.
 */
export function performCut(ctx) {
  const { part, sel, method, spec } = ctx;
  const useConn = spec && spec.type !== 'none';
  const warnings = [];
  if (method === 'membrane') {
    const caps = computeCaps(part.mesh, sel);
    if (!caps.length) throw new Error('La selezione non ha un bordo da tagliare.');
    const pieces = splitByMask(part.mesh, sel, caps);
    if (!useConn) return { A: pieces.A, B: pieces.B, warnings };
    if (spec.type === 'dovetail') {
      warnings.push('Coda di rondine non disponibile sul bordo naturale: usa il taglio a piano.');
      return { A: pieces.A, B: pieces.B, warnings };
    }
    const plan = planConnectors({ ...ctx, caps });
    if (plan.warning) warnings.push(plan.warning);
    if (!plan.placements.length) return { A: pieces.A, B: pieces.B, warnings };
    let A, B;
    try {
      A = csg.toManifold(pieces.A);
      B = csg.toManifold(pieces.B);
    } catch (e) {
      A?.delete();
      warnings.push(e.message + ' Pezzi separati senza connettori.');
      return { A: pieces.A, B: pieces.B, warnings };
    }
    const solids = csg.buildConnectorSolids(spec, plan.placements);
    const out = csg.applyConnectors(A, B, solids);
    const r = { A: csg.fromManifold(out.A), B: csg.fromManifold(out.B), warnings, placements: plan.placements };
    out.A.delete(); out.B.delete();
    return r;
  }
  // plane
  const plan = planConnectors(ctx);
  try {
    if (plan.warning && (!plan.planeSplit || !plan.planeSplit.A || !plan.planeSplit.B)) throw new Error(plan.warning);
    if (plan.warning) warnings.push(plan.warning);
    let { A, B } = plan.planeSplit;
    plan.planeSplit = null;
    if (useConn && plan.placements.length) {
      const extra = { span: plan.span };
      const solids = csg.buildConnectorSolids(spec, plan.placements, extra);
      if (solids.dovetails.length) {
        const fp = footprintFromSection(plan.section, spec.length + 2);
        for (const dv of solids.dovetails) { const t = dv.tongue.intersect(fp); dv.tongue.delete(); dv.tongue = t; }
        fp.delete();
      }
      const out = csg.applyConnectors(A, B, solids, { whole: originalManifold(part).man });
      A = out.A; B = out.B;
    }
    const r = { A: csg.fromManifold(A), B: csg.fromManifold(B), warnings, placements: plan.placements };
    A.delete(); B.delete();
    return r;
  } finally {
    disposePlan(plan);
  }
}
