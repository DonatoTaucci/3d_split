// Binary min-heap keyed by Float64 priorities, storing integer items.
// Supports lazy deletion (callers skip stale entries).
export class MinHeap {
  constructor(capacity = 1024) {
    this.keys = new Float64Array(capacity);
    this.items = new Int32Array(capacity);
    this.size = 0;
  }

  _grow() {
    const k = new Float64Array(this.keys.length * 2);
    k.set(this.keys);
    const it = new Int32Array(this.items.length * 2);
    it.set(this.items);
    this.keys = k;
    this.items = it;
  }

  push(item, key) {
    if (this.size >= this.keys.length) this._grow();
    let i = this.size++;
    const keys = this.keys;
    const items = this.items;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      keys[i] = keys[p];
      items[i] = items[p];
      i = p;
    }
    keys[i] = key;
    items[i] = item;
  }

  // Returns item with smallest key; key available in this.lastKey.
  pop() {
    const keys = this.keys;
    const items = this.items;
    const top = items[0];
    this.lastKey = keys[0];
    const n = --this.size;
    if (n > 0) {
      const key = keys[n];
      const item = items[n];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && keys[c + 1] < keys[c]) c++;
        if (keys[c] >= key) break;
        keys[i] = keys[c];
        items[i] = items[c];
        i = c;
      }
      keys[i] = key;
      items[i] = item;
    }
    return top;
  }

  clear() {
    this.size = 0;
  }
}
