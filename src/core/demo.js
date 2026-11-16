// Procedural demo model: a stylised bust with hair, ears and nose (Z up, millimetres).
import { getW, fromManifold } from './csg.js';

export function buildDemoBust() {
  const w = getW();
  const M = w.Manifold;
  const seg = 96;
  const track = [];
  const t = (m) => { track.push(m); return m; };
  const head = t(t(M.sphere(20, seg)).scale([0.92, 1.0, 1.12])).translate([0, 0, 72]);
  // hair: a slightly bigger shell trimmed by a tilted plane (higher on the forehead, lower at the nape)
  const hairShell = t(t(t(M.sphere(22.6, seg)).scale([0.98, 1.06, 1.12])).translate([0, 1.5, 74]));
  const n = [0, 0.42, 1];
  const nl = Math.hypot(...n);
  const nn = n.map((x) => x / nl);
  const hairCut = t(hairShell.trimByPlane(nn, nn[2] * 74 + nn[1] * -2));
  // a tuft of hair at the back
  const bun = t(t(t(M.sphere(9, seg)).scale([1.1, 0.9, 1])).translate([0, 20, 84]));
  const hair = t(hairCut.add(bun));
  const earL = t(t(t(M.sphere(5.5, 48)).scale([0.45, 0.9, 1.25])).translate([-18.2, 1.5, 65.5]));
  const earR = t(t(t(M.sphere(5.5, 48)).scale([0.45, 0.9, 1.25])).translate([18.2, 1.5, 65.5]));
  const nose = t(t(t(M.sphere(4.2, 48)).scale([0.75, 1.1, 1.2])).translate([0, -19.2, 70]));
  const neck = t(t(M.cylinder(26, 8.5, 9.5, seg)).translate([0, 2, 38]));
  const torso = t(t(t(M.sphere(30, seg)).scale([1.45, 0.78, 0.82])).translate([0, 2, 22]));
  const torsoCut = t(torso.trimByPlane([0, 0, 1], 4));
  const body = t(M.union([head, hair, earL, earR, nose, neck, torsoCut]));
  const out = fromManifold(body);
  track.forEach((m) => m.delete());
  return out;
}
