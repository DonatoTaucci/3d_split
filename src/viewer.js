// three.js viewer: rendering, camera, picking and per-face highlight attributes.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { MeshBVH } from 'three-mesh-bvh';

const PALETTE_W = 1024;
const PALETTE_H = 64;

export function segmentColor(i) {
  // golden-angle hues, pleasant saturation
  const h = ((i * 137.508) % 360) / 360;
  const s = 0.55 + 0.25 * ((i * 7) % 3) / 2;
  const l = 0.55 + 0.1 * ((i * 5) % 2);
  return new THREE.Color().setHSL(h, s, l);
}

function angleWeightedNormals(m) {
  const { pos, tri, nf, nv, faceNormal: N } = m;
  const vn = new Float32Array(nv * 3);
  for (let f = 0; f < nf; f++) {
    for (let k = 0; k < 3; k++) {
      const a = 3 * tri[3 * f + k], b = 3 * tri[3 * f + ((k + 1) % 3)], c = 3 * tri[3 * f + ((k + 2) % 3)];
      const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
      const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
      const lu = Math.hypot(ux, uy, uz), lv = Math.hypot(vx, vy, vz);
      if (!lu || !lv) continue;
      let d = (ux * vx + uy * vy + uz * vz) / (lu * lv);
      d = d > 1 ? 1 : d < -1 ? -1 : d;
      const w = Math.acos(d);
      vn[a] += N[3 * f] * w; vn[a + 1] += N[3 * f + 1] * w; vn[a + 2] += N[3 * f + 2] * w;
    }
  }
  for (let v = 0; v < nv; v++) {
    const l = Math.hypot(vn[3 * v], vn[3 * v + 1], vn[3 * v + 2]) || 1;
    vn[3 * v] /= l; vn[3 * v + 1] /= l; vn[3 * v + 2] /= l;
  }
  return vn;
}

export class Viewer {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1d2026);
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 10000);
    this.camera.position.set(200, 160, 260);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.15;
    this.controls.addEventListener('change', () => this.requestRender());

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x404452, 1.6));
    this.keyLight = new THREE.DirectionalLight(0xffffff, 1.6);
    this.keyLight.position.set(0.5, 1, 0.8);
    this.camera.add(this.keyLight);
    this.camera.add(this.keyLight.target);
    this.keyLight.target.position.set(0, 0, -1);
    const fill = new THREE.DirectionalLight(0xbfd4ff, 0.5);
    fill.position.set(-1, -0.3, 0.2);
    this.camera.add(fill);
    this.scene.add(this.camera);

    this.modelRoot = new THREE.Group();
    this.scene.add(this.modelRoot);
    this.helpers = new THREE.Group();
    this.scene.add(this.helpers);
    this.overlay = new THREE.Group(); // in model space
    this.modelRoot.add(this.overlay);

    this.grid = null;
    this.paletteData = new Uint8Array(PALETTE_W * PALETTE_H * 4);
    this.paletteTex = new THREE.DataTexture(this.paletteData, PALETTE_W, PALETTE_H, THREE.RGBAFormat);
    this.paletteTex.colorSpace = THREE.SRGBColorSpace;
    this.paletteTex.needsUpdate = true;
    this.uniforms = {
      uPalette: { value: this.paletteTex },
      uShowSeg: { value: 1 },
      uSelColor: { value: new THREE.Color(0xff8a1f) },
      uHoverColor: { value: new THREE.Color(0x4fc3ff) },
      uAltColor: { value: new THREE.Color(0xff4d6d) },
      uFocus: { value: 0 }, // 0 all, 1 dim unselected, 2 hide unselected
    };
    this.transform = new TransformControls(this.camera, this.renderer.domElement);
    this.transform.addEventListener('dragging-changed', (e) => { this.controls.enabled = !e.value; });
    this.transform.addEventListener('change', () => this.requestRender());
    this.scene.add(this.transform.getHelper());

    this._renderRequested = false;
    this._resize = () => this.resize();
    window.addEventListener('resize', this._resize);
    new ResizeObserver(this._resize).observe(container);
    this.resize();
    this._loop();
  }

  setPaletteColor(index, color) {
    const x = index % PALETTE_W, y = Math.floor(index / PALETTE_W);
    if (y >= PALETTE_H) return;
    const o = (y * PALETTE_W + x) * 4;
    const c = color.getRGB({ r: 0, g: 0, b: 0 }, THREE.SRGBColorSpace);
    this.paletteData[o] = Math.round(c.r * 255);
    this.paletteData[o + 1] = Math.round(c.g * 255);
    this.paletteData[o + 2] = Math.round(c.b * 255);
    this.paletteData[o + 3] = 255;
    this.paletteTex.needsUpdate = true;
  }

  ensurePalette(n) {
    if (this._paletteN >= n) return;
    for (let i = this._paletteN || 0; i < Math.min(n, PALETTE_W * PALETTE_H); i++) this.setPaletteColor(i, segmentColor(i));
    this._paletteN = n;
  }

  resize() {
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = w + 'px';
    this.renderer.domElement.style.height = h + 'px';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  requestRender() {
    this._renderRequested = true;
  }

  _loop() {
    requestAnimationFrame(() => this._loop());
    const moved = this.controls.update();
    if (moved || this._renderRequested) {
      this._renderRequested = false;
      this.renderer.render(this.scene, this.camera);
    }
  }

  makeMaterial(baseColor) {
    const mat = new THREE.MeshStandardMaterial({
      color: baseColor,
      roughness: 0.62,
      metalness: 0.04,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    const u = this.uniforms;
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, u);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aSeg;\nattribute float aSel;\nvarying float vSeg;\nvarying float vSel;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSeg = aSeg;\nvSel = aSel;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
uniform sampler2D uPalette;
uniform float uShowSeg;
uniform vec3 uSelColor;
uniform vec3 uHoverColor;
uniform vec3 uAltColor;
uniform float uFocus;
varying float vSeg;
varying float vSel;`)
        .replace('#include <color_fragment>', `#include <color_fragment>
{
  vec3 base = diffuseColor.rgb;
  float sg = floor(vSeg + 0.5);
  if (uShowSeg > 0.5 && sg > 0.5) {
    float idx = sg - 1.0;
    ivec2 c = ivec2(int(mod(idx, ${PALETTE_W}.0)), int(floor(idx / ${PALETTE_W}.0)));
    base = mix(base, texelFetch(uPalette, c, 0).rgb, 0.85);
  }
  float s = floor(vSel + 0.5);
  if (mod(s, 2.0) > 0.5) base = mix(base, uSelColor, 0.8);
  else if (mod(floor(s / 2.0), 2.0) > 0.5) base = mix(base, uHoverColor, 0.5);
  if (mod(floor(s / 4.0), 2.0) > 0.5) base = mix(base, uAltColor, 0.6);
  if (uFocus > 0.5 && mod(s, 2.0) < 0.5) {
    if (uFocus > 1.5) discard;
    base = mix(base, vec3(0.16, 0.17, 0.2), 0.8);
  }
  diffuseColor.rgb = base;
}`);
    };
    return mat;
  }

  /**
   * Create display + picking objects for a part.
   * part.mesh is a MeshData.
   */
  buildPartObject(part) {
    const m = part.mesh;
    const nf = m.nf;
    const pos = new Float32Array(nf * 9);
    const nrm = new Float32Array(nf * 9);
    const vn = angleWeightedNormals(m);
    const cosCrease = Math.cos((40 * Math.PI) / 180);
    for (let f = 0; f < nf; f++) {
      const fnx = m.faceNormal[3 * f], fny = m.faceNormal[3 * f + 1], fnz = m.faceNormal[3 * f + 2];
      for (let k = 0; k < 3; k++) {
        const v = m.tri[3 * f + k];
        const o = 9 * f + 3 * k;
        pos[o] = m.pos[3 * v]; pos[o + 1] = m.pos[3 * v + 1]; pos[o + 2] = m.pos[3 * v + 2];
        const vx = vn[3 * v], vy = vn[3 * v + 1], vz = vn[3 * v + 2];
        if (vx * fnx + vy * fny + vz * fnz > cosCrease) { nrm[o] = vx; nrm[o + 1] = vy; nrm[o + 2] = vz; }
        else { nrm[o] = fnx; nrm[o + 1] = fny; nrm[o + 2] = fnz; }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    const seg = new THREE.BufferAttribute(new Uint16Array(nf * 3), 1);
    seg.setUsage(THREE.DynamicDrawUsage);
    const sel = new THREE.BufferAttribute(new Uint8Array(nf * 3), 1);
    sel.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aSeg', seg);
    g.setAttribute('aSel', sel);
    g.computeBoundingBox();
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, this.makeMaterial(part.color));
    mesh.userData.part = part;
    // picking geometry with BVH (indirect keeps the triangle order)
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(m.pos, 3));
    pg.setIndex(new THREE.BufferAttribute(m.tri, 1));
    const bvh = new MeshBVH(pg, { indirect: true });
    part.object = mesh;
    part.bvh = bvh;
    part.pickGeometry = pg;
    if (part.object.parent) part.object.parent.remove(part.object);
    this.modelRoot.add(mesh);
    this.requestRender();
    return mesh;
  }

  disposePart(part) {
    if (part.object) {
      part.object.parent?.remove(part.object);
      part.object.geometry.dispose();
      part.object.material.dispose();
      part.object = null;
    }
    if (part.pickGeometry) part.pickGeometry.dispose();
    part.bvh = null;
    this.requestRender();
  }

  /** write per-face values into a per-vertex attribute */
  setFaceAttribute(part, name, values, map = null) {
    const attr = part.object.geometry.getAttribute(name);
    const arr = attr.array;
    const nf = part.mesh.nf;
    for (let f = 0; f < nf; f++) {
      const v = map ? map(values[f], f) : values[f];
      const o = 3 * f;
      arr[o] = v; arr[o + 1] = v; arr[o + 2] = v;
    }
    attr.needsUpdate = true;
    this.requestRender();
  }

  /** combined selection flags: 1 selected, 2 hover, 4 alt */
  setSelectionFlags(part, selMask, hoverMask = null, altMask = null) {
    const attr = part.object.geometry.getAttribute('aSel');
    const arr = attr.array;
    const nf = part.mesh.nf;
    for (let f = 0; f < nf; f++) {
      const v = (selMask && selMask[f] ? 1 : 0) | (hoverMask && hoverMask[f] ? 2 : 0) | (altMask && altMask[f] ? 4 : 0);
      const o = 3 * f;
      arr[o] = v; arr[o + 1] = v; arr[o + 2] = v;
    }
    attr.needsUpdate = true;
    this.requestRender();
  }

  /** @returns {{part, face:number, point:THREE.Vector3 (local), pointWorld}|null} */
  pick(clientX, clientY, parts) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    let best = null;
    for (const part of parts) {
      if (!part.visible || !part.object || !part.bvh) continue;
      part.object.updateMatrixWorld();
      const inv = part.object.matrixWorld.clone().invert();
      const local = ray.ray.clone().applyMatrix4(inv);
      const hit = part.bvh.raycastFirst(local, THREE.DoubleSide);
      if (!hit) continue;
      const pw = hit.point.clone().applyMatrix4(part.object.matrixWorld);
      const d = pw.distanceTo(ray.ray.origin);
      if (!best || d < best.distance) best = { part, face: hit.faceIndex, point: hit.point.clone(), pointWorld: pw, distance: d };
    }
    return best;
  }

  frameObjects(objects, keepDirection = true) {
    const box = new THREE.Box3();
    for (const o of objects) if (o) box.expandByObject(o);
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = size.length() / 2;
    const dir = keepDirection
      ? this.camera.position.clone().sub(this.controls.target).normalize()
      : new THREE.Vector3(0.55, 0.35, 0.75).normalize();
    const dist = radius / Math.sin((this.camera.fov * Math.PI) / 360) * 1.05;
    this.controls.target.copy(center);
    this.camera.position.copy(center).addScaledVector(dir, dist);
    this.camera.near = Math.max(dist / 1000, radius / 1000);
    this.camera.far = dist * 20 + radius * 10;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.updateGrid(box);
    this.requestRender();
  }

  updateGrid(box) {
    if (this.grid) { this.helpers.remove(this.grid); this.grid.geometry.dispose(); this.grid.material.dispose(); }
    const size = box.getSize(new THREE.Vector3());
    const span = Math.max(size.x, size.z) * 1.6;
    const step = Math.pow(10, Math.floor(Math.log10(span / 10)));
    const n = Math.ceil(span / step);
    this.grid = new THREE.GridHelper(n * step, n, 0x3b4150, 0x2a2f3a);
    this.grid.position.set((box.min.x + box.max.x) / 2, box.min.y - size.y * 0.002, (box.min.z + box.max.z) / 2);
    this.helpers.add(this.grid);
  }

  setView(name) {
    const t = this.controls.target;
    const d = this.camera.position.distanceTo(t);
    const dirs = {
      front: [0, 0, 1], back: [0, 0, -1], left: [-1, 0, 0], right: [1, 0, 0], top: [0, 1, 0.0001], iso: [0.6, 0.45, 0.7],
    };
    const v = new THREE.Vector3(...dirs[name]).normalize();
    this.camera.position.copy(t).addScaledVector(v, d);
    this.controls.update();
    this.requestRender();
  }

  clearOverlay() {
    for (const c of [...this.overlay.children]) {
      this.overlay.remove(c);
      c.traverse((o) => { o.geometry?.dispose(); o.material?.dispose?.(); });
    }
    this.requestRender();
  }

  dispose() {
    window.removeEventListener('resize', this._resize);
    this.renderer.dispose();
  }
}
