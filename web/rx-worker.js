import init, { Decoder } from './pkg/blindspot_core.js';
import { PROFILES, makeLayout, levelSoft } from './layout.js';

const cv = new OffscreenCanvas(1, 1), cx = cv.getContext('2d', { willReadFrequently: true });
const Q = {}, ORDER = ['turbo', 'max', 'fast', 'classic'];
const getQ = n => Q[n] || (Q[n] = (() => { const P = PROFILES[n], dec = new Decoder(P.bpc, P.rate, P.pkt); return { n, P, lay: makeLayout(P.G), dec, cpp: dec.cells_per_packet() }; })());
let auto = true, cur = 'turbo', found = null, ti = 0;     // auto: try one candidate profile per frame until a packet passes CRC
const ready = init();

// 1) fiducials on a half-resolution copy (4x cheaper): bright, low-saturation, squarish blobs -> TL,TR,BL,BR
function findFids(d, W, H) {
  const w = W >> 1, h = H >> 1, n = w * h, m = new Uint8Array(n), hist = new Uint32Array(256);
  for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) { const p = ((y * 2) * W + x * 2) * 4; const v = Math.min(d[p], d[p + 1], d[p + 2]); m[i] = v; hist[v]++; }
  let top = 255; while (top > 0 && hist[top] < 8) top--;
  const thr = top * 0.6; for (let i = 0; i < n; i++) m[i] = m[i] > thr ? 1 : 0;
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
    if (bw >= 4 && bh >= 4 && bw / bh > 0.7 && bw / bh < 1.43 && a / (bw * bh) > 0.75) c.push({ a, x: sx / a * 2, y: sy / a * 2 });
  }
  if (c.length < 4) return null;
  c.sort((p, q) => q.a - p.a); const f = c.slice(0, 4);
  if (f[0].a / f[3].a > 2.5) return null;
  f.sort((p, q) => p.y - q.y);
  return [...f.slice(0, 2).sort((p, q) => p.x - q.x), ...f.slice(2).sort((p, q) => p.x - q.x)];
}
// 2) homography grid->image from 4 correspondences (Gauss-Jordan on 8x8)
function homog(s, d) {
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
const warp = (h, x, y) => { const w = h[6] * x + h[7] * y + 1; return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w]; };
function samp(d, W, H, x, y) {            // 3x3 box average
  const cx0 = Math.round(x), cy0 = Math.round(y);
  if (cx0 < 1 || cy0 < 1 || cx0 >= W - 1 || cy0 >= H - 1) return null;
  const o = [0, 0, 0];
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) { const p = ((cy0 + j) * W + cx0 + i) * 4; o[0] += d[p]; o[1] += d[p + 1]; o[2] += d[p + 2]; }
  return o.map(v => v / 9);
}
// 3) calibrate from the strip, emit `bpc` soft bits per cell
function process(img, f, { P, lay }) {
  const { data: d, width: W, height: H } = img;
  const h = homog([0, 1, 2, 3].map(lay.fidCenter), f.map(p => [p.x, p.y]));
  const px = (u, v) => { const [x, y] = warp(h, u, v); return samp(d, W, H, x, y); };
  const pc = i => px(lay.CAL_X + i * lay.PW + lay.PW / 2, lay.CAL_Y + 0.5), B = P.bpc, DATA = lay.DATA;
  const soft = new Float32Array(DATA.length * B);
  if (B === 3) {
    const lo = [0, 0, 0], hi = [0, 0, 0];
    for (let i = 0; i < 8; i++) { const c = pc(i); if (!c) return null; for (let ch = 0; ch < 3; ch++) ((i >> (2 - ch)) & 1 ? hi : lo)[ch] += c[ch] / 4; }
    const mid = lo.map((l, i) => (l + hi[i]) / 2), half = lo.map((l, i) => (hi[i] - l) / 2);
    if (half.some(v => v < 15)) return null;
    for (let i = 0; i < DATA.length; i++) { const c = px(DATA[i][0] + 0.5, DATA[i][1] + 0.5); if (!c) continue;
      for (let ch = 0; ch < 3; ch++) soft[i * 3 + ch] = Math.max(-1, Math.min(1, (c[ch] - mid[ch]) / half[ch])); }
  } else {
    const m = [[], [], []];                                    // measured per-channel response at the 4 grey-ramp levels
    for (let l = 0; l < 4; l++) { const c = pc(8 + l); if (!c) return null; for (let ch = 0; ch < 3; ch++) m[ch][l] = c[ch]; }
    for (let ch = 0; ch < 3; ch++) if (!(m[ch][1] > m[ch][0] && m[ch][2] > m[ch][1] && m[ch][3] > m[ch][2] && m[ch][3] - m[ch][0] > 40)) return null;
    for (let i = 0; i < DATA.length; i++) { const c = px(DATA[i][0] + 0.5, DATA[i][1] + 0.5); if (!c) continue;
      for (let ch = 0; ch < 3; ch++) { const [b1, b0] = levelSoft(m[ch], c[ch]); soft[i * 6 + ch * 2] = b1; soft[i * 6 + ch * 2 + 1] = b0; } }
  }
  return soft;
}
onmessage = async ({ data }) => {
  await ready;
  if (data.profile) { auto = data.profile === 'auto'; if (!auto) cur = data.profile; found = null; return; }
  const bmp = data.bmp; cv.width = bmp.width; cv.height = bmp.height; cx.drawImage(bmp, 0, 0); bmp.close();
  const img = cx.getImageData(0, 0, cv.width, cv.height), f = findFids(img.data, cv.width, cv.height);
  const name = auto ? (found || ORDER[ti++ % ORDER.length]) : cur, q = getQ(name);
  const soft = f ? process(img, f, q) : null;
  if (soft) { const NP = Math.floor(q.lay.DATA.length / q.cpp), per = q.cpp * q.P.bpc;
    for (let p = 0; p < NP && !q.dec.done(); p++) q.dec.push_packet(soft.subarray(p * per, (p + 1) * per));
    if (auto && !found && q.dec.good() > 0) found = name; }
  postMessage({ type: 'stat', locked: auto && !found ? !!f : !!soft, profile: found || (auto ? null : cur), good: q.dec.good(), bad: q.dec.bad(), needed: q.dec.needed() });
  if (q.dec.done()) { const out = q.dec.file_data(); postMessage({ type: 'done', name: q.dec.file_name(), data: out }, [out.buffer]); }
};
