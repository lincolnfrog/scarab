#!/usr/bin/env node
// Builds the extension into verifier/dist — the directory to load unpacked:
//   tsc for the scripts (no bundler: each file in dist/ is the one in src/,
//   minus the types), the static files copied, and the icons drawn here (a
//   gold coin with a check, in the four sizes Chrome wants; no binary files
//   in the repository).
//
//   node verifier/build.mjs        (npm run build:verifier)
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const dist = join(here, 'dist')
const tsc = join(here, '..', 'node_modules', 'typescript', 'bin', 'tsc')

/* ---------- the icon: a gold disc with a dark check ---------- */

/** RGBA pixels for one size: the disc is CLAUDE.md's gold, the check its page colour; edges anti-aliased by a 4×4 sample. */
function icon(size) {
  const gold = [0xe3, 0xb2, 0x3c]
  const ink = [0x0a, 0x0d, 0x12]
  const px = new Uint8Array(size * size * 4)
  const r = size / 2
  // the check: two segments in unit coordinates (0..1), stroke width relative to the size
  const a = [0.28, 0.52]
  const b = [0.44, 0.68]
  const c = [0.74, 0.34]
  const w = 0.1
  const inside = (x, y) => {
    const dx = x - r
    const dy = y - r
    if (dx * dx + dy * dy > (r - 0.5) ** 2) return null
    const ux = x / size
    const uy = y / size
    return segment(ux, uy, a, b) < w / 2 || segment(ux, uy, b, c) < w / 2 ? ink : gold
  }
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let n = 0
      const sum = [0, 0, 0]
      for (let sy = 0; sy < 4; sy++)
        for (let sx = 0; sx < 4; sx++) {
          const c = inside(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4)
          if (!c) continue
          n++
          for (let i = 0; i < 3; i++) sum[i] += c[i]
        }
      const o = (y * size + x) * 4
      if (n) for (let i = 0; i < 3; i++) px[o + i] = Math.round(sum[i] / n)
      px[o + 3] = Math.round((n / 16) * 255)
    }
  return png(size, size, px)
}

/** Distance from (x, y) to the segment p–q. */
function segment(x, y, p, q) {
  const vx = q[0] - p[0]
  const vy = q[1] - p[1]
  const t = Math.max(0, Math.min(1, ((x - p[0]) * vx + (y - p[1]) * vy) / (vx * vx + vy * vy)))
  return Math.hypot(x - (p[0] + t * vx), y - (p[1] + t * vy))
}

/** A PNG (8-bit RGBA, no filter) from raw pixels — the whole format is four chunks and a CRC. */
function png(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0 // filter: none
    Buffer.from(rgba.buffer, y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/* ---------- build ---------- */

rmSync(dist, { recursive: true, force: true })
execFileSync(process.execPath, [tsc, '-p', join(here, 'tsconfig.json')], { stdio: 'inherit' })
cpSync(join(here, 'static'), dist, { recursive: true })
mkdirSync(join(dist, 'icons'))
for (const size of [16, 32, 48, 128]) writeFileSync(join(dist, 'icons', `icon-${size}.png`), icon(size))
console.log(`verifier/dist: built — load it unpacked from chrome://extensions`)
