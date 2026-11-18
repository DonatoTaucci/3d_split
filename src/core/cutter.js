// High-level cut pipeline used by the UI: plane fitting, previews and final split.
import { boundaryLoops, loopFrame, computeCaps, splitByMask } from './split.js';
import * as csg from './csg.js';
import { autoConnectorSpec, availableDepths, describeSpec } from './autoconnect.js';

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
    // the main attachment encloses the largest area (a strand touching the body is long but thin)
    if (!best || fr.area > best.area) best = fr;
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
  // inset slightly so the tongue never shares surface with the outside of the model
  const inner = sec.cs.offset(-0.3, 'Round');
  const ext = w.Manifold.extrude(inner.isEmpty() ? sec.cs : inner, depth * 2, 0, 0, [1, 1], true);
  inner.delete();
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

function tooSmall(spec, maxDepth) {
  const m = csg.maxConnectorSize(spec, maxDepth);
  const what = spec.type === 'dovetail' ? 'larghezza' : spec.type === 'peg-square' ? 'lato' : 'diametro';
  return m >= 1
    ? `Sezione troppo stretta per questo connettore: ${what} massimo ≈ ${m.toFixed(1)} mm (spessore utile ${(maxDepth * 2).toFixed(1)} mm).`
    : `Sezione troppo stretta per un connettore (spessore utile ${(maxDepth * 2).toFixed(1)} mm): incolla i pezzi o scegli un altro taglio.`;
}

function outlineFromSection(sec, res) {
  const polys = sec.cs.toPolygons().map((p) => p.map((q) => [q[0] ?? q.x, q[1] ?? q.y]));
  const { u, v } = sec.basis;
  const o = sec.origin;
  for (const p of polys) {
    res.outline.push(p.map((q) => [o[0] + u[0] * q[0] + v[0] * q[1], o[1] + u[1] * q[0] + v[1] * q[1], o[2] + u[2] * q[0] + v[2] * q[1]]));
  }
}

/**
 * Decide the connector spec for a section: automatic sizing (spec.auto) or the user's
 * values, with a warning when a manual hole would go through the other piece.
 * @param toWorld (x,y) -> 3D point on the cut surface; axis: unit vector from A into B
 * @returns spec to use, or null (res.warning explains why)
 */
function resolveSpec(ctx, res, cs, toWorld, axis) {
  const spec = ctx.spec;
  const mesh = ctx.part.mesh;
  const stats = csg.sectionStats(cs);
  res.maxDepth = stats.maxDepth;
  if (stats.maxDepth <= 0) { res.warning = 'Sezione di taglio vuota.'; return null; }
  const p3 = toWorld(stats.deepest[0], stats.deepest[1]);
  const radius = Math.max(stats.maxDepth * 0.35, mesh.avgEdgeLen * 2, spec.auto ? 0 : spec.diameter / 2 + spec.tolerance);
  const depths = availableDepths(mesh, p3, axis, radius);
  res.depths = depths;
  if (!spec.auto) {
    const tol = spec.tolerance;
    if (spec.type === 'magnet') {
      const both = Math.min(depths.A, depths.B);
      if (spec.length + tol + 0.4 > both) res.note = `Attenzione: la sede del magnete (${(spec.length + tol).toFixed(1)} mm) è più profonda dello spessore disponibile (${both.toFixed(1)} mm).`;
    } else if (spec.type !== 'none') {
      const female = spec.maleOn === 'B' ? depths.A : depths.B;
      if (spec.length + tol + 0.4 > female) res.note = `Attenzione: il foro (${(spec.length + tol).toFixed(1)} mm) rischia di bucare il pezzo, spesso solo ${female.toFixed(1)} mm in quel punto.`;
    }
    return spec;
  }
  const r = autoConnectorSpec(spec, stats, depths, cs);
  if (r.unfit) { res.warning = r.unfit; return null; }
  res.spec = r.spec;
  res.note = [describeSpec(r.spec), r.note].filter(Boolean).join(' · ');
  return r.spec;
}

function placeOnSection(sec, spec, res) {
  const pc = csg.placeConnectors(sec.cs, spec.type === 'dovetail' ? 1 : spec.count, csg.connectorClearance(spec));
  const slide = spec.type === 'dovetail' ? csg.sectionPrincipalAxis(pc.polys) : null;
  res.placements = csg.planarPlacements(pc.points, sec.basis, sec.origin, slide);
  res.span = sectionSpan(pc.polys);
  res.maxDepth = pc.maxDepth;
  if (!res.placements.length) res.warning = tooSmall(spec, pc.maxDepth);
}

/**
 * Cheap plane preview: slice the whole solid (no boolean) and keep the section regions
 * that belong to the selected part.
 */
function planePreview(ctx, res) {
  const { part, sel, plane, spec } = ctx;
  const mesh = part.mesh;
  const { man } = originalManifold(part);
  const sec = csg.sliceAtPlane(man, plane, mesh.bounds.diag * 1e-5);
  res.section = sec;
  if (sec.cs.isEmpty()) { res.warning = 'Il piano non taglia il modello.'; return res; }
  if (ctx.onlySelected && sel) {
    const nl = Math.hypot(...plane.normal) || 1;
    const n = plane.normal.map((x) => x / nl);
    const o = plane.origin;
    const band = Math.max(mesh.avgEdgeLen * 4, mesh.bounds.diag * 0.02);
    const { u, v } = sec.basis;
    const pts = [];
    for (let f = 0; f < mesh.nf; f++) {
      if (!sel[f]) continue;
      const dx = mesh.faceCenter[3 * f] - o[0], dy = mesh.faceCenter[3 * f + 1] - o[1], dz = mesh.faceCenter[3 * f + 2] - o[2];
      const h = dx * n[0] + dy * n[1] + dz * n[2];
      if (h <= 0 || h > band) continue;
      pts.push([dx * u[0] + dy * u[1] + dz * u[2], dx * v[0] + dy * v[1] + dz * v[2]]);
    }
    const regions = sec.cs.decompose();
    const kept = [];
    const step = Math.max(1, Math.floor(pts.length / 3000));
    for (const r of regions) {
      const polys = r.toPolygons().map((p) => p.map((q) => [q[0] ?? q.x, q[1] ?? q.y]));
      let hit = false;
      for (let i = 0; i < pts.length && !hit; i += step) hit = csg.pointInPolys(polys, pts[i][0], pts[i][1]);
      if (hit) kept.push(r); else r.delete();
    }
    if (kept.length) {
      const w = csg.getW();
      const merged = kept.length === 1 ? kept[0] : w.CrossSection.union(kept);
      if (kept.length > 1) kept.forEach((r) => r.delete());
      sec.cs.delete();
      sec.cs = merged;
    }
  }
  outlineFromSection(sec, res);
  if (spec && spec.type !== 'none') {
    const use = resolveSpec(ctx, res, sec.cs, planeToWorld(sec), planeAxis(sec));
    if (use) placeOnSection(sec, use, res);
  }
  return res;
}

const planeToWorld = (sec) => (x, y) => {
  const { u, v } = sec.basis, o = sec.origin;
  return [o[0] + u[0] * x + v[0] * y, o[1] + u[1] * x + v[1] * y, o[2] + u[2] * x + v[2] * y];
};
const planeAxis = (sec) => [-sec.basis.n[0], -sec.basis.n[1], -sec.basis.n[2]]; // A (+n side) -> B

/**
 * Compute connector placements (for preview and for the final cut).
 * ctx: {part, sel, method, plane, spec, onlySelected, preview}
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
    // several cut loops (e.g. hair touching the body): use the one with the most room
    let bestCap = null, bestDepth = -1;
    for (const cap of caps.slice(0, 8)) {
      if (cap.loopPositions.length < 9) continue;
      const sec = csg.capSection(cap);
      const st = csg.sectionStats(sec.cs);
      sec.cs.delete();
      if (st.maxDepth > bestDepth) { bestDepth = st.maxDepth; bestCap = cap; }
    }
    if (!bestCap) { res.warning = 'Sezione di taglio troppo piccola.'; return res; }
    const sec = csg.capSection(bestCap);
    const use = resolveSpec(ctx, res, sec.cs, sec.lift, sec.basis.n);
    sec.cs.delete();
    if (!use) return res;
    const mp = csg.membranePlacements(bestCap, use);
    res.placements = mp.placements;
    res.maxDepth = mp.maxDepth;
    if (!res.placements.length) res.warning = tooSmall(use, res.maxDepth);
    return res;
  }
  if (ctx.preview) return planePreview(ctx, res);
  // plane (exact)
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
  outlineFromSection(sec, res);
  if (!spec || spec.type === 'none') return res;
  const use = resolveSpec(ctx, res, sec.cs, planeToWorld(sec), planeAxis(sec));
  if (use) placeOnSection(sec, use, res);
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
    const used = plan.spec || spec;
    const solids = csg.buildConnectorSolids(used, plan.placements);
    const out = csg.applyConnectors(A, B, solids);
    const r = { A: csg.fromManifold(out.A), B: csg.fromManifold(out.B), warnings, placements: plan.placements, spec: used, note: plan.note };
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
    const used = plan.spec || spec;
    if (useConn && plan.placements.length) {
      const extra = { span: plan.span };
      const solids = csg.buildConnectorSolids(used, plan.placements, extra);
      if (solids.dovetails.length) {
        const fp = footprintFromSection(plan.section, used.length + 2);
        for (const dv of solids.dovetails) { const t = dv.tongue.intersect(fp); dv.tongue.delete(); dv.tongue = t; }
        fp.delete();
      }
      const out = csg.applyConnectors(A, B, solids, { whole: originalManifold(part).man });
      A = out.A; B = out.B;
    }
    const r = { A: csg.fromManifold(A), B: csg.fromManifold(B), warnings, placements: plan.placements, spec: useConn && plan.placements.length ? used : null, note: plan.note };
    A.delete(); B.delete();
    return r;
  } finally {
    disposePlan(plan);
  }
}
