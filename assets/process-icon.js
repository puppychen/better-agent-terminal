#!/usr/bin/env node
/**
 * Process source icon: fill squircle corners with black, output all sizes
 */
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const { execSync } = require('child_process')

const OUT = __dirname
const SRC = path.join(OUT, 'icon-source-square.png')
const TARGET_SIZE = 1024

// Step 1: Use sips to resize source to 1024x1024
const resized = path.join(OUT, 'icon-source-1024.png')
execSync(`sips --resampleHeightWidth ${TARGET_SIZE} ${TARGET_SIZE} "${SRC}" --out "${resized}"`)

// Step 2: Read the resized PNG pixel data
function readPNG(fn) {
  const data = fs.readFileSync(fn)
  // Find IHDR
  let pos = 8 // skip PNG signature
  let width, height, bitDepth, colorType
  const chunks = []

  while (pos < data.length) {
    const len = data.readUInt32BE(pos)
    const type = data.slice(pos + 4, pos + 8).toString('ascii')
    const chunkData = data.slice(pos + 8, pos + 8 + len)

    if (type === 'IHDR') {
      width = chunkData.readUInt32BE(0)
      height = chunkData.readUInt32BE(4)
      bitDepth = chunkData[8]
      colorType = chunkData[9]
    }
    if (type === 'IDAT') chunks.push(chunkData)
    if (type === 'IEND') break
    pos += 12 + len
  }

  const compressed = Buffer.concat(chunks)
  const raw = zlib.inflateSync(compressed)

  // Parse raw scanlines (filter byte + pixel data per row)
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1
  const bpp = channels * (bitDepth / 8)
  const stride = width * bpp
  const pixels = Buffer.alloc(width * height * channels)

  // Previous row for filter reconstruction
  const prevRow = Buffer.alloc(stride)
  let rawPos = 0

  for (let y = 0; y < height; y++) {
    const filter = raw[rawPos++]
    const row = Buffer.alloc(stride)

    for (let i = 0; i < stride; i++) {
      const rawByte = raw[rawPos++]
      const a = i >= bpp ? row[i - bpp] : 0
      const b = prevRow[i]
      const c = i >= bpp ? prevRow[i - bpp] : 0

      switch (filter) {
        case 0: row[i] = rawByte; break
        case 1: row[i] = (rawByte + a) & 0xff; break
        case 2: row[i] = (rawByte + b) & 0xff; break
        case 3: row[i] = (rawByte + Math.floor((a + b) / 2)) & 0xff; break
        case 4: {
          const p = a + b - c
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
          const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
          row[i] = (rawByte + pr) & 0xff
          break
        }
      }
    }

    row.copy(pixels, y * stride, 0, stride)
    row.copy(prevRow, 0, 0, stride)
  }

  return { width, height, channels, pixels }
}

console.log('Reading source...')
const img = readPNG(resized)
const SIZE = img.width
const HALF = SIZE / 2
const ch = img.channels

// Step 3: Create RGB buffer, fill squircle corners with black
console.log('Processing squircle mask...')
const buf = Buffer.alloc(SIZE * SIZE * 3)

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const si = (y * SIZE + x) * ch
    const di = (y * SIZE + x) * 3
    const r = img.pixels[si], g = img.pixels[si + 1], b = img.pixels[si + 2]

    // Squircle test (same as original icon generator)
    const rx = Math.abs(x - HALF), ry = Math.abs(y - HALF)
    const a = HALF - 12
    const sq = (rx / a) ** 5 + (ry / a) ** 5

    if (sq > 1) {
      // Outside squircle — black
      buf[di] = 0; buf[di + 1] = 0; buf[di + 2] = 0
    } else if (sq > 0.92) {
      // Edge fade
      const t = (sq - 0.92) / (1 - 0.92)
      const fade = 1 - t * t
      buf[di] = Math.round(r * fade)
      buf[di + 1] = Math.round(g * fade)
      buf[di + 2] = Math.round(b * fade)
    } else {
      buf[di] = r; buf[di + 1] = g; buf[di + 2] = b
    }
  }
}

// Step 4: Write PNGs
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

console.log('Writing icons...')
writePNG(path.join(OUT, 'icon.png'), buf, SIZE, SIZE)

for (const sz of [512, 256, 128, 64, 48, 32, 16]) {
  const sb = Buffer.alloc(sz * sz * 3), sc = SIZE / sz
  for (let y = 0; y < sz; y++) {
    for (let x = 0; x < sz; x++) {
      let r = 0, g = 0, b = 0, c = 0
      // Supersampling for quality downscale
      const samples = Math.max(2, Math.min(8, Math.ceil(sc / 2)))
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const srcX = Math.min(SIZE - 1, Math.floor(x * sc + sx * sc / samples))
          const srcY = Math.min(SIZE - 1, Math.floor(y * sc + sy * sc / samples))
          const i = (srcY * SIZE + srcX) * 3
          r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; c++
        }
      }
      const di = (y * sz + x) * 3
      sb[di] = Math.round(r / c); sb[di + 1] = Math.round(g / c); sb[di + 2] = Math.round(b / c)
    }
  }
  writePNG(path.join(OUT, `icon-${sz}.png`), sb, sz, sz)
}

// Cleanup temp files
fs.unlinkSync(resized)
fs.unlinkSync(path.join(OUT, 'icon-source-square.png'))
console.log('Done!')
