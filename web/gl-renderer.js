const VS = `#version 300 es
layout(location=0) in vec2 a_corner;
layout(location=1) in vec4 a_xywh;
layout(location=2) in vec3 a_rgb;
layout(location=3) in float a_flags;
uniform vec2 u_res;
uniform vec2 u_pan;
uniform float u_zoom;
out vec2 v_uv;
out vec3 v_rgb;
out float v_kind;
void main() {
  vec2 pos = a_xywh.xy + a_corner * a_xywh.zw;
  vec2 clip = ((pos * u_zoom + u_pan) / u_res) * 2.0 - 1.0;
  clip.y *= -1.0;
  gl_Position = vec4(clip, 0.0, 1.0);
  v_uv = a_corner;
  v_rgb = a_rgb;
  v_kind = a_flags;
}
`;

const FS = `#version 300 es
precision mediump float;
in vec2 v_uv;
in vec3 v_rgb;
in float v_kind;
out vec4 frag;
void main() {
  float kind = mod(v_kind, 10.0);
  // 20+ = selection halo (rect or ellipse)
  if (v_kind >= 29.5) {
    frag = vec4(0.05, 0.45, 0.85, 0.16);
    return;
  }
  if (v_kind >= 20.0) {
    float ek = v_kind - 20.0;
    if (ek > 0.5 && ek < 1.5) {
      vec2 p = v_uv * 2.0 - 1.0;
      if (dot(p, p) > 1.0) discard;
    }
    frag = vec4(0.05, 0.60, 1.0, 1.0);
    return;
  }
  if (kind > 0.5 && kind < 1.5) {
    vec2 p = v_uv * 2.0 - 1.0;
    if (dot(p, p) > 1.0) discard;
  }
  frag = vec4(v_rgb, 1.0);
}
`;

const GRID_VS = `#version 300 es
layout(location=0) in vec2 a_pos;
out vec2 v_screen;
void main() {
  v_screen = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const GRID_FS = `#version 300 es
precision mediump float;
in vec2 v_screen;
uniform vec2 u_res;
uniform vec2 u_pan;
uniform float u_zoom;
out vec4 frag;
void main() {
  // v_screen is clip-space mapped to 0..1 with origin at bottom-left.
  vec2 s = vec2(v_screen.x * u_res.x, (1.0 - v_screen.y) * u_res.y);
  vec2 w = (s - u_pan) / u_zoom;
  float cell = 64.0;
  if (u_zoom < 0.35) cell = 256.0;
  if (u_zoom > 2.0) cell = 16.0;
  vec2 g = abs(mod(w, cell));
  float line = cell * 0.03 / u_zoom;
  float axis = 1.5 / u_zoom;
  float gx = min(g.x, cell - g.x);
  float gy = min(g.y, cell - g.y);
  float grid = 1.0 - smoothstep(0.0, line, min(gx, gy));
  float onX = 1.0 - smoothstep(0.0, axis, abs(w.x));
  float onY = 1.0 - smoothstep(0.0, axis, abs(w.y));
  vec3 col = vec3(0.122, 0.122, 0.122);
  col = mix(col, vec3(0.18), grid);
  col = mix(col, vec3(0.36, 0.18, 0.18), onY);
  col = mix(col, vec3(0.18, 0.22, 0.36), onX);
  frag = vec4(col, 1.0);
}
`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(s) || "shader");
  }
  return s;
}

function program(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(p) || "program");
  }
  return p;
}

export class GlRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl2", {
      antialias: false,
      alpha: false,
      preserveDrawingBuffer: false,
      powerPreference: "high-performance",
    });
    if (!gl) throw new Error("WebGL2 is required");
    this.gl = gl;
    this.prog = program(gl, VS, FS);
    this.gridProg = program(gl, GRID_VS, GRID_FS);
    this.uRes = gl.getUniformLocation(this.prog, "u_res");
    this.uPan = gl.getUniformLocation(this.prog, "u_pan");
    this.uZoom = gl.getUniformLocation(this.prog, "u_zoom");
    this.gRes = gl.getUniformLocation(this.gridProg, "u_res");
    this.gPan = gl.getUniformLocation(this.gridProg, "u_pan");
    this.gZoom = gl.getUniformLocation(this.gridProg, "u_zoom");

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);

    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.inst = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.inst);
    const stride = 32;
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 3, gl.FLOAT, false, stride, 16);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, stride, 28);
    gl.vertexAttribDivisor(3, 1);

    this.gridVao = gl.createVertexArray();
    gl.bindVertexArray(this.gridVao);
    this.fsq = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fsq);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.overlay = gl.createBuffer();
    this.overlayCount = 0;
    this.lastCount = 0;
    this.dpr = 1;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
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
    this.gl.viewport(0, 0, w, h);
  }

  /**
   * Upload the Wasm instance buffer as a single GPU copy.
   * `view` is a Float32Array over Wasm memory — we do not iterate nodes.
   */
  uploadInstances(view, count) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.inst);
    if (count > this.lastCount * 1.2 + 64 || count < this.lastCount * 0.5) {
      gl.bufferData(gl.ARRAY_BUFFER, view, gl.DYNAMIC_DRAW);
    } else {
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, view);
    }
    this.lastCount = Math.max(this.lastCount, count);
  }

  setOverlay(floats) {
    const gl = this.gl;
    this.overlayCount = (floats.length / 8) | 0;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.overlay);
    gl.bufferData(gl.ARRAY_BUFFER, floats, gl.DYNAMIC_DRAW);
  }

  draw(camera, shapeCount) {
    const gl = this.gl;
    const w = this.canvas.width;
    const h = this.canvas.height;

    gl.useProgram(this.gridProg);
    gl.bindVertexArray(this.gridVao);
    gl.uniform2f(this.gRes, w, h);
    gl.uniform2f(this.gPan, camera.panX, camera.panY);
    gl.uniform1f(this.gZoom, camera.zoom);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    gl.useProgram(this.prog);
    gl.uniform2f(this.uRes, w, h);
    gl.uniform2f(this.uPan, camera.panX, camera.panY);
    gl.uniform1f(this.uZoom, camera.zoom);

    if (shapeCount > 0) {
      gl.bindVertexArray(this.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.inst);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, shapeCount);
    }

    if (this.overlayCount > 0) {
      gl.bindVertexArray(this.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.overlay);
      const stride = 32;
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 0);
      gl.vertexAttribPointer(2, 3, gl.FLOAT, false, stride, 16);
      gl.vertexAttribPointer(3, 1, gl.FLOAT, false, stride, 28);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.overlayCount);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.inst);
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 0);
      gl.vertexAttribPointer(2, 3, gl.FLOAT, false, stride, 16);
      gl.vertexAttribPointer(3, 1, gl.FLOAT, false, stride, 28);
    }
  }
}

export function handleRects(ux, uy, uw, uh, zoom) {
  const s = 8 / zoom;
  const hs = s * 0.5;
  const pts = [
    [ux, uy], [ux + uw * 0.5, uy], [ux + uw, uy],
    [ux + uw, uy + uh * 0.5],
    [ux + uw, uy + uh], [ux + uw * 0.5, uy + uh], [ux, uy + uh],
    [ux, uy + uh * 0.5],
  ];
  return pts.map(([x, y]) => [x - hs, y - hs, s, s]);
}

export function hitHandle(ux, uy, uw, uh, zoom, wx, wy) {
  const rects = handleRects(ux, uy, uw, uh, zoom);
  const pad = 2 / zoom;
  for (let i = 0; i < rects.length; i++) {
    const [x, y, w, h] = rects[i];
    if (wx >= x - pad && wy >= y - pad && wx <= x + w + pad && wy <= y + h + pad) return i;
  }
  return -1;
}

export function overlayHandles(ux, uy, uw, uh, zoom, marquee) {
  const out = [];
  const push = (x, y, w, h, r, g, b, flags) => {
    out.push(x, y, w, h, r, g, b, flags);
  };
  if (uw > 0 && uh > 0) {
    push(ux, uy, uw, 1.25 / zoom, 0.05, 0.6, 1, 0);
    push(ux, uy + uh, uw, 1.25 / zoom, 0.05, 0.6, 1, 0);
    push(ux, uy, 1.25 / zoom, uh, 0.05, 0.6, 1, 0);
    push(ux + uw, uy, 1.25 / zoom, uh, 0.05, 0.6, 1, 0);
    for (const [x, y, w, h] of handleRects(ux, uy, uw, uh, zoom)) {
      push(x - 1 / zoom, y - 1 / zoom, w + 2 / zoom, h + 2 / zoom, 0.05, 0.6, 1, 0);
      push(x, y, w, h, 1, 1, 1, 0);
    }
  }
  if (marquee) {
    const x = Math.min(marquee.x0, marquee.x1);
    const y = Math.min(marquee.y0, marquee.y1);
    const w = Math.abs(marquee.x1 - marquee.x0);
    const h = Math.abs(marquee.y1 - marquee.y0);
    push(x, y, w, h, 0.05, 0.45, 0.85, 30);
  }
  return new Float32Array(out);
}
