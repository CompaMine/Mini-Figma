/**
 * Thin FFI over the Rust cdylib. JS never copies the node tree —
 * it only calls commands and maps a view onto Wasm linear memory
 * for the GPU upload.
 */
export class Figcore {
  constructor(inst) {
    this.e = inst.exports;
    this.memory = inst.exports.memory;
    this.e.fig_init();
  }

  static async load(url = "figcore.wasm") {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`wasm fetch failed: ${res.status}`);
    const { instance } = await WebAssembly.instantiateStreaming(res, {});
    return new Figcore(instance);
  }

  mem() {
    return this.memory.buffer;
  }

  create(kind, x, y, w, h, color) {
    return this.e.fig_create(kind, x, y, w, h, color) >>> 0;
  }
  generate(n, seed) { this.e.fig_generate(n, seed); }
  setView(panX, panY, zoom, w, h) { this.e.fig_set_view(panX, panY, zoom, w, h); }
  scatterCount() { return this.e.fig_scatter_count() >>> 0; }
  gridSeed() { return this.e.fig_grid_seed() >>> 0; }
  gridCount() { return this.e.fig_grid_count() >>> 0; }
  locate(num) { return this.e.fig_locate(num) !== 0; }
  hit(x, y) { return this.e.fig_hit(x, y) >>> 0; }
  selectAt(x, y, additive) { return this.e.fig_select_at(x, y, additive ? 1 : 0) >>> 0; }
  selectBox(x0, y0, x1, y1, additive) { this.e.fig_select_box(x0, y0, x1, y1, additive ? 1 : 0); }
  selectAll() { this.e.fig_select_all(); }
  clearSelection() { this.e.fig_clear_selection(); }
  beginGesture() { this.e.fig_begin_gesture(); }
  moveSelected(dx, dy) { this.e.fig_move_selected(dx, dy); }
  resizeHandle(handle, x, y) { this.e.fig_resize_handle(handle, x, y); }
  commitGesture() { this.e.fig_commit_gesture(); }
  setColor(color) { this.e.fig_set_color(color); }
  setRect(id, x, y, w, h) { this.e.fig_set_rect(id, x, y, w, h); }
  deleteSelected() { this.e.fig_delete_selected(); }
  groupSelected() { return this.e.fig_group_selected() >>> 0; }
  undo() { return this.e.fig_undo(); }
  redo() { return this.e.fig_redo(); }
  nodeCount() { return this.e.fig_node_count() >>> 0; }
  selectedCount() { return this.e.fig_selected_count() >>> 0; }
  isSelected(id) { return this.e.fig_is_selected(id) !== 0; }
  reset() { this.e.fig_reset(); }

  bounds() {
    const ptr = this.e.fig_bounds_ptr() >>> 0;
    const v = new Float32Array(this.mem(), ptr, 4);
    return { x: v[0], y: v[1], w: v[2], h: v[3] };
  }

  /**
   * Pack instances in Wasm, then return a Float32Array *view* of that
   * buffer — no per-node JS copy. Caller must use it before the next
   * allocating Wasm call (memory grow detaches the buffer).
   */
  packedInstances() {
    const t0 = performance.now();
    const count = this.e.fig_pack() >>> 0;
    const ptr = this.e.fig_instance_ptr() >>> 0;
    const floats = (this.e.fig_instance_floats() >>> 0) || 8;
    const view = new Float32Array(this.mem(), ptr, count * floats);
    return { count, floats, view, packMs: performance.now() - t0 };
  }

  info() {
    const ptr = this.e.fig_info_ptr() >>> 0;
    const v = new Float32Array(this.mem(), ptr, 16);
    return {
      nodes: this.nodeCount(),
      selected: v[1] | 0,
      id: v[2] | 0,
      x: v[3], y: v[4], w: v[5], h: v[6],
      color: v[7] >>> 0,
      kind: v[8] | 0,
      ux: v[9], uy: v[10], uw: v[11], uh: v[12],
      undo: v[13] | 0,
      redo: v[14] | 0,
    };
  }

  serialize() {
    const len = this.e.fig_serialize() >>> 0;
    const ptr = this.e.fig_scratch_ptr() >>> 0;
    return new Uint8Array(this.mem(), ptr, len).slice();
  }

  deserialize(bytes) {
    const ptr = this.e.fig_alloc(bytes.length) >>> 0;
    new Uint8Array(this.mem(), ptr, bytes.length).set(bytes);
    return this.e.fig_deserialize(bytes.length);
  }
}
