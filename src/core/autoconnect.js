// Automatic connector sizing: picks diameter, length and number of connectors for a cut
// from the shape of its section and the material available on both sides.
import { connectorClearance, placeConnectors } from './csg.js';

/** common neodymium disc magnets: [diameter, thickness] mm, largest first */
export const MAGNET_SIZES = [
  [15, 3], [12, 3], [10, 3], [10, 2], [8, 3], [8, 2], [6, 3], [6, 2], [5, 3], [5, 2], [4, 2], [3, 2], [3, 1],
];

const WALL = 0.8; // minimum wall/floor left around holes (mm)
const floorStep = (x, step = 0.5) => Math.floor(x / step + 1e-9) * step;

/**
 * Material depth available on each side of the cut along the connector axis: rays parallel
 * to the axis (centre + a ring of radius `radius`) are cast against every triangle and the
 * thinnest hit is kept. Exact and independent of mesh density.
 * @returns {{A:number, B:number}} A: towards -axis (piece A), B: towards +axis (piece B)
 */
export function availableDepths(mesh, point, axis, radius) {
  const { pos, tri, nv, nf } = mesh;
  const [ax, ay, az] = axis;
  const ref = Math.abs(ax) < 0.8 ? [1, 0, 0] : [0, 1, 0];
  let ux = ref[1] * az - ref[2] * ay, uy = ref[2] * ax - ref[0] * az, uz = ref[0] * ay - ref[1] * ax;
  const ul = Math.hypot(ux, uy, uz);
  ux /= ul; uy /= ul; uz /= ul;
  const vx = ay * uz - az * uy, vy = az * ux - ax * uz, vz = ax * uy - ay * ux;
  const X = new Float32Array(nv), Y = new Float32Array(nv), H = new Float32Array(nv);
  for (let i = 0; i < nv; i++) {
    const dx = pos[3 * i] - point[0], dy = pos[3 * i + 1] - point[1], dz = pos[3 * i + 2] - point[2];
    X[i] = dx * ux + dy * uy + dz * uz;
    Y[i] = dx * vx + dy * vy + dz * vz;
    H[i] = dx * ax + dy * ay + dz * az;
  }
  const rays = [[0, 0]];
  for (let k = 0; k < 6; k++) rays.push([radius * Math.cos((k * Math.PI) / 3), radius * Math.sin((k * Math.PI) / 3)]);
  const eps = Math.max(0.05, mesh.bounds.diag * 1e-4);
  let A = Infinity, B = Infinity;
  for (let f = 0; f < nf; f++) {
    const a = tri[3 * f], b = tri[3 * f + 1], c = tri[3 * f + 2];
    const xa = X[a], xb = X[b], xc = X[c], ya = Y[a], yb = Y[b], yc = Y[c];
    const minx = Math.min(xa, xb, xc), maxx = Math.max(xa, xb, xc);
    if (maxx < -radius || minx > radius) continue;
    const miny = Math.min(ya, yb, yc), maxy = Math.max(ya, yb, yc);
    if (maxy < -radius || miny > radius) continue;
    const det = (yb - yc) * (xa - xc) + (xc - xb) * (ya - yc);
    if (Math.abs(det) < 1e-14) continue;
    for (const [rx, ry] of rays) {
      if (rx < minx || rx > maxx || ry < miny || ry > maxy) continue;
      const l1 = ((yb - yc) * (rx - xc) + (xc - xb) * (ry - yc)) / det;
      const l2 = ((yc - ya) * (rx - xc) + (xa - xc) * (ry - yc)) / det;
      const l3 = 1 - l1 - l2;
      if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue;
      const h = l1 * H[a] + l2 * H[b] + l3 * H[c];
      if (h > eps) { if (h < B) B = h; } else if (h < -eps) { if (-h < A) A = -h; }
    }
  }
  if (!isFinite(A) || !isFinite(B)) {
    const bb = bboxDepths(mesh, point, axis);
    if (!isFinite(A)) A = bb.A;
    if (!isFinite(B)) B = bb.B;
  }
  return { A, B };
}

function bboxDepths(mesh, point, axis) {
  const { min, max } = mesh.bounds;
  let A = 0, B = 0;
  for (let k = 0; k < 8; k++) {
    const c = [(k & 1 ? max : min)[0], (k & 2 ? max : min)[1], (k & 4 ? max : min)[2]];
    const h = (c[0] - point[0]) * axis[0] + (c[1] - point[1]) * axis[1] + (c[2] - point[2]) * axis[2];
    if (h > B) B = h;
    if (-h > A) A = -h;
  }
  return { A, B };
}

function desiredCount(stats, d) {
  const perConnector = Math.PI * (2.5 * d) ** 2; // area "served" by one connector
  let n = Math.round(stats.area / perConnector);
  if (stats.elong > 1.8) n = Math.max(n, 2);
  return Math.max(1, Math.min(4, n));
}

/** largest n <= want whose centres fit with the given spacing */
function fitCount(cs, want, clearance, spacing) {
  for (let n = want; n >= 1; n--) {
    const pc = placeConnectors(cs, n, clearance);
    if (pc.points.length === n && (n === 1 || pc.minDist >= spacing)) return n;
  }
  return 0;
}

/**
 * @param base  user spec (type, tolerance, maleOn, angle)
 * @param stats sectionStats() of the cut section
 * @param depths availableDepths() at the deepest point of the section
 * @param cs    the section (CrossSection) used to check that the connectors fit
 * @returns {{spec?:object, note?:string, unfit?:string}}
 */
export function autoConnectorSpec(base, stats, depths, cs) {
  const tol = base.tolerance;
  const R = stats.maxDepth;
  const W = 2 * R; // widest circle that fits in the section
  const female = base.maleOn === 'B' ? depths.A : depths.B;
  const both = Math.min(depths.A, depths.B);
  const spec = { ...base, auto: true };
  if (base.type === 'peg-round' || base.type === 'peg-square') {
    // dowel diameter ~ 1/3 of the local thickness, 2..10 mm, leaving a wall around the hole
    let d = Math.min(10, floorStep(W / 3));
    while (d >= 2 && connectorClearance({ ...spec, diameter: d }) > R) d -= 0.5;
    if (d < 2) return { unfit: `Sezione troppo stretta per un perno (spessore utile ${W.toFixed(1)} mm): incolla i pezzi o taglia in un punto più spesso.` };
    let L = Math.min(12, Math.max(3, 1.5 * d), female - tol - WALL);
    L = floorStep(L);
    if (L < Math.max(1.5, 0.6 * d)) {
      return { unfit: `Il pezzo che riceve il foro è troppo sottile (${isFinite(female) ? female.toFixed(1) : '?'} mm): usa "Perno su" sull'altro pezzo oppure incolla.` };
    }
    const spacing = d + 2 * tol + 2 * WALL + 1;
    let want = desiredCount(stats, d);
    // a single round peg lets the piece rotate: prefer two when there is room
    if (base.type === 'peg-round' && want === 1 && stats.area > Math.PI * (2.5 * d) ** 2 * 0.6) want = 2;
    const clearance = connectorClearance({ ...spec, diameter: d });
    let n = fitCount(cs, want, clearance, spacing);
    if (base.type === 'peg-round' && n <= 1) {
      // two smaller pegs stop the piece from rotating: use them if they fit
      const d2 = Math.max(2, floorStep(d * 0.7));
      const sp2 = d2 + 2 * tol + 2 * WALL + 1;
      if (fitCount(cs, 2, connectorClearance({ ...spec, diameter: d2 }), sp2) === 2) {
        d = d2;
        L = floorStep(Math.min(12, Math.max(3, 1.5 * d), female - tol - WALL));
        n = 2;
      }
    }
    Object.assign(spec, { diameter: d, length: L, count: Math.max(1, n) });
    let note = '';
    if (spec.count === 1 && base.type === 'peg-round') note = 'Con un solo perno tondo il pezzo può ruotare: valuta il perno quadrato.';
    return { spec, note };
  }
  if (base.type === 'magnet') {
    for (const [D, t] of MAGNET_SIZES) {
      if (D / 2 + tol + WALL > R) continue;
      if (t + tol + 0.6 > both) continue;
      const sp = { ...spec, diameter: D, length: t };
      const clearance = connectorClearance(sp);
      const want = Math.max(desiredCount(stats, D), stats.area > Math.PI * (2.5 * D) ** 2 * 0.6 ? 2 : 1);
      const n = fitCount(cs, want, clearance, D + 2 * tol + 2 * WALL + 1);
      if (!n) continue;
      sp.count = n;
      return { spec: sp, note: `Magneti ${D}×${t} mm (diametro × spessore).` };
    }
    return { unfit: `Nessun magnete standard (da 3×1 mm in su) entra in questa sezione (spessore utile ${W.toFixed(1)} mm).` };
  }
  if (base.type === 'dovetail') {
    const ta = Math.tan(((base.angle ?? 15) * Math.PI) / 180);
    let w = Math.min(16, floorStep(W * 0.35));
    while (w >= 3) {
      let h = Math.min(8, Math.max(2, floorStep(w * 0.5)), floorStep(female - tol - 1));
      if (h >= 1.5 && connectorClearance({ ...spec, diameter: w, length: h }) <= R) {
        Object.assign(spec, { diameter: w, length: h, count: 1 });
        return { spec, note: '' };
      }
      w -= 0.5;
      void ta;
    }
    return { unfit: `Sezione troppo stretta per una coda di rondine (spessore utile ${W.toFixed(1)} mm).` };
  }
  return { spec };
}

/** human readable summary of a connector spec */
export function describeSpec(spec) {
  const n = spec.count || 1;
  const f = (x) => (Number.isInteger(x) ? String(x) : x.toFixed(1));
  if (spec.type === 'peg-round') return `${n} ${n === 1 ? 'perno' : 'perni'} Ø ${f(spec.diameter)} mm, lunghezza ${f(spec.length)} mm`;
  if (spec.type === 'peg-square') return `${n} ${n === 1 ? 'perno quadrato' : 'perni quadrati'} ${f(spec.diameter)} mm, lunghezza ${f(spec.length)} mm`;
  if (spec.type === 'magnet') return `${n} ${n === 1 ? 'magnete' : 'magneti'} ${f(spec.diameter)}×${f(spec.length)} mm`;
  if (spec.type === 'dovetail') return `coda di rondine larga ${f(spec.diameter)} mm, alta ${f(spec.length)} mm`;
  return '';
}
