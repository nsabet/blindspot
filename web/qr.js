// Minimal offline QR encoder: byte mode, error-correction level M, versions 1-6 (up to 106 bytes). No dependencies.
const EC = { 1: [10, 1, 16], 2: [16, 1, 28], 3: [26, 1, 44], 4: [18, 2, 32], 5: [24, 2, 43], 6: [16, 4, 27] };   // [ec codewords per block, blocks, data codewords per block]
const ALIGN = { 2: 18, 3: 22, 4: 26, 5: 30, 6: 34 };
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; }
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const mul = (a, b) => a && b ? EXP[LOG[a] + LOG[b]] : 0;
export function rsEncode(data, n) {                         // remainder of data(x)*x^n / generator(x)
  let g = [1]; for (let i = 0; i < n; i++) { const ng = new Array(g.length + 1).fill(0); g.forEach((c, j) => { ng[j] ^= c; ng[j + 1] ^= mul(c, EXP[i]); }); g = ng; }
  const r = new Array(n).fill(0);
  for (const d of data) { const f = d ^ r.shift(); r.push(0); if (f) for (let i = 0; i < n; i++) r[i] ^= mul(g[i + 1], f); }
  return r;
}
export function qrMatrix(text) {
  const bytes = [...new TextEncoder().encode(text)];
  let v = 1; while (v <= 6 && bytes.length > EC[v][1] * EC[v][2] - 2) v++;
  if (v > 6) throw new Error('QR text too long');
  const [ecn, nb, dpb] = EC[v], total = nb * dpb, bits = [];
  const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };
  put(4, 4); put(bytes.length, 8); bytes.forEach(b => put(b, 8));
  put(0, Math.min(4, total * 8 - bits.length)); while (bits.length % 8) bits.push(0);
  const cw = []; for (let i = 0; i < bits.length; i += 8) cw.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let pad = 0xEC; cw.length < total; pad ^= 0xEC ^ 0x11) cw.push(pad);
  const blocks = [], ecs = []; for (let b = 0; b < nb; b++) { const d = cw.slice(b * dpb, (b + 1) * dpb); blocks.push(d); ecs.push(rsEncode(d, ecn)); }
  const out = []; for (let i = 0; i < dpb; i++) blocks.forEach(b => out.push(b[i])); for (let i = 0; i < ecn; i++) ecs.forEach(e => out.push(e[i]));
  const size = 17 + 4 * v, mod = Array.from({ length: size }, () => new Array(size).fill(false)), fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, d) => { mod[y][x] = d; fn[y][x] = true; };
  const finder = (cx, cy) => { for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const x = cx + dx, y = cy + dy; if (x < 0 || y < 0 || x >= size || y >= size) continue; const d = Math.max(Math.abs(dx), Math.abs(dy)); set(x, y, d !== 2 && d !== 4); } };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  for (let i = 0; i < size; i++) { if (!fn[6][i]) set(i, 6, i % 2 === 0); if (!fn[i][6]) set(6, i, i % 2 === 0); }
  if (v >= 2) { const c = ALIGN[v]; for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(c + dx, c + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1); }
  for (let i = 0; i < 9; i++) { fn[8][i] = fn[i][8] = true; } for (let i = 0; i < 8; i++) { fn[8][size - 1 - i] = fn[size - 1 - i][8] = true; }
  set(8, size - 8, true);                                   // always-dark module
  let i = 0, nbits = out.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) { if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) { const x = right - j, y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
      if (!fn[y][x] && i < nbits) { mod[y][x] = ((out[i >> 3] >> (7 - (i & 7))) & 1) === 1; i++; } } }
  const MASK = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x, y) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
    (x, y) => (((x / 3) | 0) + ((y / 2) | 0)) % 2 === 0, (x, y) => x * y % 2 + x * y % 3 === 0, (x, y) => (x * y % 2 + x * y % 3) % 2 === 0, (x, y) => ((x + y) % 2 + x * y % 3) % 2 === 0];
  const apply = m => mod.map((row, y) => row.map((b, x) => fn[y][x] ? b : b !== MASK[m](x, y)));
  const penalty = M => { let p = 0, dark = 0;
    for (let y = 0; y < size; y++) for (let dir = 0; dir < 2; dir++) { let run = 1; for (let x = 1; x < size; x++) { const a = dir ? M[x][y] : M[y][x], b = dir ? M[x - 1][y] : M[y][x - 1]; if (a === b) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else run = 1; } }
    for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) if (M[y][x] === M[y][x + 1] && M[y][x] === M[y + 1][x] && M[y][x] === M[y + 1][x + 1]) p += 3;
    M.forEach(r => r.forEach(b => { if (b) dark++; })); return p + 10 * Math.floor(Math.abs(dark * 100 / (size * size) - 50) / 5); };
  let best = 0, bp = Infinity, bm = null; for (let m = 0; m < 8; m++) { const M = apply(m), p = penalty(M); if (p < bp) { bp = p; best = m; bm = M; } }
  const data = best;                                        // EC level M = 00, so format data = mask
  let rem = data; for (let k = 0; k < 10; k++) rem = (rem << 1) ^ ((rem >> 9) * 0x537);
  const fmt = ((data << 10) | rem) ^ 0x5412, bit = k => ((fmt >> k) & 1) === 1, S = (x, y, d) => { bm[y][x] = d; };
  for (let k = 0; k <= 5; k++) S(8, k, bit(k)); S(8, 7, bit(6)); S(8, 8, bit(7)); S(7, 8, bit(8)); for (let k = 9; k < 15; k++) S(14 - k, 8, bit(k));
  for (let k = 0; k < 8; k++) S(size - 1 - k, 8, bit(k)); for (let k = 8; k < 15; k++) S(8, size - 15 + k, bit(k)); S(8, size - 8, true);
  return bm;
}
export function drawQR(canvas, text, scale = 6, quiet = 4) {
  const M = qrMatrix(text), n = M.length, px = (n + 2 * quiet) * scale; canvas.width = canvas.height = px;
  const c = canvas.getContext('2d'); c.fillStyle = '#fff'; c.fillRect(0, 0, px, px); c.fillStyle = '#000';
  M.forEach((row, y) => row.forEach((b, x) => { if (b) c.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale); }));
}
