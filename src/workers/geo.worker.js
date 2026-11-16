// Geometry worker: heavy CSG work (manifold-3d) off the UI thread.
import manifoldWasmUrl from 'manifold-3d/manifold.wasm?url';
import { initManifold } from '../core/csg.js';
import { MeshData } from '../core/meshdata.js';
import { planConnectors, disposePlan, performCut, disposePartManifold } from '../core/cutter.js';
import { buildDemoBust } from '../core/demo.js';

const parts = new Map(); // id -> {pos, tri, mesh?, _manifold?}

function getPart(id) {
  const p = parts.get(id);
  if (!p) throw new Error('Parte non trovata nel worker');
  if (!p.mesh) p.mesh = new MeshData(p.pos, p.tri);
  return p;
}

function slimPlacements(pls) {
  return pls.map((p) => ({ point: p.point, axis: p.axis, slide: p.slide, hmin: p.hmin, hmax: p.hmax }));
}

self.onmessage = async (e) => {
  const { id, type, data } = e.data;
  try {
    await initManifold(manifoldWasmUrl);
    let result = null;
    const transfer = [];
    switch (type) {
      case 'init':
        result = true;
        break;
      case 'setPart':
        parts.set(data.id, { pos: data.pos, tri: data.tri });
        result = true;
        break;
      case 'dropPart': {
        const p = parts.get(data.id);
        if (p) disposePartManifold(p);
        parts.delete(data.id);
        result = true;
        break;
      }
      case 'plan': {
        const p = getPart(data.partId);
        const plan = planConnectors({ part: p, sel: data.sel, method: data.method, plane: data.plane, spec: data.spec, onlySelected: data.onlySelected, preview: true });
        result = { outline: plan.outline, placements: slimPlacements(plan.placements), warning: plan.warning, maxDepth: plan.maxDepth ?? null };
        disposePlan(plan);
        break;
      }
      case 'cut': {
        const p = getPart(data.partId);
        const res = performCut({ part: p, sel: data.sel, method: data.method, plane: data.plane, spec: data.spec, onlySelected: data.onlySelected });
        result = { A: res.A, B: res.B, warnings: res.warnings };
        transfer.push(res.A.pos.buffer, res.A.tri.buffer, res.B.pos.buffer, res.B.tri.buffer);
        break;
      }
      case 'demo': {
        const d = buildDemoBust();
        result = d;
        transfer.push(d.pos.buffer, d.tri.buffer);
        break;
      }
      default:
        throw new Error(`Operazione sconosciuta: ${type}`);
    }
    self.postMessage({ id, ok: true, result }, transfer);
  } catch (err) {
    self.postMessage({ id, ok: false, error: err?.message || String(err) });
  }
};
