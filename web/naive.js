/**
 * Naive twin of the Wasm core: the document lives in JS objects,
 * hit-testing is a linear scan in JS, drawing is Canvas 2D per node.
 * Same binary format so both backends can exchange a scene.
 */
import {
  MATERIALIZE_MAX, MAX_GEN, MAX_NAIVE_DRAW, SCATTER_BASE,
  hitScatter, isScatterId, poseAt, sampleScatter, scatterExtent,
} from "./scatter.js";

const KIND_RECT = 0;
const KIND_ELLIPSE = 1;
const KIND_GROUP = 3;

function contains(n, x, y) {
  if (x < n.x || y < n.y || x > n.x + n.w || y > n.y + n.h) return false;
  if (n.kind === KIND_ELLIPSE) {
    const u = ((x - n.x) / n.w) * 2 - 1;
    const v = ((y - n.y) / n.h) * 2 - 1;
    return u * u + v * v <= 1;
  }
  return true;
}

function hsv(h, s, v) {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  let r, g, b;
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    default: r = v; g = p; b = q;
  }
  return ((r * 255) << 16) | ((g * 255) << 8) | (b * 255);
}

class Rng {
  constructor(seed) { this.x = seed || 0xa341316c; }
  next() {
    let x = this.x;
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    this.x = x;
    return x;
  }
  f() { return (this.next() >>> 8) / 16777216; }
  range(a, b) { return a + (b - a) * this.f(); }
  color() { return hsv(this.f(), 0.45 + this.f() * 0.35, 0.55 + this.f() * 0.4) >>> 0; }
}

export class NaiveDoc {
  constructor() {
    this.nodes = [];
    this.index = new Map();
    this.selected = [];
    this.selectedSet = new Set();
    this.nextId = 1;
    this.undo = [];
    this.redo = [];
    this.gesture = null;
    this.scatter = null;
    this.gridSeed = 0;
    this.gridCount = 0;
  }

  reset() {
    this.nodes = [];
    this.index.clear();
    this.selected = [];
    this.selectedSet.clear();
    this.nextId = 1;
    this.undo = [];
    this.redo = [];
    this.gesture = null;
    this.scatter = null;
    this.gridSeed = 0;
    this.gridCount = 0;
  }

  _pushAction(a) {
    this.undo.push(a);
    this.redo = [];
    if (this.undo.length > 80) this.undo.shift();
  }

  create(kind, x, y, w, h, color) {
    const id = this.nextId++;
    const n = { id, kind, parent: 0, x, y, w: Math.max(1, w), h: Math.max(1, h), color };
    this.nodes.push(n);
    this.index.set(id, n);
    this._pushAction({ type: "ins", nodes: [{ ...n }] });
    return id;
  }

  generate(n, seed) {
    n = Math.min(MAX_GEN, n | 0);
    seed = seed || 0xa341316c;
    this.gridSeed = seed;
    this.gridCount = n;
    if (n > MATERIALIZE_MAX) {
      const before = this.scatter;
      this.scatter = { seed, count: n };
      this._pushAction({ type: "scatter", before, after: this.scatter });
      return;
    }
    const snaps = [];
    for (let i = 0; i < n; i++) {
      const id = this.nextId++;
      const p = poseAt(seed, i, n);
      const node = { id, kind: p.kind, parent: 0, x: p.x, y: p.y, w: p.w, h: p.h, color: p.color };
      this.nodes.push(node);
      this.index.set(id, node);
      snaps.push({ ...node });
    }
    this._pushAction({ type: "ins", nodes: snaps });
  }

  locate(num) {
    if (!num) return false;
    if (this.scatter && num <= this.scatter.count) {
      this.clearSelection();
      const id = (SCATTER_BASE + num - 1) >>> 0;
      this.selected = [id];
      this.selectedSet.add(id);
      return true;
    }
    const n = this.index.get(num);
    if (!n) return false;
    this.clearSelection();
    this.selected = [num];
    this.selectedSet.add(num);
    return true;
  }

  hit(x, y) {
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const n = this.nodes[i];
      if (n.kind === KIND_GROUP) continue;
      if (contains(n, x, y)) return n.id;
    }
    if (this.scatter) return hitScatter(this.scatter.seed, this.scatter.count, x, y);
    return 0;
  }

  selectAt(x, y, additive) {
    const id = this.hit(x, y);
    if (!id) {
      if (!additive) this.clearSelection();
      return 0;
    }
    if (!additive) this.clearSelection();
    if (this.selectedSet.has(id)) {
      if (additive) {
        this.selected = this.selected.filter((s) => s !== id);
        this.selectedSet.delete(id);
      }
    } else {
      this.selected.push(id);
      this.selectedSet.add(id);
    }
    return id;
  }

  selectBox(x0, y0, x1, y1, additive) {
    const minx = Math.min(x0, x1), miny = Math.min(y0, y1);
    const maxx = Math.max(x0, x1), maxy = Math.max(y0, y1);
    if (!additive) this.clearSelection();
    for (const n of this.nodes) {
      if (n.x < maxx && n.x + n.w > minx && n.y < maxy && n.y + n.h > miny) {
        if (!this.selectedSet.has(n.id)) {
          this.selected.push(n.id);
          this.selectedSet.add(n.id);
        }
      }
    }
  }

  selectAll() {
    this.selected = this.nodes.map((n) => n.id);
    this.selectedSet = new Set(this.selected);
  }

  clearSelection() {
    this.selected = [];
    this.selectedSet.clear();
  }

  beginGesture() {
    const before = this.selected.map((id) => {
      const n = this.index.get(id);
      return { id, x: n.x, y: n.y, w: n.w, h: n.h };
    });
    this.gesture = { before, union: this.selectionUnion() };
  }

  moveSelected(dx, dy) {
    for (const id of this.selected) {
      const n = this.index.get(id);
      if (n) { n.x += dx; n.y += dy; }
    }
  }

  resizeHandle(handle, wx, wy) {
    if (!this.gesture) return;
    const [ux, uy, uw, uh] = this.gesture.union;
    if (uw < 1 || uh < 1) return;
    let nx = ux, ny = uy, nr = ux + uw, nb = uy + uh;
    if (handle === 0) { nx = wx; ny = wy; }
    else if (handle === 1) ny = wy;
    else if (handle === 2) { nr = wx; ny = wy; }
    else if (handle === 3) nr = wx;
    else if (handle === 4) { nr = wx; nb = wy; }
    else if (handle === 5) nb = wy;
    else if (handle === 6) { nx = wx; nb = wy; }
    else if (handle === 7) nx = wx;
    if (nr - nx < 4) { if (handle === 0 || handle === 6 || handle === 7) nx = nr - 4; else nr = nx + 4; }
    if (nb - ny < 4) { if (handle === 0 || handle === 1 || handle === 2) ny = nb - 4; else nb = ny + 4; }
    const sx = (nr - nx) / uw, sy = (nb - ny) / uh;
    for (const xf of this.gesture.before) {
      const n = this.index.get(xf.id);
      if (!n) continue;
      n.x = nx + (xf.x - ux) * sx;
      n.y = ny + (xf.y - uy) * sy;
      n.w = Math.max(1, xf.w * sx);
      n.h = Math.max(1, xf.h * sy);
    }
  }

  commitGesture() {
    const g = this.gesture;
    this.gesture = null;
    if (!g) return;
    const after = g.before.map((xf) => {
      const n = this.index.get(xf.id);
      return n ? { id: xf.id, x: n.x, y: n.y, w: n.w, h: n.h } : xf;
    });
    const changed = g.before.some((a, i) => {
      const b = after[i];
      return a.x !== b.x || a.y !== b.y || a.w !== b.w || a.h !== b.h;
    });
    if (changed) this._pushAction({ type: "xf", before: g.before, after });
  }

  setColor(color) {
    const changes = [];
    for (const id of this.selected) {
      const n = this.index.get(id);
      if (n && n.color !== color) {
        changes.push({ id, old: n.color, neu: color });
        n.color = color;
      }
    }
    if (changes.length) this._pushAction({ type: "col", changes });
  }

  setRect(id, x, y, w, h) {
    const n = this.index.get(id);
    if (!n) return;
    const before = [{ id, x: n.x, y: n.y, w: n.w, h: n.h }];
    n.x = x; n.y = y; n.w = Math.max(1, w); n.h = Math.max(1, h);
    this._pushAction({ type: "xf", before, after: [{ id, x: n.x, y: n.y, w: n.w, h: n.h }] });
  }

  deleteSelected() {
    const snaps = [];
    for (const id of this.selected) {
      const n = this.index.get(id);
      if (n) snaps.push({ ...n });
    }
    this.nodes = this.nodes.filter((n) => !this.selectedSet.has(n.id));
    for (const s of snaps) this.index.delete(s.id);
    this.clearSelection();
    if (snaps.length) this._pushAction({ type: "del", nodes: snaps });
  }

  groupSelected() {
    if (this.selected.length < 2) return 0;
    const [x, y, w, h] = this.selectionUnion();
    const id = this.nextId++;
    const g = { id, kind: KIND_GROUP, parent: 0, x, y, w, h, color: 0 };
    this.nodes.push(g);
    this.index.set(id, g);
    for (const sid of this.selected) {
      const n = this.index.get(sid);
      if (n) n.parent = id;
    }
    this._pushAction({ type: "ins", nodes: [{ ...g }] });
    this.clearSelection();
    this.selected = [id];
    this.selectedSet.add(id);
    return id;
  }

  _apply(a, reverse) {
    if (a.type === "ins") {
      if (reverse) {
        for (const s of a.nodes) {
          this.nodes = this.nodes.filter((n) => n.id !== s.id);
          this.index.delete(s.id);
        }
      } else {
        for (const s of a.nodes) {
          const n = { ...s };
          this.nodes.push(n);
          this.index.set(n.id, n);
          this.nextId = Math.max(this.nextId, n.id + 1);
        }
      }
    } else if (a.type === "del") {
      this._apply({ type: "ins", nodes: a.nodes }, !reverse);
    } else if (a.type === "xf") {
      for (const xf of reverse ? a.before : a.after) {
        const n = this.index.get(xf.id);
        if (n) { n.x = xf.x; n.y = xf.y; n.w = xf.w; n.h = xf.h; }
      }
    } else if (a.type === "col") {
      for (const c of a.changes) {
        const n = this.index.get(c.id);
        if (n) n.color = reverse ? c.old : c.neu;
      }
    } else if (a.type === "scatter") {
      this.scatter = reverse ? a.before : a.after;
    }
  }

  undo() {
    const a = this.undo.pop();
    if (!a) return 0;
    this._apply(a, true);
    this.redo.push(a);
    this.clearSelection();
    return 1;
  }

  redo() {
    const a = this.redo.pop();
    if (!a) return 0;
    this._apply(a, false);
    this.undo.push(a);
    this.clearSelection();
    return 1;
  }

  selectionUnion() {
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    let any = false;
    for (const id of this.selected) {
      let n = this.index.get(id);
      if (!n && isScatterId(id) && this.scatter) {
        const idx = (id - SCATTER_BASE) >>> 0;
        if (idx < this.scatter.count) n = poseAt(this.scatter.seed, idx, this.scatter.count);
      }
      if (!n) continue;
      any = true;
      minx = Math.min(minx, n.x);
      miny = Math.min(miny, n.y);
      maxx = Math.max(maxx, n.x + n.w);
      maxy = Math.max(maxy, n.y + n.h);
    }
    return any ? [minx, miny, maxx - minx, maxy - miny] : [0, 0, 0, 0];
  }

  info() {
    let first = this.selected[0] ? this.index.get(this.selected[0]) : null;
    if (!first && this.selected[0] && isScatterId(this.selected[0]) && this.scatter) {
      const idx = (this.selected[0] - SCATTER_BASE) >>> 0;
      if (idx < this.scatter.count) {
        const p = poseAt(this.scatter.seed, idx, this.scatter.count);
        first = { id: this.selected[0], ...p };
      }
    }
    const [ux, uy, uw, uh] = this.selectionUnion();
    return {
      nodes: this.nodes.length + (this.scatter ? this.scatter.count : 0),
      selected: this.selected.length,
      id: first ? first.id : 0,
      x: first ? first.x : 0,
      y: first ? first.y : 0,
      w: first ? first.w : 0,
      h: first ? first.h : 0,
      color: first ? first.color : 0,
      kind: first ? first.kind : 0,
      ux, uy, uw, uh,
      undo: this.undo.length,
      redo: this.redo.length,
    };
  }

  nodeCount() { return this.nodes.length + (this.scatter ? this.scatter.count : 0); }
  selectedCount() { return this.selected.length; }

  bounds() {
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    let any = false;
    if (this.scatter) {
      const [ex, ey] = scatterExtent(this.scatter.count);
      minx = 0; miny = 0; maxx = ex; maxy = ey;
      any = true;
    }
    for (const n of this.nodes) {
      any = true;
      minx = Math.min(minx, n.x);
      miny = Math.min(miny, n.y);
      maxx = Math.max(maxx, n.x + n.w);
      maxy = Math.max(maxy, n.y + n.h);
    }
    return any ? { x: minx, y: miny, w: maxx - minx, h: maxy - miny } : { x: 0, y: 0, w: 0, h: 0 };
  }

  serialize() {
    const rec = 32;
    const extra = (this.gridCount || this.scatter) ? 12 : 0;
    const buf = new ArrayBuffer(16 + this.nodes.length * rec + extra);
    const dv = new DataView(buf);
    dv.setUint8(0, 0x4d); dv.setUint8(1, 0x46); dv.setUint8(2, 0x47); dv.setUint8(3, 0x31);
    dv.setUint16(4, 1, true);
    dv.setUint16(6, 0, true);
    dv.setUint32(8, this.nodes.length, true);
    dv.setUint32(12, this.nextId, true);
    let off = 16;
    for (const n of this.nodes) {
      dv.setUint32(off, n.id, true);
      dv.setUint8(off + 4, n.kind);
      dv.setUint32(off + 8, n.parent, true);
      dv.setFloat32(off + 12, n.x, true);
      dv.setFloat32(off + 16, n.y, true);
      dv.setFloat32(off + 20, n.w, true);
      dv.setFloat32(off + 24, n.h, true);
      dv.setUint32(off + 28, n.color, true);
      off += rec;
    }
    if (this.gridCount || this.scatter) {
      const seed = this.gridCount ? this.gridSeed : this.scatter.seed;
      const count = this.gridCount ? this.gridCount : this.scatter.count;
      dv.setUint8(off, 0x53); dv.setUint8(off + 1, 0x43);
      dv.setUint8(off + 2, 0x54); dv.setUint8(off + 3, 0x31);
      dv.setUint32(off + 4, seed, true);
      dv.setUint32(off + 8, count, true);
    }
    return new Uint8Array(buf);
  }

  deserialize(bytes) {
    if (bytes.length < 16) return 0;
    if (bytes[0] !== 0x4d || bytes[1] !== 0x46 || bytes[2] !== 0x47 || bytes[3] !== 0x31) return 0;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const n = dv.getUint32(8, true);
    const nextId = dv.getUint32(12, true);
    this.reset();
    let off = 16;
    for (let i = 0; i < n; i++) {
      const node = {
        id: dv.getUint32(off, true),
        kind: bytes[off + 4],
        parent: dv.getUint32(off + 8, true),
        x: dv.getFloat32(off + 12, true),
        y: dv.getFloat32(off + 16, true),
        w: dv.getFloat32(off + 20, true),
        h: dv.getFloat32(off + 24, true),
        color: dv.getUint32(off + 28, true),
      };
      this.nodes.push(node);
      this.index.set(node.id, node);
      off += 32;
    }
    this.nextId = Math.max(nextId, this.nodes.reduce((m, n) => Math.max(m, n.id + 1), 1));
    if (off + 12 <= bytes.length && bytes[off] === 0x53 && bytes[off + 1] === 0x43 && bytes[off + 2] === 0x54 && bytes[off + 3] === 0x31) {
      const seed = dv.getUint32(off + 4, true);
      const count = Math.min(MAX_GEN, dv.getUint32(off + 8, true));
      if (count) {
        this.gridSeed = seed;
        this.gridCount = count;
        if (!this.nodes.length) this.scatter = { seed, count };
      }
    }
    return 1;
  }
}

export class NaiveRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
    this.dpr = 1;
  }

  resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.dpr = dpr;
  }

  draw(doc, camera, marquee) {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#1f1f1f";
    ctx.fillRect(0, 0, w, h);
    ctx.setTransform(camera.zoom, 0, 0, camera.zoom, camera.panX, camera.panY);

    const t0 = performance.now();
    if (doc.scatter) {
      const vx0 = (0 - camera.panX) / camera.zoom;
      const vy0 = (0 - camera.panY) / camera.zoom;
      const vx1 = (w - camera.panX) / camera.zoom;
      const vy1 = (h - camera.panY) / camera.zoom;
      const sample = sampleScatter(
        doc.scatter.seed, doc.scatter.count,
        vx0, vy0, vx1, vy1,
        camera.zoom, w, h, MAX_NAIVE_DRAW,
      );
      for (const n of sample) {
        ctx.fillStyle = `#${(n.color >>> 0).toString(16).padStart(6, "0")}`;
        if (n.kind === KIND_ELLIPSE) {
          ctx.beginPath();
          ctx.ellipse(n.x + n.w * 0.5, n.y + n.h * 0.5, n.w * 0.5, n.h * 0.5, 0, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.fillRect(n.x, n.y, n.w, n.h);
        }
      }
    }
    for (const n of doc.nodes) {
      if (n.kind === KIND_GROUP) continue;
      ctx.fillStyle = `#${(n.color >>> 0).toString(16).padStart(6, "0")}`;
      if (n.kind === KIND_ELLIPSE) {
        ctx.beginPath();
        ctx.ellipse(n.x + n.w * 0.5, n.y + n.h * 0.5, n.w * 0.5, n.h * 0.5, 0, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillRect(n.x, n.y, n.w, n.h);
      }
    }
    const packMs = performance.now() - t0;

    if (doc.selected.length && doc.selected.length <= 64) {
      ctx.strokeStyle = "#0d99ff";
      ctx.lineWidth = 2 / camera.zoom;
      for (const id of doc.selected) {
        const n = doc.index.get(id);
        if (!n) continue;
        ctx.strokeRect(n.x, n.y, n.w, n.h);
      }
    }

    const [ux, uy, uw, uh] = doc.selectionUnion();
    if (uw > 0 && uh > 0) {
      ctx.strokeStyle = "#0d99ff";
      ctx.lineWidth = 1.25 / camera.zoom;
      ctx.strokeRect(ux, uy, uw, uh);
      const s = 8 / camera.zoom;
      ctx.fillStyle = "#fff";
      const pts = [
        [ux, uy], [ux + uw / 2, uy], [ux + uw, uy],
        [ux + uw, uy + uh / 2], [ux + uw, uy + uh],
        [ux + uw / 2, uy + uh], [ux, uy + uh], [ux, uy + uh / 2],
      ];
      for (const [x, y] of pts) ctx.fillRect(x - s / 2, y - s / 2, s, s);
    }

    if (marquee) {
      ctx.fillStyle = "rgba(13,153,255,0.15)";
      const x = Math.min(marquee.x0, marquee.x1);
      const y = Math.min(marquee.y0, marquee.y1);
      ctx.fillRect(x, y, Math.abs(marquee.x1 - marquee.x0), Math.abs(marquee.y1 - marquee.y0));
    }

    return packMs;
  }
}
