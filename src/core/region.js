// Re-run part detection inside one region only, at a finer resolution, leaving the rest intact.
import { MeshData, extractFaces } from './meshdata.js';
import { analyzeMesh } from './patches.js';
import { autoSegment, refineFaceLabels } from './segment.js';

/**
 * @param mesh       MeshData of the whole part
 * @param regionMask Uint8Array per face (1 = inside the region to re-segment)
 * @param opts       {threshold, minFraction} (minFraction is relative to the region area)
 * @returns {{faces:Int32Array, labels:Int32Array, count:number}} labels per region face (0..count-1)
 */
export function segmentRegion(mesh, regionMask, opts = {}) {
  const faces = [];
  for (let f = 0; f < mesh.nf; f++) if (regionMask[f]) faces.push(f);
  if (faces.length < 8) return { faces: Int32Array.from(faces), labels: new Int32Array(faces.length), count: 1 };
  const sub = extractFaces(mesh, regionMask); // keeps increasing face order
  let group = null;
  if (mesh.faceGroup) group = Int32Array.from(faces, (f) => mesh.faceGroup[f]);
  const sm = new MeshData(sub.pos, sub.tri, group);
  // finer patches than the global analysis: the region gets its own budget
  const targetPatches = Math.min(4000, Math.max(120, Math.round(sm.nf / 10)));
  const an = analyzeMesh(sm, { targetPatches });
  const seg = autoSegment(an.graph, {
    threshold: opts.threshold ?? 1.1,
    minFraction: opts.minFraction ?? 0.04,
    maxSegments: opts.maxSegments ?? 24,
  });
  const labels = refineFaceLabels(sm, an.aff, an.graph, seg.labels);
  absorbTinyLabels(sm, labels, sm.totalArea * (opts.minPieceFraction ?? 0.004));
  // keep labels compact (refinement may drop a tiny label)
  const remap = new Map();
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i] < 0 ? 0 : labels[i];
    if (!remap.has(l)) remap.set(l, remap.size);
    labels[i] = remap.get(l);
  }
  return { faces: Int32Array.from(faces), labels, count: Math.max(1, remap.size) };
}

/** labels covering less than `minArea` are merged into the neighbouring label they touch most */
export function absorbTinyLabels(mesh, labels, minArea) {
  for (let pass = 0; pass < 4; pass++) {
    const area = new Map();
    for (let f = 0; f < mesh.nf; f++) area.set(labels[f], (area.get(labels[f]) || 0) + mesh.faceArea[f]);
    const tiny = new Set([...area].filter(([, a]) => a < minArea).map(([l]) => l));
    if (!tiny.size || tiny.size === area.size) return labels;
    let changed = 0;
    // grow the surrounding labels into the tiny ones, front by front
    for (let it = 0; it < 200; it++) {
      let moved = 0;
      for (let f = 0; f < mesh.nf; f++) {
        if (!tiny.has(labels[f])) continue;
        for (let i = mesh.faceLinkStart[f]; i < mesh.faceLinkStart[f + 1]; i++) {
          const g = mesh.other(mesh.faceLinks[i], f);
          if (!tiny.has(labels[g])) { labels[f] = labels[g]; moved++; break; }
        }
      }
      changed += moved;
      if (!moved) break;
    }
    if (!changed) return labels;
  }
  return labels;
}
