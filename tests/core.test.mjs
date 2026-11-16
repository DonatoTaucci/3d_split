// Core geometry tests (run with `npm test`). Uses the procedural demo bust, no downloads.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import * as csg from '../src/core/csg.js';
import { buildDemoBust } from '../src/core/demo.js';
import { weld, MeshData } from '../src/core/meshdata.js';
import { analyzeMesh } from '../src/core/patches.js';
import { smartSelect, autoSegment, refineFaceLabels, cleanFaceMask } from '../src/core/segment.js';
import { splitByMask } from '../src/core/split.js';
import { fitPlaneToSelection, performCut } from '../src/core/cutter.js';
import { repairMesh } from '../src/core/repair.js';
import { parse3MF } from '../src/io/threemf.js';
import { to3MF } from '../src/io/exporters.js';

let mesh, an, hairSel;

function closedSingle(m) {
  const w = weld(m.pos, m.tri);
  const md = new MeshData(w.pos, w.tri);
  return { closed: md.isClosed(), comps: md.numComponents, vol: md.signedVolume() };
}

before(async () => {
  await csg.initManifold();
  const d = buildDemoBust();
  const w = weld(d.pos, d.tri);
  mesh = new MeshData(w.pos, w.tri);
  an = analyzeMesh(mesh);
  // click on the top of the head (hair)
  let top = 0;
  for (let p = 0; p < an.graph.n; p++) if (an.graph.centroid[3 * p + 2] > an.graph.centroid[3 * top + 2]) top = p;
  const r = smartSelect(an.graph, top);
  const lab = new Int32Array(an.graph.n);
  for (let p = 0; p < an.graph.n; p++) lab[p] = r.candidates[r.best].mask[p];
  const fl = refineFaceLabels(mesh, an.aff, an.graph, lab);
  hairSel = new Uint8Array(mesh.nf);
  for (let f = 0; f < mesh.nf; f++) hairSel[f] = fl[f] === 1 ? 1 : 0;
  cleanFaceMask(mesh, hairSel);
});

test('demo bust is a closed single solid', () => {
  assert.equal(mesh.isClosed(), true);
  assert.equal(mesh.numComponents, 1);
  assert.ok(mesh.signedVolume() > 0);
});

test('weld merges a triangle soup', () => {
  const soup = new Float32Array(mesh.nf * 9);
  for (let f = 0; f < mesh.nf; f++) for (let k = 0; k < 3; k++) for (let c = 0; c < 3; c++) soup[9 * f + 3 * k + c] = mesh.pos[3 * mesh.tri[3 * f + k] + c];
  const w = weld(soup, null);
  assert.equal(w.pos.length / 3, mesh.nv);
  assert.equal(w.tri.length / 3, mesh.nf);
});

test('clicking the hair selects the hair cap', () => {
  let a = 0, zmin = Infinity;
  for (let f = 0; f < mesh.nf; f++) if (hairSel[f]) { a += mesh.faceArea[f]; zmin = Math.min(zmin, mesh.faceCenter[3 * f + 2]); }
  const frac = a / mesh.totalArea;
  assert.ok(frac > 0.18 && frac < 0.32, `hair area fraction ${frac}`);
  assert.ok(zmin > 60, `hair should stay above the ears, min z ${zmin}`);
});

test('automatic segmentation finds several parts', () => {
  const seg = autoSegment(an.graph, { threshold: 0.9 });
  assert.ok(seg.count >= 3 && seg.count <= 12, `segments ${seg.count}`);
});

test('membrane split gives two closed pieces whose volumes add up', () => {
  const r = splitByMask(mesh, hairSel);
  const a = closedSingle(r.A), b = closedSingle(r.B);
  assert.equal(a.closed, true);
  assert.equal(b.closed, true);
  assert.equal(a.comps, 1);
  assert.equal(b.comps, 1);
  assert.ok(Math.abs(a.vol + b.vol - mesh.signedVolume()) < 1e-3 * mesh.signedVolume());
});

for (const method of ['membrane', 'plane']) {
  for (const type of ['peg-round', 'peg-square', 'magnet', 'dovetail']) {
    if (method === 'membrane' && type === 'dovetail') continue;
    for (const maleOn of ['A', 'B']) {
      test(`${method} cut with ${type} on ${maleOn} yields closed single solids`, () => {
        const part = { mesh };
        const plane = fitPlaneToSelection(mesh, hairSel);
        const spec = { type, diameter: 6, length: 4, tolerance: 0.2, count: 2, maleOn, angle: 15 };
        const res = performCut({ part, sel: hairSel, method, plane, spec, onlySelected: true });
        part._manifold?.man.delete();
        assert.deepEqual(res.warnings, []);
        const a = closedSingle(res.A), b = closedSingle(res.B);
        assert.equal(a.closed && b.closed, true);
        assert.equal(a.comps, 1);
        assert.equal(b.comps, 1);
      });
    }
  }
}

test('repair closes holes and removes non-manifold fins', () => {
  // punch a hole and add a fin triangle on an existing edge
  const tri = Array.from(mesh.tri.slice(30));
  const e0 = mesh.tri[100], e1 = mesh.tri[101];
  const pos = Array.from(mesh.pos);
  pos.push(0, 0, 200);
  const fin = pos.length / 3 - 1;
  tri.push(e0, e1, fin);
  const w = weld(Float32Array.from(pos), Uint32Array.from(tri));
  const broken = new MeshData(w.pos, w.tri);
  assert.equal(broken.isClosed(), false);
  const { mesh: fixed } = repairMesh(broken);
  assert.equal(fixed.isClosed(), true);
});

test('3MF export round-trips through the fast parser', () => {
  const bytes = to3MF([{ name: 'a', pos: mesh.pos, tri: mesh.tri, color: '#ff8800' }]);
  const parsed = parse3MF(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].indices.length, mesh.tri.length);
  const w = weld(parsed[0].positions, parsed[0].indices);
  assert.equal(new MeshData(w.pos, w.tri).isClosed(), true);
});
