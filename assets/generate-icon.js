#!/usr/bin/env node
/**
 * Better Agent Workspace icon v5
 * Walking figure emerging through neural network mesh
 * Dark background, golden network, cream figure with dark outlines, warm golden glow
 */
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const SIZE = 1024
const HALF = SIZE / 2
const OUT = __dirname

// ===== Color palette =====
const BG = [25, 25, 28]
const OUTLINE_C = [10, 10, 14]
const FIGURE_C = [240, 225, 190]
const NET_LINE_C = [148, 128, 62]
const NET_NODE_C = [195, 170, 80]
const NET_BRIGHT_C = [225, 198, 95]
const GLOW_C = [255, 200, 50]

// ===== Utility =====
function clamp(t) { return Math.max(0, Math.min(1, t)) }
function dist(x, y, cx, cy) { return Math.sqrt((x - cx) ** 2 + (y - cy) ** 2) }
function ss(e0, e1, x) { const t = clamp((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t) }

// ===== Buffer =====
const buf = Buffer.alloc(SIZE * SIZE * 3)
function set(x, y, r, g, b) {
  if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) return
  const i = (y * SIZE + x) * 3
  buf[i] = r; buf[i + 1] = g; buf[i + 2] = b
}
function get(x, y) {
  const i = (y * SIZE + x) * 3
  return [buf[i], buf[i + 1], buf[i + 2]]
}
function blend(x, y, c, a) {
  if (x < 0 || x >= SIZE || y < 0 || y >= SIZE || a <= 0) return
  const bg = get(x, y)
  set(x, y,
    Math.round(bg[0] * (1 - a) + c[0] * a),
    Math.round(bg[1] * (1 - a) + c[1] * a),
    Math.round(bg[2] * (1 - a) + c[2] * a)
  )
}

// ===== Drawing =====
function drawPolyC(pts, sw, color, aa = 3) {
  let mnX = Infinity, mxX = -Infinity, mnY = Infinity, mxY = -Infinity
  for (const p of pts) {
    mnX = Math.min(mnX, p[0]); mxX = Math.max(mxX, p[0])
    mnY = Math.min(mnY, p[1]); mxY = Math.max(mxY, p[1])
  }
  const pad = sw / 2 + aa + 2
  const x0 = Math.max(0, Math.floor(mnX - pad))
  const x1 = Math.min(SIZE - 1, Math.ceil(mxX + pad))
  const y0 = Math.max(0, Math.floor(mnY - pad))
  const y1 = Math.min(SIZE - 1, Math.ceil(mxY + pad))
  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      let md = Infinity
      for (let i = 0; i < pts.length - 1; i++) {
        const [ax, ay] = pts[i], [bx, by] = pts[i + 1]
        const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy
        const t = l2 === 0 ? 0 : clamp(((px - ax) * dx + (py - ay) * dy) / l2)
        const d = dist(px, py, ax + t * dx, ay + t * dy)
        if (d < md) md = d
      }
      if (md > sw / 2 + aa) continue
      const alpha = 1 - ss(sw / 2 - aa, sw / 2 + aa, md)
      if (alpha > 0.01) blend(px, py, color, alpha)
    }
  }
}

function drawLineC(x1, y1, x2, y2, sw, color, aa) {
  drawPolyC([[x1, y1], [x2, y2]], sw, color, aa)
}

function bezPt(t, p0, p1, p2, p3) {
  const u = 1 - t
  return [
    u*u*u*p0[0] + 3*u*u*t*p1[0] + 3*u*t*t*p2[0] + t*t*t*p3[0],
    u*u*u*p0[1] + 3*u*u*t*p1[1] + 3*u*t*t*p2[1] + t*t*t*p3[1]
  ]
}

function sampleBez(p0, p1, p2, p3, n = 300) {
  const pts = []
  for (let i = 0; i <= n; i++) pts.push(bezPt(i / n, p0, p1, p2, p3))
  return pts
}

function drawBezC(p0, p1, p2, p3, sw, color) {
  drawPolyC(sampleBez(p0, p1, p2, p3), sw, color)
}

function fillCircle(cx, cy, r, color, aa = 3) {
  const raa = r + aa
  for (let py = Math.max(0, Math.floor(cy - raa)); py <= Math.min(SIZE - 1, Math.ceil(cy + raa)); py++) {
    for (let px = Math.max(0, Math.floor(cx - raa)); px <= Math.min(SIZE - 1, Math.ceil(cx + raa)); px++) {
      const d = dist(px, py, cx, cy)
      if (d > raa) continue
      const alpha = 1 - ss(r - aa, r + aa, d)
      if (alpha > 0.01) blend(px, py, color, alpha)
    }
  }
}

function addGlow(cx, cy, radius, color, intensity) {
  for (let py = Math.max(0, Math.floor(cy - radius)); py <= Math.min(SIZE - 1, Math.ceil(cy + radius)); py++) {
    for (let px = Math.max(0, Math.floor(cx - radius)); px <= Math.min(SIZE - 1, Math.ceil(cx + radius)); px++) {
      const d = dist(px, py, cx, cy)
      if (d > radius) continue
      const f = 1 - (d / radius)
      const a = f * f * intensity
      if (a > 0.003) blend(px, py, color, a)
    }
  }
}

// =========================================================
// 1. Background
// =========================================================
console.log('Background...')
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const d = dist(x, y, HALF, HALF) / (HALF * 1.2)
    const f = 1 - clamp(d) * 0.3
    set(x, y,
      Math.round(BG[0] * f),
      Math.round(BG[1] * f),
      Math.round(BG[2] * f)
    )
  }
}

// Subtle warm center glow on background
console.log('Ambient glow...')
addGlow(490, 440, 380, [50, 38, 8], 0.08)

// =========================================================
// 2. Neural network mesh
// =========================================================
console.log('Network...')
const nodes = [
  [488, 108],   // 0: top
  [218, 238],   // 1: upper left
  [762, 218],   // 2: upper right
  [92,  478],   // 3: mid left
  [758, 438],   // 4: right (near hand)
  [148, 708],   // 5: lower left
  [878, 638],   // 6: lower right
  [278, 858],   // 7: bottom left
  [718, 848],   // 8: bottom right
  [498, 918],   // 9: bottom center
  [908, 298],   // 10: far upper right
]

const edges = [
  // Outer perimeter
  [0, 1], [0, 2], [1, 3], [2, 10], [10, 4],
  [3, 5], [4, 6], [5, 7], [6, 8], [7, 9], [8, 9],
  // Horizontal connections
  [1, 2], [3, 4], [5, 6], [7, 8],
  // Cross-diagonals
  [0, 4], [0, 3],
  [1, 5], [2, 6],
  [1, 4], [2, 3],
  [3, 7], [4, 8], [6, 9], [5, 9],
  [10, 6],
]

// Draw edges
for (const [a, b] of edges) {
  drawLineC(nodes[a][0], nodes[a][1], nodes[b][0], nodes[b][1], 6, NET_LINE_C, 2)
}

// Draw nodes
const brightSet = new Set([0, 4, 7, 9])
for (let i = 0; i < nodes.length; i++) {
  const [nx, ny] = nodes[i]
  const bright = brightSet.has(i)
  fillCircle(nx, ny, bright ? 16 : 12, bright ? NET_BRIGHT_C : NET_NODE_C, 2)
  if (bright) addGlow(nx, ny, 55, GLOW_C, 0.18)
}

// =========================================================
// 3. Walking figure
// =========================================================
console.log('Figure...')

// Body keypoints
const HEAD = { cx: 480, cy: 210, r: 56 }
const NECK = [485, 270]
const SH_L = [385, 318]
const SH_R = [585, 312]
const HIP_C = [492, 568]
const HIP_L = [462, 575]
const HIP_R = [522, 568]

// Arms
const ELB_L = [308, 388]
const HAND_L = [248, 345]
const ELB_R = [672, 385]
const HAND_R = [748, 435]

// Legs
const KNEE_L = [382, 698]
const FOOT_L = [342, 838]
const KNEE_R = [598, 688]
const FOOT_R = [652, 828]

// Stroke widths
const OW = 50   // outline
const FW = 28   // fill

// --- Outline pass (thick, dark) ---
fillCircle(HEAD.cx, HEAD.cy, HEAD.r + 11, OUTLINE_C, 3)
drawLineC(HEAD.cx + 3, HEAD.cy + HEAD.r - 8, NECK[0], NECK[1], OW, OUTLINE_C)
drawLineC(SH_L[0], SH_L[1], SH_R[0], SH_R[1], OW - 4, OUTLINE_C)
drawBezC(NECK, [NECK[0]+3, NECK[1]+80], [HIP_C[0]+8, HIP_C[1]-80], HIP_C, OW, OUTLINE_C)
// Left arm
drawBezC(SH_L, [SH_L[0]-18, SH_L[1]+25], [ELB_L[0]+12, ELB_L[1]-18], ELB_L, OW-6, OUTLINE_C)
drawBezC(ELB_L, [ELB_L[0]-18, ELB_L[1]-12], [HAND_L[0]+12, HAND_L[1]+10], HAND_L, OW-6, OUTLINE_C)
// Right arm
drawBezC(SH_R, [SH_R[0]+22, SH_R[1]+8], [ELB_R[0]-8, ELB_R[1]-18], ELB_R, OW-6, OUTLINE_C)
drawBezC(ELB_R, [ELB_R[0]+18, ELB_R[1]+8], [HAND_R[0]-15, HAND_R[1]-8], HAND_R, OW-6, OUTLINE_C)
// Left leg
drawBezC(HIP_L, [HIP_L[0]-18, HIP_L[1]+45], [KNEE_L[0]+8, KNEE_L[1]-35], KNEE_L, OW-4, OUTLINE_C)
drawBezC(KNEE_L, [KNEE_L[0]-8, KNEE_L[1]+35], [FOOT_L[0]+8, FOOT_L[1]-25], FOOT_L, OW-4, OUTLINE_C)
// Right leg
drawBezC(HIP_R, [HIP_R[0]+12, HIP_R[1]+45], [KNEE_R[0]-6, KNEE_R[1]-35], KNEE_R, OW-4, OUTLINE_C)
drawBezC(KNEE_R, [KNEE_R[0]+8, KNEE_R[1]+35], [FOOT_R[0]-5, FOOT_R[1]-25], FOOT_R, OW-4, OUTLINE_C)
// Hand/foot endpoints (outline)
fillCircle(HAND_L[0], HAND_L[1], 18, OUTLINE_C, 2)
fillCircle(HAND_R[0], HAND_R[1], 18, OUTLINE_C, 2)
fillCircle(FOOT_L[0], FOOT_L[1], 20, OUTLINE_C, 2)
fillCircle(FOOT_R[0], FOOT_R[1], 20, OUTLINE_C, 2)

// --- Fill pass (thinner, cream) ---
fillCircle(HEAD.cx, HEAD.cy, HEAD.r, FIGURE_C, 3)
drawLineC(HEAD.cx + 3, HEAD.cy + HEAD.r - 8, NECK[0], NECK[1], FW, FIGURE_C)
drawLineC(SH_L[0], SH_L[1], SH_R[0], SH_R[1], FW - 2, FIGURE_C)
drawBezC(NECK, [NECK[0]+3, NECK[1]+80], [HIP_C[0]+8, HIP_C[1]-80], HIP_C, FW, FIGURE_C)
// Left arm
drawBezC(SH_L, [SH_L[0]-18, SH_L[1]+25], [ELB_L[0]+12, ELB_L[1]-18], ELB_L, FW-4, FIGURE_C)
drawBezC(ELB_L, [ELB_L[0]-18, ELB_L[1]-12], [HAND_L[0]+12, HAND_L[1]+10], HAND_L, FW-4, FIGURE_C)
// Right arm
drawBezC(SH_R, [SH_R[0]+22, SH_R[1]+8], [ELB_R[0]-8, ELB_R[1]-18], ELB_R, FW-4, FIGURE_C)
drawBezC(ELB_R, [ELB_R[0]+18, ELB_R[1]+8], [HAND_R[0]-15, HAND_R[1]-8], HAND_R, FW-4, FIGURE_C)
// Left leg
drawBezC(HIP_L, [HIP_L[0]-18, HIP_L[1]+45], [KNEE_L[0]+8, KNEE_L[1]-35], KNEE_L, FW-2, FIGURE_C)
drawBezC(KNEE_L, [KNEE_L[0]-8, KNEE_L[1]+35], [FOOT_L[0]+8, FOOT_L[1]-25], FOOT_L, FW-2, FIGURE_C)
// Right leg
drawBezC(HIP_R, [HIP_R[0]+12, HIP_R[1]+45], [KNEE_R[0]-6, KNEE_R[1]-35], KNEE_R, FW-2, FIGURE_C)
drawBezC(KNEE_R, [KNEE_R[0]+8, KNEE_R[1]+35], [FOOT_R[0]-5, FOOT_R[1]-25], FOOT_R, FW-2, FIGURE_C)
// Hand/foot endpoints (fill)
fillCircle(HAND_L[0], HAND_L[1], 9, FIGURE_C, 2)
fillCircle(HAND_R[0], HAND_R[1], 9, FIGURE_C, 2)
fillCircle(FOOT_L[0], FOOT_L[1], 11, FIGURE_C, 2)
fillCircle(FOOT_R[0], FOOT_R[1], 11, FIGURE_C, 2)

// =========================================================
// 4. Glow effects
// =========================================================
console.log('Glow...')
// Head halo
addGlow(HEAD.cx, HEAD.cy, 115, GLOW_C, 0.10)
// Figure center warmth
addGlow(490, 450, 250, GLOW_C, 0.04)

// =========================================================
// 5. Post-processing
// =========================================================
console.log('Squircle mask...')
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const rx = Math.abs(x - HALF), ry = Math.abs(y - HALF), a = HALF - 12
    const sq = (rx / a) ** 5 + (ry / a) ** 5
    if (sq > 1) {
      const fade = 1 - ss(1.0, 1.06, sq)
      if (fade < 1) {
        const c = get(x, y)
        set(x, y, Math.round(c[0] * fade), Math.round(c[1] * fade), Math.round(c[2] * fade))
      }
    }
  }
}

console.log('Noise...')
let seed = 42
function rand() { seed = (seed * 1664525 + 1013904223) & 0x7fffffff; return (seed / 0x7fffffff) * 2 - 1 }
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const n = rand() * 1.5
    const c = get(x, y)
    set(x, y,
      Math.max(0, Math.min(255, Math.round(c[0] + n))),
      Math.max(0, Math.min(255, Math.round(c[1] + n))),
      Math.max(0, Math.min(255, Math.round(c[2] + n)))
    )
  }
}

// =========================================================
// 6. PNG output
// =========================================================
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0)
  }
  return (c ^ 0xffffffff) >>> 0
}

function makeChunk(type, data) {
  const td = Buffer.concat([Buffer.from(type), data])
  const c = crc32(td)
  const l = Buffer.alloc(4), cr = Buffer.alloc(4)
  l.writeUInt32BE(data.length, 0)
  cr.writeUInt32BE(c, 0)
  return Buffer.concat([l, td, cr])
}

function writePNG(fn, pb, w, h) {
  const raw = Buffer.alloc(h * (1 + w * 3))
  let o = 0
  for (let y = 0; y < h; y++) {
    raw[o++] = 0
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3
      raw[o++] = pb[i]; raw[o++] = pb[i + 1]; raw[o++] = pb[i + 2]
    }
  }
  const comp = zlib.deflateSync(raw, { level: 9 })
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  fs.writeFileSync(fn, Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', comp),
    makeChunk('IEND', Buffer.alloc(0))
  ]))
  console.log(`  ${path.basename(fn)} (${(fs.statSync(fn).size / 1024).toFixed(0)}KB)`)
}

console.log('Writing...')
writePNG(path.join(OUT, 'icon-new.png'), buf, SIZE, SIZE)

for (const sz of [512, 256, 128, 64, 48, 32, 16]) {
  const sb = Buffer.alloc(sz * sz * 3), sc = SIZE / sz
  for (let y = 0; y < sz; y++) {
    for (let x = 0; x < sz; x++) {
      let r = 0, g = 0, b = 0, c = 0
      const st = Math.max(1, Math.floor(sc / 3))
      for (let sy = 0; sy < sc; sy += st) {
        for (let sx = 0; sx < sc; sx += st) {
          const i = (Math.min(SIZE - 1, Math.floor(y * sc + sy)) * SIZE + Math.min(SIZE - 1, Math.floor(x * sc + sx))) * 3
          r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; c++
        }
      }
      const di = (y * sz + x) * 3
      sb[di] = Math.round(r / c); sb[di + 1] = Math.round(g / c); sb[di + 2] = Math.round(b / c)
    }
  }
  writePNG(path.join(OUT, `icon-new-${sz}.png`), sb, sz, sz)
}

for (const f of ['icon.png', 'icon-512.png', 'icon-256.png', 'icon-128.png', 'icon-64.png', 'icon-48.png', 'icon-32.png', 'icon-16.png']) {
  const src = f === 'icon.png' ? 'icon-new.png' : `icon-new-${f.match(/\d+/)[0]}.png`
  fs.copyFileSync(path.join(OUT, src), path.join(OUT, f))
}
console.log('Done!')
