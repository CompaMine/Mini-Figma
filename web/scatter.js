/** Ordered grid — same math as core/src/lib.rs. Item № = index + 1. */

export const MAX_GEN = 100_000_000;
export const MATERIALIZE_MAX = 250_000;
export const SCATTER_BASE = 0x80000000;
export const MAX_SCATTER_DRAW = 140_000;
export const MAX_NAIVE_DRAW = 12_000;
export const CELL = 64;
export const SIZE = 44;
export const PAD = 10;

class Rng {
  constructor(seed) { this.x = seed >>> 0; }
  next() {
    let x = this.x;
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    this.x = x;
    return x;
  }
  f() { return (this.next() >>> 8) / 16777216; }
  color() {
    const h = this.f();
    const s = 0.45 + this.f() * 0.35;
    const v = 0.55 + this.f() * 0.4;
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
    return (((r * 255) << 16) | ((g * 255) << 8) | (b * 255)) >>> 0;
  }
}

export function mix(seed, i) {
  let x = (seed ^ Math.imul(i, 0x9e3779b9)) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}

export function gridCols(count) {
  return Math.max(1, Math.ceil(Math.sqrt(count)));
}

export function gridRows(count) {
  const c = gridCols(count);
  return Math.max(1, Math.ceil(count / c));
}

export function scatterExtent(count) {
  return [gridCols(count) * CELL, gridRows(count) * CELL];
}

export function poseAt(seed, index, count) {
  const cols = gridCols(count);
  const col = index % cols;
  const row = (index / cols) | 0;
  const rng = new Rng(mix(seed, index));
  return {
    x: col * CELL + PAD,
    y: row * CELL + PAD,
    w: SIZE,
    h: SIZE,
    kind: (rng.next() & 1) === 0 ? 0 : 1,
    color: rng.color(),
    num: index + 1,
  };
}

export function itemNumber(id) {
  const v = id >>> 0;
  if (v >= SCATTER_BASE) return v - SCATTER_BASE + 1;
  return v;
}

export function isScatterId(id) {
  return (id >>> 0) >= SCATTER_BASE;
}

function strideForView(zoom, viewW, viewH, budget) {
  const cellsX = viewW / (CELL * zoom);
  const cellsY = viewH / (CELL * zoom);
  const est = Math.max(1, cellsX * cellsY);
  let stride = 1;
  while ((est / (stride * stride)) > budget) stride *= 2;
  return stride;
}

export function visibleWindow(count, vx0, vy0, vx1, vy1, zoom, viewW, viewH, budget) {
  const cols = gridCols(count);
  const rows = gridRows(count);
  const stride = strideForView(zoom, viewW, viewH, budget);
  const pad = Math.max(2, stride) * CELL;
  const minx = Math.min(vx0, vx1) - pad;
  const miny = Math.min(vy0, vy1) - pad;
  const maxx = Math.max(vx0, vx1) + pad;
  const maxy = Math.max(vy0, vy1) + pad;
  let c0 = Math.floor(minx / CELL);
  let r0 = Math.floor(miny / CELL);
  let c1 = Math.floor(maxx / CELL);
  let r1 = Math.floor(maxy / CELL);
  c0 = Math.max(0, Math.floor(c0 / stride) * stride);
  r0 = Math.max(0, Math.floor(r0 / stride) * stride);
  c1 = Math.min(cols - 1, c1);
  r1 = Math.min(rows - 1, r1);
  return { c0, r0, c1, r1, stride, cols, rows };
}

export function sampleScatter(seed, count, vx0, vy0, vx1, vy1, zoom, viewW, viewH, budget) {
  const w = visibleWindow(count, vx0, vy0, vx1, vy1, zoom, viewW, viewH, budget);
  const items = [];
  const tile = w.stride > 1 ? CELL * w.stride - 8 : SIZE;
  for (let r = w.r0; r <= w.r1; r += w.stride) {
    for (let c = w.c0; c <= w.c1; c += w.stride) {
      const i = r * w.cols + c;
      if (i >= count) continue;
      const p = poseAt(seed, i, count);
      if (w.stride > 1) {
        p.w = tile;
        p.h = tile;
        p.x = c * CELL + (CELL * w.stride - tile) * 0.5;
        p.y = r * CELL + (CELL * w.stride - tile) * 0.5;
      }
      items.push(p);
    }
  }
  return items;
}

export function hitScatter(seed, count, x, y) {
  if (x < 0 || y < 0) return 0;
  const cols = gridCols(count);
  const col = Math.floor(x / CELL);
  const row = Math.floor(y / CELL);
  if (col < 0 || row < 0) return 0;
  const index = row * cols + col;
  if (index >= count) return 0;
  const p = poseAt(seed, index, count);
  if (x < p.x || y < p.y || x > p.x + p.w || y > p.y + p.h) return 0;
  if (p.kind === 1) {
    const u = ((x - p.x) / p.w) * 2 - 1;
    const v = ((y - p.y) / p.h) * 2 - 1;
    if (u * u + v * v > 1) return 0;
  }
  return (SCATTER_BASE + index) >>> 0;
}

export function labelsForView(count, seed, vx0, vy0, vx1, vy1, zoom, maxLabels = 280) {
  const cols = gridCols(count);
  if (CELL * zoom < 20) return [];
  const c0 = Math.max(0, Math.floor(Math.min(vx0, vx1) / CELL));
  const r0 = Math.max(0, Math.floor(Math.min(vy0, vy1) / CELL));
  const c1 = Math.min(cols - 1, Math.floor(Math.max(vx0, vx1) / CELL));
  const r1 = Math.min(gridRows(count) - 1, Math.floor(Math.max(vy0, vy1) / CELL));
  const out = [];
  for (let r = r0; r <= r1 && out.length < maxLabels; r++) {
    for (let c = c0; c <= c1 && out.length < maxLabels; c++) {
      const i = r * cols + c;
      if (i >= count) continue;
      const p = poseAt(seed, i, count);
      out.push(p);
    }
  }
  return out;
}
