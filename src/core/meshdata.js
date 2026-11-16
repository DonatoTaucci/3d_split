// Welded triangle mesh with face-adjacency topology and per-face / per-link geometry.
// Pure JS (no three.js) so it can be used in workers and in Node tests.

function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

export function computeBounds(pos) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = pos[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  const dx = max[0] - min[0], dy = max[1] - min[1], dz = max[2] - min[2];
  return { min, max, diag: Math.sqrt(dx * dx + dy * dy + dz * dz) || 1 };
}

/**
 * Merge coincident vertices, drop degenerate and duplicated triangles.
 * @param {ArrayLike<number>} positions xyz triplets
 * @param {ArrayLike<number>|null} indices triangle indices or null for a triangle soup
 * @param {Int32Array|null} faceGroupIn optional per-input-triangle group id
 * @returns {{pos: Float32Array, tri: Uint32Array, faceSrc: Int32Array, faceGroup: Int32Array|null}}
 */
export function weld(positions, indices = null, faceGroupIn = null, tolRel = 1e-6) {
  const nvIn = Math.floor(positions.length / 3);
  const b = computeBounds(positions);
  const q = b.diag * tolRel;
  const table = new Int32Array(nextPow2(Math.max(16, nvIn * 2))).fill(-1);
  const mask = table.length - 1;
  const qx = new Int32Array(nvIn), qy = new Int32Array(nvIn), qz = new Int32Array(nvIn);
  const remap = new Int32Array(nvIn);
  const outPos = new Float32Array(nvIn * 3);
  let nv = 0;
  for (let i = 0; i < nvIn; i++) {
    const x = positions[3 * i], y = positions[3 * i + 1], z = positions[3 * i + 2];
    const ix = Math.round((x - b.min[0]) / q);
    const iy = Math.round((y - b.min[1]) / q);
    const iz = Math.round((z - b.min[2]) / q);
    let h = (Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ Math.imul(iz, 83492791)) & mask;
    for (;;) {
      const s = table[h];
      if (s === -1) {
        table[h] = nv;
        qx[nv] = ix; qy[nv] = iy; qz[nv] = iz;
        outPos[3 * nv] = x; outPos[3 * nv + 1] = y; outPos[3 * nv + 2] = z;
        remap[i] = nv++;
        break;
      }
      if (qx[s] === ix && qy[s] === iy && qz[s] === iz) {
        remap[i] = s;
        break;
      }
      h = (h + 1) & mask;
    }
  }
  const nfIn = indices ? Math.floor(indices.length / 3) : Math.floor(nvIn / 3);
  const tri = new Uint32Array(nfIn * 3);
  const faceSrc = new Int32Array(nfIn);
  const faceGroup = faceGroupIn ? new Int32Array(nfIn) : null;
  // duplicate-face detection hash on sorted vertex triplets
  const ftable = new Int32Array(nextPow2(Math.max(16, nfIn * 2))).fill(-1);
  const fmask = ftable.length - 1;
  let nf = 0;
  for (let f = 0; f < nfIn; f++) {
    let a, bb, c;
    if (indices) {
      a = remap[indices[3 * f]]; bb = remap[indices[3 * f + 1]]; c = remap[indices[3 * f + 2]];
    } else {
      a = remap[3 * f]; bb = remap[3 * f + 1]; c = remap[3 * f + 2];
    }
    if (a === bb || bb === c || a === c) continue;
    // sorted key
    let s0 = a, s1 = bb, s2 = c, t;
    if (s0 > s1) { t = s0; s0 = s1; s1 = t; }
    if (s1 > s2) { t = s1; s1 = s2; s2 = t; }
    if (s0 > s1) { t = s0; s0 = s1; s1 = t; }
    let h = (Math.imul(s0, 0x9e3779b1) ^ Math.imul(s1, 0x85ebca77) ^ Math.imul(s2, 0xc2b2ae3d)) & fmask;
    let dup = false;
    for (;;) {
      const g = ftable[h];
      if (g === -1) { ftable[h] = nf; break; }
      let u0 = tri[3 * g], u1 = tri[3 * g + 1], u2 = tri[3 * g + 2];
      if (u0 > u1) { t = u0; u0 = u1; u1 = t; }
      if (u1 > u2) { t = u1; u1 = u2; u2 = t; }
      if (u0 > u1) { t = u0; u0 = u1; u1 = t; }
      if (u0 === s0 && u1 === s1 && u2 === s2) { dup = true; break; }
      h = (h + 1) & fmask;
    }
    if (dup) continue;
    tri[3 * nf] = a; tri[3 * nf + 1] = bb; tri[3 * nf + 2] = c;
    faceSrc[nf] = f;
    if (faceGroup) faceGroup[nf] = faceGroupIn[f];
    nf++;
  }
  // compact unused vertices
  const used = new Int32Array(nv).fill(-1);
  let nv2 = 0;
  for (let i = 0; i < nf * 3; i++) {
    const v = tri[i];
    if (used[v] === -1) used[v] = nv2++;
    tri[i] = used[v];
  }
  const pos = new Float32Array(nv2 * 3);
  for (let v = 0; v < nv; v++) {
    const u = used[v];
    if (u >= 0) {
      pos[3 * u] = outPos[3 * v];
      pos[3 * u + 1] = outPos[3 * v + 1];
      pos[3 * u + 2] = outPos[3 * v + 2];
    }
  }
  return {
    pos,
    tri: tri.slice(0, nf * 3),
    faceSrc: faceSrc.slice(0, nf),
    faceGroup: faceGroup ? faceGroup.slice(0, nf) : null,
  };
}

/**
 * Topology + geometry of a welded triangle mesh.
 * "Links" are the edges of the face-dual graph (pairs of faces sharing an edge).
 */
export class MeshData {
  constructor(pos, tri, faceGroup = null) {
    this.pos = pos;
    this.tri = tri;
    this.faceGroup = faceGroup;
    this.nv = pos.length / 3;
    this.nf = tri.length / 3;
    this.bounds = computeBounds(pos);
    this._computeFaceGeometry();
    this._buildTopology();
    this._computeLinkGeometry();
    this._computeComponents();
  }

  _computeFaceGeometry() {
    const { pos, tri, nf } = this;
    const N = new Float32Array(nf * 3);
    const A = new Float32Array(nf);
    const C = new Float32Array(nf * 3);
    let total = 0;
    for (let f = 0; f < nf; f++) {
      const a = 3 * tri[3 * f], b = 3 * tri[3 * f + 1], c = 3 * tri[3 * f + 2];
      const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
      const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      const area = 0.5 * len;
      if (len > 0) { nx /= len; ny /= len; nz /= len; }
      N[3 * f] = nx; N[3 * f + 1] = ny; N[3 * f + 2] = nz;
      A[f] = area;
      total += area;
      C[3 * f] = (pos[a] + pos[b] + pos[c]) / 3;
      C[3 * f + 1] = (pos[a + 1] + pos[b + 1] + pos[c + 1]) / 3;
      C[3 * f + 2] = (pos[a + 2] + pos[b + 2] + pos[c + 2]) / 3;
    }
    this.faceNormal = N;
    this.faceArea = A;
    this.faceCenter = C;
    this.totalArea = total;
  }

  _buildTopology() {
    const { tri, nf } = this;
    const nhe = nf * 3;
    const table = new Int32Array(nextPow2(Math.max(16, nhe * 2))).fill(-1);
    const mask = table.length - 1;
    let cap = Math.max(16, Math.ceil(nhe * 0.55));
    let edgeA = new Int32Array(cap), edgeB = new Int32Array(cap);
    const heEdge = new Int32Array(nhe);
    let ne = 0;
    for (let he = 0; he < nhe; he++) {
      const f = (he / 3) | 0;
      const k = he - 3 * f;
      const a = tri[he];
      const b = tri[3 * f + ((k + 1) % 3)];
      const lo = a < b ? a : b, hi = a < b ? b : a;
      let h = (Math.imul(lo, 0x9e3779b1) ^ Math.imul(hi, 0x85ebca77)) & mask;
      for (;;) {
        const e = table[h];
        if (e === -1) {
          if (ne >= cap) {
            cap *= 2;
            const na = new Int32Array(cap); na.set(edgeA); edgeA = na;
            const nb = new Int32Array(cap); nb.set(edgeB); edgeB = nb;
          }
          edgeA[ne] = lo; edgeB[ne] = hi;
          table[h] = ne;
          heEdge[he] = ne++;
          break;
        }
        if (edgeA[e] === lo && edgeB[e] === hi) { heEdge[he] = e; break; }
        h = (h + 1) & mask;
      }
    }
    this.ne = ne;
    this.edgeV = new Int32Array(ne * 2);
    for (let e = 0; e < ne; e++) { this.edgeV[2 * e] = edgeA[e]; this.edgeV[2 * e + 1] = edgeB[e]; }
    this.heEdge = heEdge;
    // edge -> half-edges CSR
    const cnt = new Int32Array(ne + 1);
    for (let he = 0; he < nhe; he++) cnt[heEdge[he] + 1]++;
    for (let e = 0; e < ne; e++) cnt[e + 1] += cnt[e];
    const edgeHE = new Int32Array(nhe);
    const fill = cnt.slice(0, ne);
    for (let he = 0; he < nhe; he++) edgeHE[fill[heEdge[he]]++] = he;
    this.edgeHEStart = cnt;
    this.edgeHE = edgeHE;

    // links
    let nl = 0, boundary = 0, nonManifold = 0, flipped = 0;
    for (let e = 0; e < ne; e++) {
      const c = cnt[e + 1] - cnt[e];
      if (c === 1) boundary++;
      else if (c === 2) nl++;
      else { nonManifold++; nl += Math.min(c * (c - 1) / 2, 15); }
    }
    const linkF = new Int32Array(nl * 2);
    const linkE = new Int32Array(nl);
    let li = 0;
    for (let e = 0; e < ne; e++) {
      const s = cnt[e], t = cnt[e + 1], c = t - s;
      if (c < 2) continue;
      if (c === 2) {
        const h0 = edgeHE[s], h1 = edgeHE[s + 1];
        linkF[2 * li] = (h0 / 3) | 0; linkF[2 * li + 1] = (h1 / 3) | 0; linkE[li++] = e;
        // orientation consistency: half-edges must be opposite
        if (tri[h0] === tri[h1]) flipped++;
      } else {
        let added = 0;
        for (let i = s; i < t && added < 15; i++) for (let j = i + 1; j < t && added < 15; j++) {
          linkF[2 * li] = (edgeHE[i] / 3) | 0; linkF[2 * li + 1] = (edgeHE[j] / 3) | 0; linkE[li++] = e; added++;
        }
      }
    }
    this.nl = li;
    this.linkF = linkF.subarray(0, 2 * li);
    this.linkE = linkE.subarray(0, li);
    this.boundaryEdges = boundary;
    this.nonManifoldEdges = nonManifold;
    this.inconsistentEdges = flipped;
    // face -> links CSR
    const fcnt = new Int32Array(nf + 1);
    for (let l = 0; l < li; l++) { fcnt[this.linkF[2 * l] + 1]++; fcnt[this.linkF[2 * l + 1] + 1]++; }
    for (let f = 0; f < nf; f++) fcnt[f + 1] += fcnt[f];
    const faceLinks = new Int32Array(fcnt[nf]);
    const ff = fcnt.slice(0, nf);
    for (let l = 0; l < li; l++) {
      faceLinks[ff[this.linkF[2 * l]]++] = l;
      faceLinks[ff[this.linkF[2 * l + 1]]++] = l;
    }
    this.faceLinkStart = fcnt;
    this.faceLinks = faceLinks;
  }

  // other face of link l relative to face f
  other(l, f) {
    const a = this.linkF[2 * l];
    return a === f ? this.linkF[2 * l + 1] : a;
  }

  _computeLinkGeometry() {
    const { nl, linkF, linkE, edgeV, pos, faceNormal: N, faceCenter: C } = this;
    const len = new Float32Array(nl);
    const ang = new Float32Array(nl); // signed dihedral: + concave, - convex
    let sumLen = 0;
    for (let l = 0; l < nl; l++) {
      const e = linkE[l];
      const a = 3 * edgeV[2 * e], b = 3 * edgeV[2 * e + 1];
      const dx = pos[b] - pos[a], dy = pos[b + 1] - pos[a + 1], dz = pos[b + 2] - pos[a + 2];
      const L = Math.sqrt(dx * dx + dy * dy + dz * dz);
      len[l] = L;
      sumLen += L;
      const f0 = 3 * linkF[2 * l], f1 = 3 * linkF[2 * l + 1];
      let d = N[f0] * N[f1] + N[f0 + 1] * N[f1 + 1] + N[f0 + 2] * N[f1 + 2];
      d = d > 1 ? 1 : d < -1 ? -1 : d;
      const th = Math.acos(d);
      const s = (C[f1] - C[f0]) * (N[f0] - N[f1]) + (C[f1 + 1] - C[f0 + 1]) * (N[f0 + 1] - N[f1 + 1]) +
        (C[f1 + 2] - C[f0 + 2]) * (N[f0 + 2] - N[f1 + 2]);
      ang[l] = s > 0 ? th : -th;
    }
    this.linkLen = len;
    this.linkAngle = ang;
    this.avgEdgeLen = nl ? sumLen / nl : this.bounds.diag / 100;
  }

  _computeComponents() {
    const { nf, faceLinkStart, faceLinks } = this;
    const comp = new Int32Array(nf).fill(-1);
    const stack = new Int32Array(nf);
    let nc = 0;
    const compArea = [];
    const compFaces = [];
    for (let s = 0; s < nf; s++) {
      if (comp[s] !== -1) continue;
      let sp = 0, area = 0, count = 0;
      stack[sp++] = s;
      comp[s] = nc;
      while (sp) {
        const f = stack[--sp];
        area += this.faceArea[f];
        count++;
        for (let i = faceLinkStart[f]; i < faceLinkStart[f + 1]; i++) {
          const g = this.other(faceLinks[i], f);
          if (comp[g] === -1) { comp[g] = nc; stack[sp++] = g; }
        }
      }
      compArea.push(area);
      compFaces.push(count);
      nc++;
    }
    this.faceComp = comp;
    this.numComponents = nc;
    this.compArea = compArea;
    this.compFaces = compFaces;
  }

  isClosed() {
    return this.boundaryEdges === 0 && this.nonManifoldEdges === 0 && this.inconsistentEdges === 0;
  }

  // signed volume (positive if outward oriented)
  signedVolume() {
    const { pos, tri, nf } = this;
    let v = 0;
    for (let f = 0; f < nf; f++) {
      const a = 3 * tri[3 * f], b = 3 * tri[3 * f + 1], c = 3 * tri[3 * f + 2];
      v += pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1]) -
        pos[a + 1] * (pos[b] * pos[c + 2] - pos[b + 2] * pos[c]) +
        pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c]);
    }
    return v / 6;
  }

  // area-weighted vertex normals
  vertexNormals() {
    const { pos, tri, nf, nv, faceNormal: N, faceArea: A } = this;
    const vn = new Float32Array(nv * 3);
    for (let f = 0; f < nf; f++) {
      const w = A[f];
      for (let k = 0; k < 3; k++) {
        const v = 3 * tri[3 * f + k];
        vn[v] += N[3 * f] * w; vn[v + 1] += N[3 * f + 1] * w; vn[v + 2] += N[3 * f + 2] * w;
      }
    }
    for (let v = 0; v < nv; v++) {
      const x = vn[3 * v], y = vn[3 * v + 1], z = vn[3 * v + 2];
      const l = Math.sqrt(x * x + y * y + z * z) || 1;
      vn[3 * v] = x / l; vn[3 * v + 1] = y / l; vn[3 * v + 2] = z / l;
    }
    return vn;
  }
}

/** Build a sub-mesh from a face mask (or face list). Returns {pos, tri, vmap} */
export function extractFaces(mesh, faceMask) {
  const { tri, pos, nf } = mesh;
  const vmap = new Int32Array(mesh.nv).fill(-1);
  let nv = 0, cnt = 0;
  for (let f = 0; f < nf; f++) if (faceMask[f]) cnt++;
  const outTri = new Uint32Array(cnt * 3);
  let k = 0;
  for (let f = 0; f < nf; f++) {
    if (!faceMask[f]) continue;
    for (let j = 0; j < 3; j++) {
      const v = tri[3 * f + j];
      if (vmap[v] === -1) vmap[v] = nv++;
      outTri[k++] = vmap[v];
    }
  }
  const outPos = new Float32Array(nv * 3);
  for (let v = 0; v < mesh.nv; v++) {
    const u = vmap[v];
    if (u >= 0) { outPos[3 * u] = pos[3 * v]; outPos[3 * u + 1] = pos[3 * v + 1]; outPos[3 * u + 2] = pos[3 * v + 2]; }
  }
  return { pos: outPos, tri: outTri, vmap };
}
