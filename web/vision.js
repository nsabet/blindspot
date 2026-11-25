// Camera-frame -> soft bits. Pure JS (no Wasm), shared by the receiver worker and the offline simulator.
import { levelSoft } from './layout.js';

// Fiducials on a half-resolution copy: bright, squarish blobs -> TL,TR,BL,BR. `bright` = fraction of the max brightness.
export function findFids(d, W, H, bright = 0.7) {
  const w = W >> 1, h = H >> 1, n = w * h, m = new Uint8Array(n), hist = new Uint32Array(256);
  for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) { const p = ((y * 2) * W + x * 2) * 4; const v = Math.min(d[p], d[p + 1], d[p + 2]); m[i] = v; hist[v]++; }
  let top = 255; while (top > 0 && hist[top] < 8) top--;
  const thr = top * bright; for (let i = 0; i < n; i++) m[i] = m[i] > thr ? 1 : 0;
  const st = new Int32Array(n), c = [];
  for (let s = 0; s < n; s++) {
    if (m[s] !== 1) continue;
    let sp = 0, a = 0, sx = 0, sy = 0, x0 = w, x1 = 0, y0 = h, y1 = 0; st[sp++] = s; m[s] = 2;
    while (sp) {
      const i = st[--sp], x = i % w, y = (i / w) | 0; a++; sx += x; sy += y;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && m[i - 1] === 1) { m[i - 1] = 2; st[sp++] = i - 1; }
      if (x < w - 1 && m[i + 1] === 1) { m[i + 1] = 2; st[sp++] = i + 1; }
      if (y > 0 && m[i - w] === 1) { m[i - w] = 2; st[sp++] = i - w; }
      if (y < h - 1 && m[i + w] === 1) { m[i + w] = 2; st[sp++] = i + w; }
    }
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    if (bw >= 4 && bh >= 4 && bw / bh > 0.7 && bw / bh < 1.43 && a / (bw * bh) > 0.7) c.push({ a, x: sx / a * 2, y: sy / a * 2 });
  }
  if (c.length < 4) return null;
  c.sort((p, q) => q.a - p.a); const f = c.slice(0, 4);
  if (f[0].a / f[3].a > 2.5) return null;
  f.sort((p, q) => p.y - q.y);
  return [...f.slice(0, 2).sort((p, q) => p.x - q.x), ...f.slice(2).sort((p, q) => p.x - q.x)];
}
export function homog(s, d) {
  const A = [];
  for (let i = 0; i < 4; i++) { const [x, y] = s[i], [u, v] = d[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]); A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]); }
  for (let c = 0; c < 8; c++) {
    let p = c; for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < 8; r++) { if (r === c) continue; const f = A[r][c] / A[c][c]; for (let k = c; k < 9; k++) A[r][k] -= f * A[c][k]; }
  }
  return A.map((r, i) => r[8] / r[i]);
}
export const warp = (h, x, y) => { const w = h[6] * x + h[7] * y + 1; return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w]; };
function samp(d, W, H, x, y) {            // 3x3 box average
  const cx = Math.round(x), cy = Math.round(y);
  if (cx < 1 || cy < 1 || cx >= W - 1 || cy >= H - 1) return null;
  const o = [0, 0, 0];
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) { const p = ((cy + j) * W + cx + i) * 4; o[0] += d[p]; o[1] += d[p + 1]; o[2] += d[p + 2]; }
  return o.map(v => v / 9);
}

// Least-squares fit obs = off + M*t (t in 0..1 per channel) from the 8 RGB-cube corner patches, then invert M.
// Undoes the camera's colour crosstalk, which otherwise eats most of the margin between the 4 brightness levels.
function colourFix(pc) {
  const A = [], O = [];
  for (let i = 0; i < 8; i++) { const c = pc(i); if (!c) return null; A.push([1, i >> 2 & 1, i >> 1 & 1, i & 1]); O.push(c); }
  const M = [], off = [];
  for (let ch = 0; ch < 3; ch++) {                                    // normal equations (A^T A) th = A^T o
    const N = [0, 1, 2, 3].map(r => [0, 1, 2, 3].map(c2 => A.reduce((a, row) => a + row[r] * row[c2], 0)).concat(A.reduce((a, row, k) => a + row[r] * O[k][ch], 0)));
    for (let c = 0; c < 4; c++) { let p = c; for (let r = c + 1; r < 4; r++) if (Math.abs(N[r][c]) > Math.abs(N[p][c])) p = r; [N[c], N[p]] = [N[p], N[c]];
      for (let r = 0; r < 4; r++) { if (r === c) continue; const f = N[r][c] / N[c][c]; for (let k = c; k < 5; k++) N[r][k] -= f * N[c][k]; } }
    const th = N.map((r, i) => r[4] / r[i]); off.push(th[0]); M.push(th.slice(1));
  }
  const [[a, b, c], [d, e, f], [g, h, i]] = M, det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e3) return null;
  const I = [[e * i - f * h, c * h - b * i, b * f - c * e], [f * g - d * i, a * i - c * g, c * d - a * f], [d * h - e * g, b * g - a * h, a * e - b * d]].map(r => r.map(x => x / det));
  return v => { const x = [v[0] - off[0], v[1] - off[1], v[2] - off[2]]; return I.map(r => 255 * (r[0] * x[0] + r[1] * x[1] + r[2] * x[2])); };
}
/** -> { f, cellPx, reason } on failure, or { f, cellPx, soft } (bpc soft values per data cell, in layout order). */
export function decodeFrame(img, P, L) {
  const { data: d, width: W, height: H } = img, f = findFids(d, W, H);
  if (!f) return { reason: 'corners not found' };
  const cellPx = Math.hypot(f[1].x - f[0].x, f[1].y - f[0].y) / (L.G - 2 * L.M - L.FB);
  const h = homog([0, 1, 2, 3].map(L.fidCenter), f.map(p => [p.x, p.y]));
  const px = (u, v) => { const [x, y] = warp(h, u, v); return samp(d, W, H, x, y); };
  const pc = i => { const a = [0, 0, 0]; let n = 0; for (const [u, v] of L.patchPoints(i)) { const c = px(u, v); if (!c) return null; for (let k = 0; k < 3; k++) a[k] += c[k]; n++; } return a.map(x => x / n); };
  const B = P.bpc, DATA = L.DATA, soft = new Float32Array(DATA.length * B);
  if (B === 3) {
    const lo = [0, 0, 0], hi = [0, 0, 0];
    for (let i = 0; i < 8; i++) { const c = pc(i); if (!c) return { f, cellPx, reason: 'calibration strip off-screen' }; for (let ch = 0; ch < 3; ch++) ((i >> (2 - ch)) & 1 ? hi : lo)[ch] += c[ch] / 4; }
    const mid = lo.map((l, i) => (l + hi[i]) / 2), half = lo.map((l, i) => (hi[i] - l) / 2);
    if (half.some(v => v < 15)) return { f, cellPx, reason: 'calibration contrast too low' };
    for (let i = 0; i < DATA.length; i++) { const c = px(DATA[i][0] + 0.5, DATA[i][1] + 0.5); if (!c) continue;
      for (let ch = 0; ch < 3; ch++) soft[i * 3 + ch] = Math.max(-1, Math.min(1, (c[ch] - mid[ch]) / half[ch])); }
  } else {
    const fix = colourFix(pc) || (v => v), m = [[], [], []];
    for (let l = 0; l < 4; l++) { const c = pc(8 + l); if (!c) return { f, cellPx, reason: 'calibration strip off-screen' }; const e = fix(c); for (let ch = 0; ch < 3; ch++) m[ch][l] = e[ch]; }
    for (let ch = 0; ch < 3; ch++) if (!(m[ch][1] > m[ch][0] && m[ch][2] > m[ch][1] && m[ch][3] > m[ch][2] && m[ch][3] - m[ch][0] > 100))
      return { f, cellPx, reason: 'calibration ramp unreadable (blur/exposure)' };
    // Sample every cell, map to "level coordinates" (0..3) with the measured ramp, then undo inter-cell blur with a
    // blind 2D equaliser: o = (1-4a)x + a*sum(neighbours)  ->  x ~ (o - a*sum(x_nbr_est))/(1-4a); pick a that makes cells sit closest to levels.
    const G = L.G, N = G * G, X = [0, 1, 2].map(() => new Float32Array(N).fill(1.5));
    const lvl = (mm, v) => v <= mm[1] ? (v - mm[0]) / (mm[1] - mm[0]) : v <= mm[2] ? 1 + (v - mm[1]) / (mm[2] - mm[1]) : 2 + (v - mm[2]) / (mm[3] - mm[2]);
    for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) { const c = px(x + 0.5, y + 0.5); if (!c) continue; const e = fix(c); for (let ch = 0; ch < 3; ch++) X[ch][y * G + x] = lvl(m[ch], e[ch]); }
    const nb = (A, i, x, y) => (x > 0 ? A[i - 1] : A[i]) + (x < G - 1 ? A[i + 1] : A[i]) + (y > 0 ? A[i - G] : A[i]) + (y < G - 1 ? A[i + G] : A[i]);
    const run = (o, al) => { let x = o; for (let it = 0; it < 3 && al > 0; it++) { const n = new Float32Array(N); for (let y = 0; y < G; y++) for (let xx = 0; xx < G; xx++) { const i = y * G + xx; n[i] = (o[i] - al * nb(x, i, xx, y)) / (1 - 4 * al); } x = n; } return x; };
    const cost = x => { let c = 0; for (let k = 0; k < DATA.length; k += 3) { const v = x[DATA[k][1] * G + DATA[k][0]]; c += Math.abs(v - Math.min(3, Math.max(0, Math.round(v)))); } return c; };
    const EQ = [[], [], []];
    for (let ch = 0; ch < 3; ch++) { let best = X[ch], bc = cost(best); for (const al of [0.03, 0.06, 0.09, 0.12, 0.15]) { const x = run(X[ch], al), c = cost(x); if (c < bc) { bc = c; best = x; } } EQ[ch] = best; }
    for (let i = 0; i < DATA.length; i++) { const k = DATA[i][1] * G + DATA[i][0];
      for (let ch = 0; ch < 3; ch++) { const v = EQ[ch][k]; soft[i * 6 + ch * 2] = Math.max(-1, Math.min(1, v - 1.5)); soft[i * 6 + ch * 2 + 1] = Math.max(-1, Math.min(1, 1 - Math.abs(v - 1.5))); } }
  }
  return { f, cellPx, soft };
}
