// Mesh repair for printing: remove non-manifold fins, fix orientation, close holes.
import { weld, MeshData } from './meshdata.js';
import { fillHoles, orientConsistently } from './split.js';

function dropFaces(mesh, drop) {
  const keep = [];
  for (let f = 0; f < mesh.nf; f++) if (!drop[f]) keep.push(mesh.tri[3 * f], mesh.tri[3 * f + 1], mesh.tri[3 * f + 2]);
  const w = weld(mesh.pos, Uint32Array.from(keep));
  return new MeshData(w.pos, w.tri);
}

/**
 * @returns {{mesh: MeshData, report: {removedFaces:number, flipped:number, holesFilled:number, removedSpecks:number}}}
 */
export function repairMesh(input, opts = {}) {
  const report = { removedFaces: 0, flipped: 0, holesFilled: 0, removedSpecks: 0, rounds: 0 };
  let mesh = input;
  for (let round = 0; round < 4; round++) {
    mesh = repairRound(mesh, report, opts);
    report.rounds = round + 1;
    if (mesh.isClosed()) break;
  }
  return { mesh, report };
}

function repairRound(input, report, opts) {
  let mesh = input;
  // 1. faces on non-manifold edges (edges shared by 3+ triangles)
  for (let pass = 0; pass < 6 && mesh.nonManifoldEdges > 0; pass++) {
    const drop = new Uint8Array(mesh.nf);
    for (let e = 0; e < mesh.ne; e++) {
      const s = mesh.edgeHEStart[e], t = mesh.edgeHEStart[e + 1];
      if (t - s <= 2) continue;
      for (let k = s; k < t; k++) drop[(mesh.edgeHE[k] / 3) | 0] = 1;
    }
    for (let f = 0; f < mesh.nf; f++) report.removedFaces += drop[f];
    mesh = dropFaces(mesh, drop);
  }
  // 2. tiny open specks (a handful of loose triangles) are removed
  const minFaces = opts.minComponentFaces ?? 12;
  if (mesh.numComponents > 1) {
    const drop = new Uint8Array(mesh.nf);
    let any = false;
    for (let f = 0; f < mesh.nf; f++) {
      if (mesh.compFaces[mesh.faceComp[f]] < minFaces) { drop[f] = 1; any = true; report.removedSpecks++; }
    }
    if (any) mesh = dropFaces(mesh, drop);
  }
  // 3. consistent outward orientation
  const o = orientConsistently(mesh);
  report.flipped = o.flips;
  mesh = new MeshData(mesh.pos, o.tri);
  // 4. close holes (twice: filling can expose new small loops at pinch vertices)
  for (let pass = 0; pass < 2 && mesh.boundaryEdges > 0; pass++) {
    const fh = fillHoles(mesh);
    report.holesFilled += fh.filled;
    const w = weld(fh.pos, fh.tri);
    mesh = new MeshData(w.pos, w.tri);
  }
  return mesh;
}
