//! Figcore — document kernel for a Figma-like research prototype.
//!
//! The whole scene lives here. JS never keeps a copy of the node tree.
//! It only calls commands and reads a packed GPU instance buffer + a few
//! scalars for the property panel.
//!
//! Layout of one instance (8 × f32 = 32 bytes), tightly packed in Wasm memory:
//!   x, y, w, h, r, g, b, flags
//! flags = kind + (selected ? 10 : 0)
//!   kind 0 = rect, 1 = ellipse, 2 = frame, 3 = group (no fill)

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};

pub const KIND_RECT: u8 = 0;
pub const KIND_ELLIPSE: u8 = 1;
pub const KIND_FRAME: u8 = 2;
pub const KIND_GROUP: u8 = 3;

const MAGIC: &[u8; 4] = b"MFG1";
const VERSION: u16 = 1;
const INST_FLOATS: usize = 8;
const MAX_GEN: u32 = 100_000_000;
const MATERIALIZE_MAX: u32 = 250_000;
const MAX_SCATTER_DRAW: usize = 140_000;
const SCATTER_BASE: u32 = 0x8000_0000;
const SCT_TAG: &[u8; 4] = b"SCT1";
const CELL: f32 = 64.0;
const SIZE: f32 = 44.0;
const PAD: f32 = 10.0;

#[derive(Clone, Copy)]
struct Scatter {
    seed: u32,
    count: u32,
}

fn mix(seed: u32, i: u32) -> u32 {
    let mut x = seed ^ i.wrapping_mul(0x9E37_79B9);
    x ^= x >> 16;
    x = x.wrapping_mul(0x7FEB_352D);
    x ^= x >> 15;
    x = x.wrapping_mul(0x846C_A68B);
    x ^= x >> 16;
    x
}

fn grid_cols(count: u32) -> u32 {
    (count as f32).sqrt().ceil().max(1.0) as u32
}

fn grid_rows(count: u32) -> u32 {
    let c = grid_cols(count);
    count.div_ceil(c).max(1)
}

fn scatter_extent(count: u32) -> (f32, f32) {
    (
        grid_cols(count) as f32 * CELL,
        grid_rows(count) as f32 * CELL,
    )
}

struct ScatterItem {
    x: f32,
    y: f32,
    w: f32,
    h: f32,
    color: u32,
    kind: u8,
}

fn pose_at(seed: u32, index: u32, count: u32) -> ScatterItem {
    let cols = grid_cols(count);
    let col = index % cols;
    let row = index / cols;
    let mut rng = Rng(mix(seed, index));
    ScatterItem {
        x: col as f32 * CELL + PAD,
        y: row as f32 * CELL + PAD,
        w: SIZE,
        h: SIZE,
        kind: if rng.next() & 1 == 0 {
            KIND_RECT
        } else {
            KIND_ELLIPSE
        },
        color: rng.color(),
    }
}

fn stride_for_view(zoom: f32, view_w: f32, view_h: f32) -> u32 {
    let z = zoom.max(0.00005);
    let cells_x = view_w / (CELL * z);
    let cells_y = view_h / (CELL * z);
    let est = (cells_x * cells_y).max(1.0);
    let mut stride = 1u32;
    while (est / (stride * stride) as f32) > MAX_SCATTER_DRAW as f32 {
        stride *= 2;
        if stride >= 1 << 16 {
            break;
        }
    }
    stride
}

fn is_scatter_id(id: u32) -> bool {
    id >= SCATTER_BASE
}

thread_local! {
    static APP: RefCell<App> = RefCell::new(App::new());
}

fn with<F, R>(f: F) -> R
where
    F: FnOnce(&mut App) -> R,
{
    APP.with(|a| f(&mut a.borrow_mut()))
}

struct NodeSoA {
    id: Vec<u32>,
    kind: Vec<u8>,
    parent: Vec<u32>,
    x: Vec<f32>,
    y: Vec<f32>,
    w: Vec<f32>,
    h: Vec<f32>,
    color: Vec<u32>,
    index: HashMap<u32, usize>,
}

impl NodeSoA {
    fn new() -> Self {
        Self {
            id: Vec::new(),
            kind: Vec::new(),
            parent: Vec::new(),
            x: Vec::new(),
            y: Vec::new(),
            w: Vec::new(),
            h: Vec::new(),
            color: Vec::new(),
            index: HashMap::new(),
        }
    }

    fn len(&self) -> usize {
        self.id.len()
    }

    fn reserve(&mut self, extra: usize) {
        self.id.reserve(extra);
        self.kind.reserve(extra);
        self.parent.reserve(extra);
        self.x.reserve(extra);
        self.y.reserve(extra);
        self.w.reserve(extra);
        self.h.reserve(extra);
        self.color.reserve(extra);
        self.index.reserve(extra);
    }

    fn push(&mut self, id: u32, kind: u8, parent: u32, x: f32, y: f32, w: f32, h: f32, color: u32) {
        let i = self.id.len();
        self.id.push(id);
        self.kind.push(kind);
        self.parent.push(parent);
        self.x.push(x);
        self.y.push(y);
        self.w.push(w);
        self.h.push(h);
        self.color.push(color);
        self.index.insert(id, i);
    }

    fn remove_id(&mut self, id: u32) -> Option<NodeSnap> {
        let i = *self.index.get(&id)?;
        let snap = NodeSnap {
            id,
            kind: self.kind[i],
            parent: self.parent[i],
            x: self.x[i],
            y: self.y[i],
            w: self.w[i],
            h: self.h[i],
            color: self.color[i],
        };
        let last = self.len() - 1;
        if i != last {
            self.id.swap(i, last);
            self.kind.swap(i, last);
            self.parent.swap(i, last);
            self.x.swap(i, last);
            self.y.swap(i, last);
            self.w.swap(i, last);
            self.h.swap(i, last);
            self.color.swap(i, last);
            self.index.insert(self.id[i], i);
        }
        self.id.pop();
        self.kind.pop();
        self.parent.pop();
        self.x.pop();
        self.y.pop();
        self.w.pop();
        self.h.pop();
        self.color.pop();
        self.index.remove(&id);
        Some(snap)
    }
}

#[derive(Clone)]
struct NodeSnap {
    id: u32,
    kind: u8,
    parent: u32,
    x: f32,
    y: f32,
    w: f32,
    h: f32,
    color: u32,
}

#[derive(Clone)]
struct Xform {
    id: u32,
    x: f32,
    y: f32,
    w: f32,
    h: f32,
}

#[derive(Clone)]
struct ColorChange {
    id: u32,
    old: u32,
    new: u32,
}

enum Action {
    Insert(Vec<NodeSnap>),
    Delete(Vec<NodeSnap>),
    Transform { before: Vec<Xform>, after: Vec<Xform> },
    Recolor(Vec<ColorChange>),
    SetScatter { before: Option<Scatter>, after: Option<Scatter> },
}

struct History {
    undo: Vec<Action>,
    redo: Vec<Action>,
}

impl History {
    fn new() -> Self {
        Self {
            undo: Vec::new(),
            redo: Vec::new(),
        }
    }

    fn push(&mut self, a: Action) {
        self.undo.push(a);
        self.redo.clear();
        if self.undo.len() > 80 {
            self.undo.remove(0);
        }
    }
}

struct Gesture {
    before: Vec<Xform>,
    union: [f32; 4],
}

struct App {
    nodes: NodeSoA,
    next_id: u32,
    selected: Vec<u32>,
    selected_set: HashSet<u32>,
    history: History,
    gesture: Option<Gesture>,
    instances: Vec<f32>,
    scratch: Vec<u8>,
    info: Vec<f32>,
    bounds_out: [f32; 4],
    dirty: bool,
    scatter: Option<Scatter>,
    view_pan_x: f32,
    view_pan_y: f32,
    view_zoom: f32,
    view_w: f32,
    view_h: f32,
    view_dirty: bool,
    pack_key: u64,
    grid_seed: u32,
    grid_count: u32,
}

impl App {
    fn new() -> Self {
        Self {
            nodes: NodeSoA::new(),
            next_id: 1,
            selected: Vec::new(),
            selected_set: HashSet::new(),
            history: History::new(),
            gesture: None,
            instances: Vec::new(),
            scratch: Vec::new(),
            info: vec![0.0; 16],
            bounds_out: [0.0; 4],
            dirty: true,
            scatter: None,
            view_pan_x: 0.0,
            view_pan_y: 0.0,
            view_zoom: 1.0,
            view_w: 1280.0,
            view_h: 800.0,
            view_dirty: true,
            pack_key: u64::MAX,
            grid_seed: 0,
            grid_count: 0,
        }
    }

    fn total_count(&self) -> u32 {
        self.nodes.len() as u32 + self.scatter.map(|s| s.count).unwrap_or(0)
    }

    fn set_view(&mut self, pan_x: f32, pan_y: f32, zoom: f32, w: f32, h: f32) {
        let zoom = zoom.max(0.00005);
        self.view_pan_x = pan_x;
        self.view_pan_y = pan_y;
        self.view_zoom = zoom;
        self.view_w = w.max(1.0);
        self.view_h = h.max(1.0);
        if self.scatter.is_some() {
            let key = self.scatter_window_key();
            if key != self.pack_key {
                self.view_dirty = true;
            }
        }
    }

    fn scatter_window_key(&self) -> u64 {
        let Some(s) = self.scatter else {
            return 0;
        };
        let (c0, r0, c1, r1, stride) = self.scatter_window(s.count);
        ((c0 as u64) << 40)
            | ((r0 as u64) << 24)
            | ((c1 as u64) << 12)
            | ((r1 as u64) << 4)
            | (stride.trailing_zeros() as u64)
    }

    fn scatter_window(&self, count: u32) -> (u32, u32, u32, u32, u32) {
        let z = self.view_zoom.max(0.00005);
        let stride = stride_for_view(z, self.view_w, self.view_h);
        let pad = CELL * (stride as f32) * 3.0;
        let vx0 = (0.0 - self.view_pan_x) / z - pad;
        let vy0 = (0.0 - self.view_pan_y) / z - pad;
        let vx1 = (self.view_w - self.view_pan_x) / z + pad;
        let vy1 = (self.view_h - self.view_pan_y) / z + pad;
        let cols = grid_cols(count);
        let rows = grid_rows(count);
        let snap = (stride * 4).max(4);
        let mut c0 = (vx0 / CELL).floor() as i32;
        let mut r0 = (vy0 / CELL).floor() as i32;
        let mut c1 = (vx1 / CELL).floor() as i32;
        let mut r1 = (vy1 / CELL).floor() as i32;
        c0 = (c0 / snap as i32) * snap as i32;
        r0 = (r0 / snap as i32) * snap as i32;
        c1 = ((c1 + snap as i32 - 1) / snap as i32) * snap as i32;
        r1 = ((r1 + snap as i32 - 1) / snap as i32) * snap as i32;
        let c0 = c0.clamp(0, cols.saturating_sub(1) as i32) as u32;
        let r0 = r0.clamp(0, rows.saturating_sub(1) as i32) as u32;
        let c1 = c1.clamp(0, cols.saturating_sub(1) as i32) as u32;
        let r1 = r1.clamp(0, rows.saturating_sub(1) as i32) as u32;
        let c0 = (c0 / stride) * stride;
        let r0 = (r0 / stride) * stride;
        (c0, r0, c1, r1, stride)
    }

    fn alloc_id(&mut self) -> u32 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    fn clear_selection(&mut self) {
        self.selected.clear();
        self.selected_set.clear();
        self.dirty = true;
    }

    fn select_id(&mut self, id: u32, additive: bool) {
        let ok = if is_scatter_id(id) {
            self.scatter
                .map(|s| id - SCATTER_BASE < s.count)
                .unwrap_or(false)
        } else {
            self.nodes.index.contains_key(&id)
        };
        if !ok {
            return;
        }
        if !additive {
            self.clear_selection();
        }
        if self.selected_set.insert(id) {
            self.selected.push(id);
        } else if additive {
            self.selected.retain(|&x| x != id);
            self.selected_set.remove(&id);
        }
        self.dirty = true;
    }

    fn insert_snap(&mut self, s: &NodeSnap) {
        if self.nodes.index.contains_key(&s.id) {
            return;
        }
        self.nodes
            .push(s.id, s.kind, s.parent, s.x, s.y, s.w, s.h, s.color);
        if s.id >= self.next_id {
            self.next_id = s.id + 1;
        }
        self.dirty = true;
    }

    fn create(
        &mut self,
        kind: u8,
        x: f32,
        y: f32,
        w: f32,
        h: f32,
        color: u32,
        record: bool,
    ) -> u32 {
        let id = self.alloc_id();
        let w = w.abs().max(1.0);
        let h = h.abs().max(1.0);
        self.nodes.push(id, kind, 0, x, y, w, h, color);
        if record {
            self.history.push(Action::Insert(vec![NodeSnap {
                id,
                kind,
                parent: 0,
                x,
                y,
                w,
                h,
                color,
            }]));
        }
        self.dirty = true;
        id
    }

    fn generate(&mut self, n: u32, seed: u32) {
        let n = n.min(MAX_GEN);
        let seed = if seed == 0 { 0xA341_316C } else { seed };
        self.grid_seed = seed;
        self.grid_count = n;
        if n > MATERIALIZE_MAX {
            let before = self.scatter;
            self.scatter = Some(Scatter { seed, count: n });
            self.history.push(Action::SetScatter {
                before,
                after: self.scatter,
            });
            self.dirty = true;
            self.view_dirty = true;
            return;
        }
        let n_u = n;
        let n = n as usize;
        self.nodes.reserve(n);
        let mut snaps = Vec::with_capacity(n);
        for i in 0..n_u {
            let id = self.alloc_id();
            let p = pose_at(seed, i, n_u);
            self.nodes
                .push(id, p.kind, 0, p.x, p.y, p.w, p.h, p.color);
            snaps.push(NodeSnap {
                id,
                kind: p.kind,
                parent: 0,
                x: p.x,
                y: p.y,
                w: p.w,
                h: p.h,
                color: p.color,
            });
        }
        self.history.push(Action::Insert(snaps));
        self.dirty = true;
    }

    fn hit_scatter(&self, x: f32, y: f32) -> u32 {
        let Some(s) = self.scatter else {
            return 0;
        };
        if x < 0.0 || y < 0.0 {
            return 0;
        }
        let cols = grid_cols(s.count);
        let col = (x / CELL).floor() as i32;
        let row = (y / CELL).floor() as i32;
        if col < 0 || row < 0 {
            return 0;
        }
        let index = row as u32 * cols + col as u32;
        if index >= s.count {
            return 0;
        }
        let p = pose_at(s.seed, index, s.count);
        if contains(p.x, p.y, p.w, p.h, p.kind, x, y) {
            return SCATTER_BASE + index;
        }
        0
    }

    fn locate(&mut self, num: u32) -> i32 {
        if num == 0 {
            return 0;
        }
        if let Some(s) = self.scatter {
            if num <= s.count {
                let p = pose_at(s.seed, num - 1, s.count);
                self.bounds_out = [p.x, p.y, p.w, p.h];
                self.clear_selection();
                self.select_id(SCATTER_BASE + (num - 1), false);
                return 1;
            }
        }
        if let Some(&i) = self.nodes.index.get(&num) {
            self.bounds_out = [
                self.nodes.x[i],
                self.nodes.y[i],
                self.nodes.w[i],
                self.nodes.h[i],
            ];
            self.clear_selection();
            self.select_id(num, false);
            return 1;
        }
        0
    }

    fn hit_at(&self, x: f32, y: f32) -> u32 {
        // Explicit nodes sit on top of the procedural field.
        for i in (0..self.nodes.len()).rev() {
            if self.nodes.kind[i] == KIND_GROUP {
                continue;
            }
            if contains(
                self.nodes.x[i],
                self.nodes.y[i],
                self.nodes.w[i],
                self.nodes.h[i],
                self.nodes.kind[i],
                x,
                y,
            ) {
                return self.nodes.id[i];
            }
        }
        self.hit_scatter(x, y)
    }

    fn select_at(&mut self, x: f32, y: f32, additive: bool) -> u32 {
        let id = self.hit_at(x, y);
        if id == 0 {
            if !additive {
                self.clear_selection();
            }
            return 0;
        }
        self.select_id(id, additive);
        id
    }

    fn select_box(&mut self, x0: f32, y0: f32, x1: f32, y1: f32, additive: bool) {
        let minx = x0.min(x1);
        let miny = y0.min(y1);
        let maxx = x0.max(x1);
        let maxy = y0.max(y1);
        if !additive {
            self.clear_selection();
        }
        for i in 0..self.nodes.len() {
            let x = self.nodes.x[i];
            let y = self.nodes.y[i];
            let r = x + self.nodes.w[i];
            let b = y + self.nodes.h[i];
            if x < maxx && r > minx && y < maxy && b > miny {
                let id = self.nodes.id[i];
                if self.selected_set.insert(id) {
                    self.selected.push(id);
                }
            }
        }
        self.dirty = true;
    }

    fn select_all(&mut self) {
        self.selected.clear();
        self.selected_set.clear();
        self.selected.extend_from_slice(&self.nodes.id);
        self.selected_set.extend(self.nodes.id.iter().copied());
        self.dirty = true;
    }

    fn begin_gesture(&mut self) {
        let before = self.snapshot_selected();
        let union = self.selection_union();
        self.gesture = Some(Gesture { before, union });
    }

    fn snapshot_selected(&self) -> Vec<Xform> {
        let mut out = Vec::with_capacity(self.selected.len());
        for &id in &self.selected {
            if let Some(&i) = self.nodes.index.get(&id) {
                out.push(Xform {
                    id,
                    x: self.nodes.x[i],
                    y: self.nodes.y[i],
                    w: self.nodes.w[i],
                    h: self.nodes.h[i],
                });
            }
        }
        out
    }

    fn selection_union(&self) -> [f32; 4] {
        let mut minx = f32::MAX;
        let mut miny = f32::MAX;
        let mut maxx = f32::MIN;
        let mut maxy = f32::MIN;
        let mut any = false;
        for &id in &self.selected {
            if is_scatter_id(id) {
                if let Some(s) = self.scatter {
                    let idx = id - SCATTER_BASE;
                    if idx < s.count {
                        let p = pose_at(s.seed, idx, s.count);
                        any = true;
                        minx = minx.min(p.x);
                        miny = miny.min(p.y);
                        maxx = maxx.max(p.x + p.w);
                        maxy = maxy.max(p.y + p.h);
                    }
                }
                continue;
            }
            if let Some(&i) = self.nodes.index.get(&id) {
                any = true;
                minx = minx.min(self.nodes.x[i]);
                miny = miny.min(self.nodes.y[i]);
                maxx = maxx.max(self.nodes.x[i] + self.nodes.w[i]);
                maxy = maxy.max(self.nodes.y[i] + self.nodes.h[i]);
            }
        }
        if !any {
            return [0.0, 0.0, 0.0, 0.0];
        }
        [minx, miny, maxx - minx, maxy - miny]
    }

    fn move_selected(&mut self, dx: f32, dy: f32) {
        for &id in &self.selected {
            if is_scatter_id(id) {
                continue;
            }
            if let Some(&i) = self.nodes.index.get(&id) {
                self.nodes.x[i] += dx;
                self.nodes.y[i] += dy;
            }
        }
        self.dirty = true;
    }

    fn resize_handle(&mut self, handle: i32, world_x: f32, world_y: f32) {
        let g = match &self.gesture {
            Some(g) if !g.before.is_empty() => g,
            _ => return,
        };
        let [ux, uy, uw, uh] = g.union;
        if uw < 1.0 || uh < 1.0 {
            return;
        }
        let mut nx = ux;
        let mut ny = uy;
        let mut nr = ux + uw;
        let mut nb = uy + uh;
        match handle {
            0 => {
                nx = world_x;
                ny = world_y;
            }
            1 => ny = world_y,
            2 => {
                nr = world_x;
                ny = world_y;
            }
            3 => nr = world_x,
            4 => {
                nr = world_x;
                nb = world_y;
            }
            5 => nb = world_y,
            6 => {
                nx = world_x;
                nb = world_y;
            }
            7 => nx = world_x,
            _ => return,
        }
        if nr - nx < 4.0 {
            if handle == 0 || handle == 6 || handle == 7 {
                nx = nr - 4.0;
            } else {
                nr = nx + 4.0;
            }
        }
        if nb - ny < 4.0 {
            if handle == 0 || handle == 1 || handle == 2 {
                ny = nb - 4.0;
            } else {
                nb = ny + 4.0;
            }
        }
        let nw = nr - nx;
        let nh = nb - ny;
        let sx = nw / uw;
        let sy = nh / uh;
        for xf in &g.before {
            if let Some(&i) = self.nodes.index.get(&xf.id) {
                self.nodes.x[i] = nx + (xf.x - ux) * sx;
                self.nodes.y[i] = ny + (xf.y - uy) * sy;
                self.nodes.w[i] = (xf.w * sx).max(1.0);
                self.nodes.h[i] = (xf.h * sy).max(1.0);
            }
        }
        self.dirty = true;
    }

    fn commit_gesture(&mut self) {
        let g = match self.gesture.take() {
            Some(g) => g,
            None => return,
        };
        let after = self.snapshot_selected();
        let changed = g
            .before
            .iter()
            .zip(after.iter())
            .any(|(a, b)| a.x != b.x || a.y != b.y || a.w != b.w || a.h != b.h);
        if changed {
            self.history.push(Action::Transform {
                before: g.before,
                after,
            });
        }
    }

    fn apply_xforms(&mut self, xs: &[Xform]) {
        for xf in xs {
            if let Some(&i) = self.nodes.index.get(&xf.id) {
                self.nodes.x[i] = xf.x;
                self.nodes.y[i] = xf.y;
                self.nodes.w[i] = xf.w;
                self.nodes.h[i] = xf.h;
            }
        }
        self.dirty = true;
    }

    fn set_color_selected(&mut self, color: u32) {
        let mut changes = Vec::new();
        for &id in &self.selected {
            if let Some(&i) = self.nodes.index.get(&id) {
                let old = self.nodes.color[i];
                if old != color {
                    self.nodes.color[i] = color;
                    changes.push(ColorChange {
                        id,
                        old,
                        new: color,
                    });
                }
            }
        }
        if !changes.is_empty() {
            self.history.push(Action::Recolor(changes));
            self.dirty = true;
        }
    }

    fn set_rect(&mut self, id: u32, x: f32, y: f32, w: f32, h: f32) {
        let Some(&i) = self.nodes.index.get(&id) else {
            return;
        };
        let before = vec![Xform {
            id,
            x: self.nodes.x[i],
            y: self.nodes.y[i],
            w: self.nodes.w[i],
            h: self.nodes.h[i],
        }];
        self.nodes.x[i] = x;
        self.nodes.y[i] = y;
        self.nodes.w[i] = w.max(1.0);
        self.nodes.h[i] = h.max(1.0);
        let after = vec![Xform {
            id,
            x,
            y,
            w: self.nodes.w[i],
            h: self.nodes.h[i],
        }];
        self.history.push(Action::Transform { before, after });
        self.dirty = true;
    }

    fn delete_selected(&mut self) {
        if self.selected.is_empty() {
            return;
        }
        let ids: Vec<u32> = self.selected.clone();
        let mut snaps = Vec::new();
        for id in ids {
            if let Some(s) = self.nodes.remove_id(id) {
                snaps.push(s);
            }
        }
        self.clear_selection();
        if !snaps.is_empty() {
            self.history.push(Action::Delete(snaps));
        }
        self.dirty = true;
    }

    fn group_selected(&mut self) -> u32 {
        if self.selected.len() < 2 {
            return 0;
        }
        let [x, y, w, h] = self.selection_union();
        let ids = self.selected.clone();
        let gid = self.alloc_id();
        self.nodes
            .push(gid, KIND_GROUP, 0, x, y, w, h, 0x0000_0000);
        for id in &ids {
            if let Some(&i) = self.nodes.index.get(id) {
                self.nodes.parent[i] = gid;
            }
        }
        self.history.push(Action::Insert(vec![NodeSnap {
            id: gid,
            kind: KIND_GROUP,
            parent: 0,
            x,
            y,
            w,
            h,
            color: 0,
        }]));
        self.clear_selection();
        self.select_id(gid, false);
        gid
    }

    fn apply_action(&mut self, action: &Action, reverse: bool) {
        match action {
            Action::Insert(snaps) => {
                if reverse {
                    for s in snaps {
                        self.nodes.remove_id(s.id);
                    }
                } else {
                    for s in snaps {
                        self.insert_snap(s);
                    }
                }
            }
            Action::Delete(snaps) => {
                if reverse {
                    for s in snaps {
                        self.insert_snap(s);
                    }
                } else {
                    for s in snaps {
                        self.nodes.remove_id(s.id);
                    }
                }
            }
            Action::Transform { before, after } => {
                self.apply_xforms(if reverse { before } else { after });
            }
            Action::Recolor(cs) => {
                for c in cs {
                    if let Some(&i) = self.nodes.index.get(&c.id) {
                        self.nodes.color[i] = if reverse { c.old } else { c.new };
                    }
                }
                self.dirty = true;
            }
            Action::SetScatter { before, after } => {
                self.scatter = if reverse { *before } else { *after };
                self.dirty = true;
                self.view_dirty = true;
            }
        }
    }

    fn undo(&mut self) -> i32 {
        let Some(a) = self.history.undo.pop() else {
            return 0;
        };
        self.apply_action(&a, true);
        self.history.redo.push(a);
        self.clear_selection();
        1
    }

    fn redo(&mut self) -> i32 {
        let Some(a) = self.history.redo.pop() else {
            return 0;
        };
        self.apply_action(&a, false);
        self.history.undo.push(a);
        self.clear_selection();
        1
    }

    fn pack_scatter(&mut self) {
        let Some(s) = self.scatter else {
            return;
        };
        if s.count == 0 {
            return;
        }
        let (c0, r0, c1, r1, stride) = self.scatter_window(s.count);
        self.pack_key = self.scatter_window_key();
        let cols = grid_cols(s.count);
        let tile = if stride > 1 {
            CELL * stride as f32 - 8.0
        } else {
            SIZE
        };
        let step = stride.max(1);
        for r in (r0..=r1).step_by(step as usize) {
            for c in (c0..=c1).step_by(step as usize) {
                let i = r * cols + c;
                if i >= s.count {
                    continue;
                }
                let mut p = pose_at(s.seed, i, s.count);
                if stride > 1 {
                    p.w = tile;
                    p.h = tile;
                    p.x = c as f32 * CELL + (CELL * stride as f32 - tile) * 0.5;
                    p.y = r as f32 * CELL + (CELL * stride as f32 - tile) * 0.5;
                }
                let red = ((p.color >> 16) & 255) as f32 / 255.0;
                let g = ((p.color >> 8) & 255) as f32 / 255.0;
                let b = (p.color & 255) as f32 / 255.0;
                push_instance(&mut self.instances, p.x, p.y, p.w, p.h, red, g, b, p.kind as f32);
            }
        }
    }

    fn pack_instances(&mut self) {
        if !self.dirty && !self.view_dirty && !self.instances.is_empty() {
            return;
        }
        let n = self.nodes.len();
        // outlines only for a modest selection — 100k outlines would dominate GPU
        let outline = self.selected.len() <= 64;
        let extra = if outline { self.selected.len() } else { 0 };
        self.instances.clear();
        self.instances.reserve((n + extra) * INST_FLOATS);
        self.pack_scatter();

        if outline {
            for &id in &self.selected {
                if let Some(&i) = self.nodes.index.get(&id) {
                    push_instance(
                        &mut self.instances,
                        self.nodes.x[i] - 2.0,
                        self.nodes.y[i] - 2.0,
                        self.nodes.w[i] + 4.0,
                        self.nodes.h[i] + 4.0,
                        0.05,
                        0.60,
                        1.0,
                        self.nodes.kind[i] as f32 + 20.0,
                    );
                }
            }
        }

        for i in 0..n {
            let kind = self.nodes.kind[i];
            if kind == KIND_GROUP {
                continue;
            }
            let c = self.nodes.color[i];
            let r = ((c >> 16) & 255) as f32 / 255.0;
            let g = ((c >> 8) & 255) as f32 / 255.0;
            let b = (c & 255) as f32 / 255.0;
            let sel = if outline && self.selected_set.contains(&self.nodes.id[i]) {
                10.0
            } else {
                0.0
            };
            push_instance(
                &mut self.instances,
                self.nodes.x[i],
                self.nodes.y[i],
                self.nodes.w[i],
                self.nodes.h[i],
                r,
                g,
                b,
                kind as f32 + sel,
            );
        }
        self.dirty = false;
        self.view_dirty = false;
    }

    fn bounds(&self) -> [f32; 4] {
        let mut minx = f32::MAX;
        let mut miny = f32::MAX;
        let mut maxx = f32::MIN;
        let mut maxy = f32::MIN;
        let mut any = false;
        if let Some(s) = self.scatter {
            let (ex, ey) = scatter_extent(s.count);
            minx = 0.0;
            miny = 0.0;
            maxx = ex;
            maxy = ey;
            any = true;
        }
        for i in 0..self.nodes.len() {
            any = true;
            minx = minx.min(self.nodes.x[i]);
            miny = miny.min(self.nodes.y[i]);
            maxx = maxx.max(self.nodes.x[i] + self.nodes.w[i]);
            maxy = maxy.max(self.nodes.y[i] + self.nodes.h[i]);
        }
        if !any {
            return [0.0, 0.0, 0.0, 0.0];
        }
        [minx, miny, maxx - minx, maxy - miny]
    }

    fn fill_info(&mut self) {
        let union = self.selection_union();
        self.info[0] = self.total_count() as f32;
        self.info[1] = self.selected.len() as f32;
        self.info[2] = self.selected.first().copied().unwrap_or(0) as f32;
        if let Some(&id) = self.selected.first() {
            if is_scatter_id(id) {
                if let Some(s) = self.scatter {
                    let idx = id - SCATTER_BASE;
                    if idx < s.count {
                        let p = pose_at(s.seed, idx, s.count);
                        self.info[3] = p.x;
                        self.info[4] = p.y;
                        self.info[5] = p.w;
                        self.info[6] = p.h;
                        self.info[7] = p.color as f32;
                        self.info[8] = p.kind as f32;
                    }
                }
            } else if let Some(&i) = self.nodes.index.get(&id) {
                self.info[3] = self.nodes.x[i];
                self.info[4] = self.nodes.y[i];
                self.info[5] = self.nodes.w[i];
                self.info[6] = self.nodes.h[i];
                self.info[7] = self.nodes.color[i] as f32;
                self.info[8] = self.nodes.kind[i] as f32;
            }
        } else {
            for v in &mut self.info[3..9] {
                *v = 0.0;
            }
        }
        self.info[9] = union[0];
        self.info[10] = union[1];
        self.info[11] = union[2];
        self.info[12] = union[3];
        self.info[13] = self.history.undo.len() as f32;
        self.info[14] = self.history.redo.len() as f32;
    }

    fn serialize(&mut self) {
        let n = self.nodes.len();
        // magic4 + ver2 + pad2 + count4 + next_id4 + n * (id4+kind1+pad3+parent4+4*f32+color4)
        let rec = 4 + 1 + 3 + 4 + 16 + 4;
        let cap = 16 + n * rec;
        self.scratch.clear();
        self.scratch.reserve(cap);
        self.scratch.extend_from_slice(MAGIC);
        self.scratch.extend_from_slice(&VERSION.to_le_bytes());
        self.scratch.extend_from_slice(&0u16.to_le_bytes());
        self.scratch.extend_from_slice(&(n as u32).to_le_bytes());
        self.scratch.extend_from_slice(&self.next_id.to_le_bytes());
        for i in 0..n {
            self.scratch.extend_from_slice(&self.nodes.id[i].to_le_bytes());
            self.scratch.push(self.nodes.kind[i]);
            self.scratch.extend_from_slice(&[0, 0, 0]);
            self.scratch.extend_from_slice(&self.nodes.parent[i].to_le_bytes());
            self.scratch.extend_from_slice(&self.nodes.x[i].to_le_bytes());
            self.scratch.extend_from_slice(&self.nodes.y[i].to_le_bytes());
            self.scratch.extend_from_slice(&self.nodes.w[i].to_le_bytes());
            self.scratch.extend_from_slice(&self.nodes.h[i].to_le_bytes());
            self.scratch.extend_from_slice(&self.nodes.color[i].to_le_bytes());
        }
        if self.grid_count > 0 {
            self.scratch.extend_from_slice(SCT_TAG);
            self.scratch.extend_from_slice(&self.grid_seed.to_le_bytes());
            self.scratch.extend_from_slice(&self.grid_count.to_le_bytes());
        } else if let Some(s) = self.scatter {
            self.scratch.extend_from_slice(SCT_TAG);
            self.scratch.extend_from_slice(&s.seed.to_le_bytes());
            self.scratch.extend_from_slice(&s.count.to_le_bytes());
        }
    }

    fn deserialize(&mut self, bytes: &[u8]) -> i32 {
        if bytes.len() < 16 || &bytes[0..4] != MAGIC {
            return 0;
        }
        let ver = u16::from_le_bytes([bytes[4], bytes[5]]);
        if ver != VERSION {
            return 0;
        }
        let n = u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize;
        let next_id = u32::from_le_bytes(bytes[12..16].try_into().unwrap());
        let rec = 32;
        if bytes.len() < 16 + n * rec {
            return 0;
        }
        self.nodes = NodeSoA::new();
        self.nodes.reserve(n);
        self.selected.clear();
        self.selected_set.clear();
        self.history = History::new();
        self.gesture = None;
        self.scatter = None;
        self.grid_seed = 0;
        self.grid_count = 0;
        let mut off = 16;
        for _ in 0..n {
            let id = u32::from_le_bytes(bytes[off..off + 4].try_into().unwrap());
            let kind = bytes[off + 4];
            let parent = u32::from_le_bytes(bytes[off + 8..off + 12].try_into().unwrap());
            let x = f32::from_le_bytes(bytes[off + 12..off + 16].try_into().unwrap());
            let y = f32::from_le_bytes(bytes[off + 16..off + 20].try_into().unwrap());
            let w = f32::from_le_bytes(bytes[off + 20..off + 24].try_into().unwrap());
            let h = f32::from_le_bytes(bytes[off + 24..off + 28].try_into().unwrap());
            let color = u32::from_le_bytes(bytes[off + 28..off + 32].try_into().unwrap());
            self.nodes.push(id, kind, parent, x, y, w, h, color);
            off += rec;
        }
        if off + 12 <= bytes.len() && &bytes[off..off + 4] == SCT_TAG {
            let seed = u32::from_le_bytes(bytes[off + 4..off + 8].try_into().unwrap());
            let count = u32::from_le_bytes(bytes[off + 8..off + 12].try_into().unwrap()).min(MAX_GEN);
            if count > 0 {
                self.grid_seed = seed;
                self.grid_count = count;
                if self.nodes.len() == 0 {
                    self.scatter = Some(Scatter { seed, count });
                }
            }
        }
        self.next_id = next_id.max(
            self.nodes
                .id
                .iter()
                .copied()
                .max()
                .unwrap_or(0)
                .saturating_add(1),
        );
        self.dirty = true;
        1
    }
}

fn push_instance(buf: &mut Vec<f32>, x: f32, y: f32, w: f32, h: f32, r: f32, g: f32, b: f32, flags: f32) {
    buf.extend_from_slice(&[x, y, w, h, r, g, b, flags]);
}

fn contains(x: f32, y: f32, w: f32, h: f32, kind: u8, px: f32, py: f32) -> bool {
    if px < x || py < y || px > x + w || py > y + h {
        return false;
    }
    if kind == KIND_ELLIPSE {
        let u = (px - x) / w * 2.0 - 1.0;
        let v = (py - y) / h * 2.0 - 1.0;
        return u * u + v * v <= 1.0;
    }
    true
}

struct Rng(u32);

impl Rng {
    fn next(&mut self) -> u32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        x
    }

    fn f(&mut self) -> f32 {
        (self.next() >> 8) as f32 / 16_777_216.0
    }

    fn range(&mut self, a: f32, b: f32) -> f32 {
        a + (b - a) * self.f()
    }

    fn color(&mut self) -> u32 {
        let h = self.f();
        let s = 0.45 + self.f() * 0.35;
        let v = 0.55 + self.f() * 0.4;
        hsv(h, s, v)
    }
}

fn hsv(h: f32, s: f32, v: f32) -> u32 {
    let i = (h * 6.0).floor();
    let f = h * 6.0 - i;
    let p = v * (1.0 - s);
    let q = v * (1.0 - f * s);
    let t = v * (1.0 - (1.0 - f) * s);
    let (r, g, b) = match (i as i32).rem_euclid(6) {
        0 => (v, t, p),
        1 => (q, v, p),
        2 => (p, v, t),
        3 => (p, q, v),
        4 => (t, p, v),
        _ => (v, p, q),
    };
    let ri = (r * 255.0) as u32;
    let gi = (g * 255.0) as u32;
    let bi = (b * 255.0) as u32;
    (ri << 16) | (gi << 8) | bi
}

// ── C ABI, Figma-style: JS talks to these exports only ──────────────

#[no_mangle]
pub extern "C" fn fig_init() {
    with(|app| *app = App::new());
}

#[no_mangle]
pub extern "C" fn fig_create(kind: u32, x: f32, y: f32, w: f32, h: f32, color: u32) -> u32 {
    with(|app| app.create(kind as u8, x, y, w, h, color, true))
}

#[no_mangle]
pub extern "C" fn fig_generate(n: u32, seed: u32) {
    with(|app| app.generate(n, seed));
}

#[no_mangle]
pub extern "C" fn fig_hit(x: f32, y: f32) -> u32 {
    with(|app| app.hit_at(x, y))
}

#[no_mangle]
pub extern "C" fn fig_select_at(x: f32, y: f32, additive: i32) -> u32 {
    with(|app| app.select_at(x, y, additive != 0))
}

#[no_mangle]
pub extern "C" fn fig_select_box(x0: f32, y0: f32, x1: f32, y1: f32, additive: i32) {
    with(|app| app.select_box(x0, y0, x1, y1, additive != 0));
}

#[no_mangle]
pub extern "C" fn fig_select_all() {
    with(|app| app.select_all());
}

#[no_mangle]
pub extern "C" fn fig_clear_selection() {
    with(|app| app.clear_selection());
}

#[no_mangle]
pub extern "C" fn fig_begin_gesture() {
    with(|app| app.begin_gesture());
}

#[no_mangle]
pub extern "C" fn fig_move_selected(dx: f32, dy: f32) {
    with(|app| app.move_selected(dx, dy));
}

#[no_mangle]
pub extern "C" fn fig_resize_handle(handle: i32, x: f32, y: f32) {
    with(|app| app.resize_handle(handle, x, y));
}

#[no_mangle]
pub extern "C" fn fig_commit_gesture() {
    with(|app| app.commit_gesture());
}

#[no_mangle]
pub extern "C" fn fig_set_color(color: u32) {
    with(|app| app.set_color_selected(color));
}

#[no_mangle]
pub extern "C" fn fig_set_rect(id: u32, x: f32, y: f32, w: f32, h: f32) {
    with(|app| app.set_rect(id, x, y, w, h));
}

#[no_mangle]
pub extern "C" fn fig_delete_selected() {
    with(|app| app.delete_selected());
}

#[no_mangle]
pub extern "C" fn fig_group_selected() -> u32 {
    with(|app| app.group_selected())
}

#[no_mangle]
pub extern "C" fn fig_undo() -> i32 {
    with(|app| app.undo())
}

#[no_mangle]
pub extern "C" fn fig_redo() -> i32 {
    with(|app| app.redo())
}

#[no_mangle]
pub extern "C" fn fig_pack() -> u32 {
    with(|app| {
        app.pack_instances();
        (app.instances.len() / INST_FLOATS) as u32
    })
}

#[no_mangle]
pub extern "C" fn fig_instance_ptr() -> u32 {
    with(|app| app.instances.as_ptr() as u32)
}

#[no_mangle]
pub extern "C" fn fig_instance_floats() -> u32 {
    INST_FLOATS as u32
}

#[no_mangle]
pub extern "C" fn fig_info_ptr() -> u32 {
    with(|app| {
        app.fill_info();
        app.info.as_ptr() as u32
    })
}

#[no_mangle]
pub extern "C" fn fig_node_count() -> u32 {
    with(|app| app.total_count())
}

#[no_mangle]
pub extern "C" fn fig_scatter_count() -> u32 {
    with(|app| app.scatter.map(|s| s.count).unwrap_or(0))
}

#[no_mangle]
pub extern "C" fn fig_set_view(pan_x: f32, pan_y: f32, zoom: f32, w: f32, h: f32) {
    with(|app| app.set_view(pan_x, pan_y, zoom, w, h));
}

#[no_mangle]
pub extern "C" fn fig_locate(num: u32) -> i32 {
    with(|app| app.locate(num))
}

#[no_mangle]
pub extern "C" fn fig_grid_seed() -> u32 {
    with(|app| app.grid_seed)
}

#[no_mangle]
pub extern "C" fn fig_grid_count() -> u32 {
    with(|app| app.grid_count)
}

#[no_mangle]
pub extern "C" fn fig_selected_count() -> u32 {
    with(|app| app.selected.len() as u32)
}

#[no_mangle]
pub extern "C" fn fig_is_selected(id: u32) -> i32 {
    with(|app| i32::from(app.selected_set.contains(&id)))
}

#[no_mangle]
pub extern "C" fn fig_alloc(n: u32) -> u32 {
    with(|app| {
        app.scratch.resize(n as usize, 0);
        app.scratch.as_mut_ptr() as u32
    })
}

#[no_mangle]
pub extern "C" fn fig_scratch_ptr() -> u32 {
    with(|app| app.scratch.as_ptr() as u32)
}

#[no_mangle]
pub extern "C" fn fig_serialize() -> u32 {
    with(|app| {
        app.serialize();
        app.scratch.len() as u32
    })
}

#[no_mangle]
pub extern "C" fn fig_deserialize(len: u32) -> i32 {
    with(|app| {
        let n = len as usize;
        if n > app.scratch.len() {
            return 0;
        }
        let bytes = app.scratch[..n].to_vec();
        app.deserialize(&bytes)
    })
}

#[no_mangle]
pub extern "C" fn fig_reset() {
    with(|app| *app = App::new());
}

#[no_mangle]
pub extern "C" fn fig_bounds_ptr() -> u32 {
    with(|app| {
        app.bounds_out = app.bounds();
        app.bounds_out.as_ptr() as u32
    })
}
