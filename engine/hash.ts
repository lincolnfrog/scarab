/**
 * Synchronous SHA-1, pure TypeScript. The engine runs identically in Node and
 * the browser; WebCrypto's digest is async (which would poison the whole
 * import pipeline) and node:crypto doesn't exist in browsers — so the dedupe
 * hash is computed here, dependency-free. Parity with node:crypto is tested.
 */
export function sha1Hex(input: string): string {
  const msg = new TextEncoder().encode(input)
  const ml = msg.length
  const withOne = ml + 1
  const total = Math.ceil((withOne + 8) / 64) * 64
  const bytes = new Uint8Array(total)
  bytes.set(msg)
  bytes[ml] = 0x80
  const bitLen = ml * 8
  // 64-bit big-endian length (JS numbers are exact well past any real input)
  const dv = new DataView(bytes.buffer)
  dv.setUint32(total - 8, Math.floor(bitLen / 0x100000000))
  dv.setUint32(total - 4, bitLen >>> 0)

  let h0 = 0x67452301
  let h1 = 0xefcdab89
  let h2 = 0x98badcfe
  let h3 = 0x10325476
  let h4 = 0xc3d2e1f0
  const w = new Int32Array(80)
  const rol = (n: number, b: number) => ((n << b) | (n >>> (32 - b))) | 0

  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getInt32(off + i * 4)
    for (let i = 16; i < 80; i++) w[i] = rol(w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!, 1)
    let a = h0
    let b = h1
    let c = h2
    let d = h3
    let e = h4
    for (let i = 0; i < 80; i++) {
      let f: number
      let k: number
      if (i < 20) {
        f = (b & c) | (~b & d)
        k = 0x5a827999
      } else if (i < 40) {
        f = b ^ c ^ d
        k = 0x6ed9eba1
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d)
        k = 0x8f1bbcdc
      } else {
        f = b ^ c ^ d
        k = 0xca62c1d6
      }
      const t = (rol(a, 5) + f + e + k + w[i]!) | 0
      e = d
      d = c
      c = rol(b, 30)
      b = a
      a = t
    }
    h0 = (h0 + a) | 0
    h1 = (h1 + b) | 0
    h2 = (h2 + c) | 0
    h3 = (h3 + d) | 0
    h4 = (h4 + e) | 0
  }
  return [h0, h1, h2, h3, h4].map((h) => (h >>> 0).toString(16).padStart(8, '0')).join('')
}
