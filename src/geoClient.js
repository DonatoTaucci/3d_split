// Promise-based client for the geometry worker.
export class GeoClient {
  constructor() {
    this.worker = new Worker(new URL('./workers/geo.worker.js', import.meta.url), { type: 'module' });
    this.seq = 0;
    this.pending = new Map();
    this.known = new Set();
    this.worker.onmessage = (e) => {
      const { id, ok, result, error } = e.data;
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (ok) p.resolve(result); else p.reject(new Error(error));
    };
    this.worker.onerror = (e) => {
      for (const p of this.pending.values()) p.reject(new Error(e.message || 'Errore nel worker'));
      this.pending.clear();
    };
  }

  call(type, data = {}, transfer = []) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, data }, transfer);
    });
  }

  /** make sure the worker has a copy of the part's mesh */
  async ensurePart(part) {
    if (this.known.has(part.id)) return;
    this.known.add(part.id);
    const pos = part.mesh.pos.slice();
    const tri = part.mesh.tri.slice();
    await this.call('setPart', { id: part.id, pos, tri }, [pos.buffer, tri.buffer]);
  }

  dropPart(part) {
    if (!this.known.has(part.id)) return;
    this.known.delete(part.id);
    this.call('dropPart', { id: part.id }).catch(() => {});
  }
}
