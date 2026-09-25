import { Figcore } from "./wasm-bridge.js";
import { GlRenderer, hitHandle, overlayHandles } from "./gl-renderer.js";
import { NaiveDoc, NaiveRenderer } from "./naive.js";
import { CELL, itemNumber, labelsForView } from "./scatter.js";

const $ = (id) => document.getElementById(id);

const camera = { panX: 0, panY: 0, zoom: 1 };
let tool = "select";
let backend = "wasm";
let core;
let naive = new NaiveDoc();
let glr;
let c2d;
let lastPackMs = 0;
let lastFps = 0;
let lastFrame = 0;
let rafSamples = [];
let needsUpload = true;
let spaceDown = false;
let drag = null;
let marquee = null;
let colorDraft = 0x4da3ff;
let benchRunning = false;

const HANDLE_CURSOR = ["nwse-resize", "ns-resize", "nesw-resize", "ew-resize", "nwse-resize", "ns-resize", "nesw-resize", "ew-resize"];

function active() {
  return backend === "wasm" ? core : naive;
}

function cssToCanvas(clientX, clientY, canvas) {
  const r = canvas.getBoundingClientRect();
  const dpr = canvas.width / r.width;
  return [(clientX - r.left) * dpr, (clientY - r.top) * dpr];
}

function screenToWorld(sx, sy) {
  return [(sx - camera.panX) / camera.zoom, (sy - camera.panY) / camera.zoom];
}

function hexColor(n) {
  return `#${(n >>> 0).toString(16).padStart(6, "0")}`;
}

function parseHex(s) {
  return parseInt(s.slice(1), 16) >>> 0;
}

function setTool(name) {
  tool = name;
  document.querySelectorAll("[data-tool]").forEach((b) => b.classList.toggle("on", b.dataset.tool === name));
}

function canvasEl() {
  return backend === "wasm" ? $("gl") : $("c2d");
}

function fitCamera() {
  const c = canvasEl();
  camera.zoom = 1;
  camera.panX = c.width * 0.5;
  camera.panY = c.height * 0.5;
}

function fitToDoc() {
  const c = canvasEl();
  const b = active().bounds();
  if (!b || b.w < 1 || b.h < 1) {
    fitCamera();
    return;
  }
  const pad = 48 * (c.width / Math.max(1, c.clientWidth));
  const zx = (c.width - pad * 2) / b.w;
  const zy = (c.height - pad * 2) / b.h;
  camera.zoom = Math.min(zx, zy, 8);
  camera.panX = c.width * 0.5 - (b.x + b.w * 0.5) * camera.zoom;
  camera.panY = c.height * 0.5 - (b.y + b.h * 0.5) * camera.zoom;
}

function syncModeUi() {
  $("modeWasm").classList.toggle("on", backend === "wasm");
  $("modeNaive").classList.toggle("on", backend === "naive");
  $("gl").hidden = backend !== "wasm";
  $("c2d").hidden = backend !== "naive";
}

function switchBackend(next) {
  if (next === backend) return;
  const bytes = active().serialize();
  backend = next;
  syncModeUi();
  glr.resize();
  c2d.resize();
  if (backend === "wasm") core.deserialize(bytes);
  else naive.deserialize(bytes);
  needsUpload = true;
  fitToDoc();
  updateUi();
}

function updateUi() {
  const info = active().info();
  $("nodeHud").textContent = `${info.nodes.toLocaleString("ru-RU")} узлов`;
  $("zoomHud").textContent = `${Math.round(camera.zoom * 100)}%`;
  const num = info.id ? itemNumber(info.id) : 0;
  $("selHint").textContent = info.selected
    ? `выделено: ${info.selected}` + (num ? ` · № ${num.toLocaleString("ru-RU")}` : "")
    : "ничего не выделено";
  const gridN = backend === "wasm" ? core.gridCount() : naive.gridCount;
  $("layerHint").textContent = info.nodes
    ? `${info.nodes.toLocaleString("ru-RU")} объектов сеткой, номера 1…${(gridN || info.nodes).toLocaleString("ru-RU")}${backend === "wasm" ? " (Wasm)" : " (JS)"}`
    : "пусто";

  const list = $("layerList");
  list.innerHTML = "";
  if (info.selected && info.selected <= 24) {
    const ids = backend === "wasm" ? [info.id] : naive.selected.slice(0, 24);
    for (const id of ids) {
      if (!id) continue;
      const li = document.createElement("li");
      li.textContent = `№ ${itemNumber(id)}`;
      li.className = "on";
      list.appendChild(li);
    }
  }

  const enable = info.selected > 0;
  for (const id of ["propX", "propY", "propW", "propH", "propColor"]) $(id).disabled = !enable;
  if (enable) {
    $("propX").value = Math.round(info.x);
    $("propY").value = Math.round(info.y);
    $("propW").value = Math.round(info.w);
    $("propH").value = Math.round(info.h);
    $("propColor").value = hexColor(info.color || colorDraft);
  }
}

function applyProps() {
  const info = active().info();
  if (!info.id) return;
  active().setRect(
    info.id,
    Number($("propX").value),
    Number($("propY").value),
    Number($("propW").value),
    Number($("propH").value),
  );
  needsUpload = true;
  updateUi();
}

function renderFrame(ts) {
  const tDraw = performance.now();
  if (backend === "wasm") {
    glr.resize();
    core.setView(camera.panX, camera.panY, camera.zoom, glr.canvas.width, glr.canvas.height);
    const packed = core.packedInstances();
    lastPackMs = packed.packMs;
    if (needsUpload || core.scatterCount() > 0) {
      glr.uploadInstances(packed.view, packed.count);
      needsUpload = false;
    }
    const info = core.info();
    const ov = overlayHandles(
      info.ux, info.uy, info.uw, info.uh,
      camera.zoom,
      marquee,
    );
    glr.setOverlay(ov);
    glr.draw(camera, packed.count);
  } else {
    c2d.resize();
    lastPackMs = c2d.draw(naive, camera, marquee);
  }
  lastDrawMs = performance.now() - tDraw;

  const dt = lastFrame ? ts - lastFrame : 16;
  lastFrame = ts;
  rafSamples.push({ dt, draw: lastDrawMs });
  if (rafSamples.length > 40) rafSamples.shift();
  const avgDt = rafSamples.reduce((a, b) => a + b.dt, 0) / rafSamples.length;
  lastFps = 1000 / avgDt;
  lastFrameMs = avgDt;

  $("fps").textContent = `${lastFps.toFixed(0)} FPS`;
  $("frameMs").textContent = `${lastFrameMs.toFixed(2)} ms`;
  $("packMs").textContent = backend === "wasm"
    ? `pack ${lastPackMs.toFixed(2)} ms · gpu ${lastDrawMs.toFixed(2)} ms`
    : `draw ${lastPackMs.toFixed(2)} ms`;
  $("zoomHud").textContent = `${Math.round(camera.zoom * 100)}%`;
  drawLabels();

  requestAnimationFrame(renderFrame);
}

function drawLabels() {
  const canvas = $("labels");
  const src = canvasEl();
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.floor(src.clientWidth * dpr));
  const h = Math.max(1, Math.floor(src.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const gridN = backend === "wasm" ? core.gridCount() : naive.gridCount;
  const seed = backend === "wasm" ? core.gridSeed() : naive.gridSeed;
  if (!gridN || CELL * camera.zoom < 22) return;
  const [x0, y0] = screenToWorld(0, 0);
  const [x1, y1] = screenToWorld(w, h);
  const labels = labelsForView(gridN, seed || 1, x0, y0, x1, y1, camera.zoom, 260);
  ctx.font = `600 ${Math.max(10, Math.min(16, CELL * camera.zoom * 0.28))}px Segoe UI, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.strokeStyle = "rgba(0,0,0,0.55)";
  ctx.lineWidth = 3;
  for (const p of labels) {
    const sx = p.x + p.w * 0.5;
    const sy = p.y + p.h * 0.5;
    const px = sx * camera.zoom + camera.panX;
    const py = sy * camera.zoom + camera.panY;
    const text = String(p.num);
    ctx.strokeText(text, px, py);
    ctx.fillText(text, px, py);
  }
}

let lastFrameMs = 16;
let lastDrawMs = 0;

function onPointerDown(ev) {
  if (ev.button === 1 || spaceDown || ev.button === 2) {
    drag = { kind: "pan", x: ev.clientX, y: ev.clientY, panX: camera.panX, panY: camera.panY };
    ev.preventDefault();
    return;
  }
  if (ev.button !== 0) return;
  const canvas = canvasEl();
  const [sx, sy] = cssToCanvas(ev.clientX, ev.clientY, canvas);
  const [wx, wy] = screenToWorld(sx, sy);
  const shift = ev.shiftKey;
  const api = active();
  const info = api.info();

  if (tool === "select" && info.selected > 0 && info.uw > 0) {
    const h = hitHandle(info.ux, info.uy, info.uw, info.uh, camera.zoom, wx, wy);
    if (h >= 0) {
      api.beginGesture();
      drag = { kind: "resize", handle: h };
      return;
    }
  }

  if (tool === "rect" || tool === "ellipse") {
    drag = { kind: "create", x0: wx, y0: wy, x1: wx, y1: wy };
    marquee = { x0: wx, y0: wy, x1: wx, y1: wy };
    return;
  }

  const id = api.hit(wx, wy);
  if (id && tool === "select") {
    const already = backend === "wasm" ? core.isSelected(id) : naive.selectedSet.has(id);
    if (!already || shift) api.selectAt(wx, wy, shift);
    api.beginGesture();
    drag = { kind: "move", lx: wx, ly: wy };
    updateUi();
    needsUpload = true;
    return;
  }

  if (!shift) api.clearSelection();
  drag = { kind: "marquee", x0: wx, y0: wy, x1: wx, y1: wy };
  marquee = { x0: wx, y0: wy, x1: wx, y1: wy };
  updateUi();
  needsUpload = true;
}

function onPointerMove(ev) {
  const canvas = canvasEl();
  const [sx, sy] = cssToCanvas(ev.clientX, ev.clientY, canvas);
  const [wx, wy] = screenToWorld(sx, sy);

  if (!drag) {
    const info = active().info();
    let cur = tool === "select" ? "default" : "crosshair";
    if (spaceDown) cur = "grab";
    if (info.selected && info.uw > 0) {
      const h = hitHandle(info.ux, info.uy, info.uw, info.uh, camera.zoom, wx, wy);
      if (h >= 0) cur = HANDLE_CURSOR[h];
    }
    canvas.style.cursor = cur;
    return;
  }

  if (drag.kind === "pan") {
    const dpr = canvas.width / canvas.getBoundingClientRect().width;
    camera.panX = drag.panX + (ev.clientX - drag.x) * dpr;
    camera.panY = drag.panY + (ev.clientY - drag.y) * dpr;
    return;
  }
  if (drag.kind === "move") {
    active().moveSelected(wx - drag.lx, wy - drag.ly);
    drag.lx = wx; drag.ly = wy;
    needsUpload = true;
    return;
  }
  if (drag.kind === "resize") {
    active().resizeHandle(drag.handle, wx, wy);
    needsUpload = true;
    return;
  }
  if (drag.kind === "marquee" || drag.kind === "create") {
    drag.x1 = wx; drag.y1 = wy;
    marquee = { x0: drag.x0, y0: drag.y0, x1: wx, y1: wy };
  }
}

function onPointerUp() {
  if (!drag) return;
  const api = active();
  if (drag.kind === "move" || drag.kind === "resize") {
    api.commitGesture();
  } else if (drag.kind === "marquee") {
    api.selectBox(drag.x0, drag.y0, drag.x1, drag.y1, false);
    needsUpload = true;
  } else if (drag.kind === "create") {
    const x = Math.min(drag.x0, drag.x1);
    const y = Math.min(drag.y0, drag.y1);
    const w = Math.abs(drag.x1 - drag.x0);
    const h = Math.abs(drag.y1 - drag.y0);
    if (w > 2 && h > 2) {
      const kind = tool === "ellipse" ? 1 : 0;
      api.create(kind, x, y, w, h, colorDraft);
      api.selectAt(x + w * 0.5, y + h * 0.5, false);
      needsUpload = true;
    }
  }
  drag = null;
  marquee = null;
  updateUi();
}

function onWheel(ev) {
  ev.preventDefault();
  const canvas = canvasEl();
  const [sx, sy] = cssToCanvas(ev.clientX, ev.clientY, canvas);
  const [wx, wy] = screenToWorld(sx, sy);
  const next = Math.min(64, Math.max(0.0002, camera.zoom * Math.exp(-ev.deltaY * 0.0015)));
  camera.zoom = next;
  camera.panX = sx - wx * next;
  camera.panY = sy - wy * next;
}

function generate(n, seed) {
  n = Math.max(1, Math.min(100_000_000, n | 0));
  const s = (seed == null ? (Math.random() * 0xffffffff) : seed) >>> 0;
  active().reset();
  const t0 = performance.now();
  active().generate(n, s || 1);
  const ms = performance.now() - t0;
  needsUpload = true;
  glr.resize();
  c2d.resize();
  fitToDoc();
  updateUi();
  $("selHint").textContent = `сцена: ${n.toLocaleString("ru-RU")} объектов за ${ms.toFixed(1)} ms`;
  return { ms, n, seed: s || 1 };
}

function findByNumber(num) {
  num = num | 0;
  if (num < 1) return;
  const ok = backend === "wasm" ? core.locate(num) : naive.locate(num);
  if (!ok) {
    $("selHint").textContent = `№ ${num} нет в сцене`;
    return;
  }
  const info = active().info();
  const c = canvasEl();
  const cx = info.x + info.w * 0.5;
  const cy = info.y + info.h * 0.5;
  camera.zoom = Math.max(camera.zoom, 1.1);
  camera.panX = c.width * 0.5 - cx * camera.zoom;
  camera.panY = c.height * 0.5 - cy * camera.zoom;
  needsUpload = true;
  updateUi();
}

async function bench() {
  if (benchRunning) return;
  benchRunning = true;
  $("btnBench").disabled = true;
  rafSamples = [];
  lastFrame = 0;
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const samples = [];
  const draws = [];
  const t0 = performance.now();
  const startPan = camera.panX;
  while (performance.now() - t0 < 3000) {
    camera.panX = startPan + Math.sin((performance.now() - t0) / 180) * 240;
    await new Promise((r) => requestAnimationFrame(r));
    samples.push(lastFrameMs);
    draws.push(lastDrawMs);
  }
  camera.panX = startPan;
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  const drawAvg = draws.reduce((a, b) => a + b, 0) / draws.length;
  const fps = 1000 / avg;
  const tr = document.createElement("tr");
  const n = active().nodeCount();
  tr.innerHTML = `<td>${backend === "wasm" ? "Wasm+GL" : "JS+2D"}</td><td>${n.toLocaleString("ru-RU")}</td><td>${fps.toFixed(1)}</td><td>${avg.toFixed(2)} ms</td><td>${drawAvg.toFixed(2)} ms</td>`;
  $("benchTable").tBodies[0].appendChild(tr);
  benchRunning = false;
  $("btnBench").disabled = false;
}

function saveDoc() {
  const bytes = active().serialize();
  const blob = new Blob([bytes], { type: "application/octet-stream" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "document.mfg";
  a.click();
  URL.revokeObjectURL(a.href);
}

async function loadDoc(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  if (!active().deserialize(buf)) {
    alert("Не формат MFG1");
    return;
  }
  needsUpload = true;
  updateUi();
}

function onKey(ev) {
  const meta = ev.ctrlKey || ev.metaKey;
  if (ev.code === "Space") {
    spaceDown = ev.type === "keydown";
    ev.preventDefault();
    return;
  }
  if (ev.type !== "keydown") return;
  if (ev.target.matches("input")) return;
  if (ev.key === "v" || ev.key === "V") setTool("select");
  if (ev.key === "r" || ev.key === "R") setTool("rect");
  if (ev.key === "o" || ev.key === "O") setTool("ellipse");
  if (ev.key === "Delete" || ev.key === "Backspace") {
    active().deleteSelected();
    needsUpload = true;
    updateUi();
  }
  if (meta && ev.key.toLowerCase() === "z") {
    ev.preventDefault();
    if (ev.shiftKey) active().redo();
    else active().undo();
    needsUpload = true;
    updateUi();
  }
  if (meta && ev.key.toLowerCase() === "y") {
    ev.preventDefault();
    active().redo();
    needsUpload = true;
    updateUi();
  }
  if (meta && ev.key.toLowerCase() === "a") {
    ev.preventDefault();
    active().selectAll();
    needsUpload = true;
    updateUi();
  }
  if (meta && ev.key.toLowerCase() === "g") {
    ev.preventDefault();
    active().groupSelected();
    needsUpload = true;
    updateUi();
  }
  if (ev.key === "0" && meta) {
    fitCamera();
  }
}

async function main() {
  core = await Figcore.load("figcore.wasm");
  glr = new GlRenderer($("gl"));
  c2d = new NaiveRenderer($("c2d"));
  glr.resize();
  c2d.resize();
  fitCamera();
  syncModeUi();

  document.querySelectorAll("[data-tool]").forEach((b) => {
    b.addEventListener("click", () => setTool(b.dataset.tool));
  });
  document.querySelectorAll("[data-gen]").forEach((b) => {
    b.addEventListener("click", () => generate(Number(b.dataset.gen)));
  });
  $("btnGenN").onclick = () => generate(Number($("genN").value) || 0);
  $("genN").addEventListener("keydown", (e) => {
    if (e.key === "Enter") generate(Number($("genN").value) || 0);
  });
  $("btnFind").onclick = () => findByNumber(Number($("findN").value));
  $("findN").addEventListener("keydown", (e) => {
    if (e.key === "Enter") findByNumber(Number($("findN").value));
  });
  $("btnUndo").onclick = () => { active().undo(); needsUpload = true; updateUi(); };
  $("btnRedo").onclick = () => { active().redo(); needsUpload = true; updateUi(); };
  $("btnDelete").onclick = () => { active().deleteSelected(); needsUpload = true; updateUi(); };
  $("btnGroup").onclick = () => { active().groupSelected(); needsUpload = true; updateUi(); };
  $("btnSave").onclick = saveDoc;
  $("btnLoad").onclick = () => $("fileIn").click();
  $("fileIn").onchange = () => { if ($("fileIn").files[0]) loadDoc($("fileIn").files[0]); };
  $("btnBench").onclick = bench;
  $("modeWasm").onclick = () => switchBackend("wasm");
  $("modeNaive").onclick = () => switchBackend("naive");
  for (const id of ["propX", "propY", "propW", "propH"]) {
    $(id).addEventListener("change", applyProps);
  }
  $("propColor").addEventListener("input", () => {
    colorDraft = parseHex($("propColor").value);
    active().setColor(colorDraft);
    needsUpload = true;
  });

  const stage = document.querySelector(".stage");
  stage.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  stage.addEventListener("wheel", onWheel, { passive: false });
  stage.addEventListener("contextmenu", (e) => e.preventDefault());
  window.addEventListener("keydown", onKey);
  window.addEventListener("keyup", onKey);
  window.addEventListener("resize", () => {
    glr.resize();
    c2d.resize();
  });

  updateUi();
  window.__fig = {
    generate,
    bench,
    switchBackend,
    info: () => ({
      ...active().info(),
      fps: lastFps,
      frameMs: lastFrameMs,
      packMs: lastPackMs,
      drawMs: lastDrawMs,
      backend,
      zoom: camera.zoom,
    }),
    results: () => [...$("benchTable").tBodies[0].rows].map((r) =>
      [...r.cells].map((c) => c.textContent)),
  };
  requestAnimationFrame(renderFrame);
}

main().catch((err) => {
  console.error(err);
  document.body.innerHTML = `<pre style="padding:24px;color:#ff8">Не удалось запустить прототип.\n${err}\n\nСоберите ядро:  .\\build.ps1\nи откройте через локальный сервер:  npm start</pre>`;
});
