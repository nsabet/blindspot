// Offline channel simulator: renders a sender frame, pushes it through a synthetic phone camera
// (perspective, blur, noise, gamma/gain/offset, colour crosstalk, 4:2:0 chroma subsampling),
// then runs the real receiver vision code + a JS port of the FEC. Usage: node tests/sim.mjs [profile ...]
import { PROFILES, makeLayout, cellRGB } from '../web/layout.js';
import { decodeFrame, homog } from '../web/vision.js';

let seed = 7; const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
// ---- FEC port (mirrors core/src/dsp.rs)
const G0 = 0o133, G1 = 0o171, par = x => { x ^= x >> 4; x ^= x >> 2; x ^= x >> 1; return x & 1; };
const PAT = [[1], [1, 1, 0, 1], [1, 1, 0, 1, 1, 0]];
function enc(bits) { let s = 0; const o = []; for (const u of [...bits, 0, 0, 0, 0, 0, 0]) { const r = (u << 6) | s; o.push(par(r & G0), par(r & G1)); s = r >> 1; } return o; }
const punc = (c, r) => c.filter((_, i) => PAT[r][i % PAT[r].length]);
function depunc(s, r, n) { const o = new Float32Array(n); let j = 0; for (let i = 0; i < n; i++) if (PAT[r][i % PAT[r].length]) o[i] = s[j++]; return o; }
function order(len) { const R = 32, c = Math.ceil(len / R), o = []; for (let col = 0; col < c; col++) for (let row = 0; row < R; row++) { const i = row * c + col; if (i < len) o.push(i); } return o; }
function viterbi(soft) {
  const n = soft.length >> 1; let pm = new Float64Array(64).fill(-1e30); pm[0] = 0; const dec = new Uint8Array(n * 64);
  for (let t = 0; t < n; t++) { const a = soft[2 * t], b = soft[2 * t + 1], np = new Float64Array(64).fill(-1e30);
    for (let s = 0; s < 64; s++) { if (pm[s] < -1e29) continue;
      for (let u = 0; u < 2; u++) { const r = (u << 6) | s, ns = r >> 1, m = pm[s] + (par(r & G0) ? a : -a) + (par(r & G1) ? b : -b);
        if (m > np[ns]) { np[ns] = m; dec[t * 64 + ns] = s & 1; } } }
    pm = np; }
  const bits = new Uint8Array(n); let ns = 0;
  for (let t = n - 1; t >= 0; t--) { bits[t] = ns >> 5; ns = ((ns << 1) & 63) | dec[t * 64 + ns]; }
  return bits.slice(0, n - 6);
}
// ---- sender frame
function makeFrame(P, L) {
  const mother = 2 * (P.pkt * 8 + 6), tx = PAT[P.rate].length === 1 ? mother : punc(new Array(mother).fill(0), P.rate).length;
  const cpp = Math.ceil(tx / P.bpc), NP = Math.floor(L.DATA.length / cpp), perm = order(tx), G = L.G;
  const rgba = new Uint8ClampedArray(G * G * 4); for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  const put = (x, y, c) => { const p = (y * G + x) * 4; rgba[p] = c[0]; rgba[p + 1] = c[1]; rgba[p + 2] = c[2]; };
  for (let i = 0; i < 4; i++) { const [a, b] = L.fidOrigin(i); for (let y = L.RING; y < L.FB - L.RING; y++) for (let x = L.RING; x < L.FB - L.RING; x++) put(a + x, b + y, [255, 255, 255]); }
  for (let i = 0; i < L.NPATCH; i++) for (let k = 0; k < L.PW; k++) for (let r = 0; r < L.CAL_H; r++) put(L.CAL_X + i * L.PW + k, L.CAL_Y + r, L.patchRGB(i));
  const infos = [], truth = new Uint8Array(L.DATA.length * P.bpc);
  for (let p = 0; p < NP; p++) {
    const info = Array.from({ length: P.pkt * 8 }, () => rnd() < .5 ? 1 : 0); infos.push(info);
    const coded = punc(enc(info), P.rate), bits = new Array(cpp * P.bpc); for (let j = 0; j < bits.length; j++) bits[j] = j < tx ? coded[perm[j]] : (rnd() < .5 ? 1 : 0);
    for (let i = 0; i < cpp; i++) { let v = 0; for (let k = 0; k < P.bpc; k++) { const b = bits[i * P.bpc + k]; v = (v << 1) | b; truth[(p * cpp + i) * P.bpc + k] = b; }
      const [x, y] = L.DATA[p * cpp + i]; put(x, y, cellRGB(v, P.bpc)); } }
  for (let i = NP * cpp; i < L.DATA.length; i++) { const [x, y] = L.DATA[i]; put(x, y, cellRGB(Math.floor(rnd() * (1 << P.bpc)), P.bpc)); }
  return { rgba, infos, truth, NP, cpp, tx, perm };
}
// ---- phone camera model
function camera(src, G, s, c) {
  const W = 1920, H = 1080, out = new Uint8ClampedArray(W * H * 4), cx = W / 2 + (rnd() - .5) * 60, cy = H / 2, th = c.theta;
  for (let i = 0; i < out.length; i += 4) { out[i] = 28; out[i + 1] = 28; out[i + 2] = 32; out[i + 3] = 255; }
  const map = ([u, v]) => { const uu = u - G / 2, vv = v - G / 2, w = 1 + c.tilt * vv / G; return [cx + s * (uu * Math.cos(th) - vv * Math.sin(th)) / w, cy + s * (uu * Math.sin(th) + vv * Math.cos(th)) / w]; };
  const cells = [[0, 0], [G, 0], [0, G], [G, G]], pts = cells.map(map), h = homog(cells, pts);
  const [a, b, c0, d, e, f, g, hh] = h, det = a * (e - f * hh) - b * (d - f * g) + c0 * (d * hh - e * g);
  const inv = [(e - f * hh), (c0 * hh - b), (b * f - c0 * e), (f * g - d), (a - c0 * g), (c0 * d - a * f), (d * hh - e * g), (b * g - a * hh), (a * e - b * d)].map(x => x / det);
  const x0 = Math.max(0, Math.floor(Math.min(...pts.map(p => p[0]))) - 12), x1 = Math.min(W, Math.ceil(Math.max(...pts.map(p => p[0]))) + 12);
  const y0 = Math.max(0, Math.floor(Math.min(...pts.map(p => p[1]))) - 12), y1 = Math.min(H, Math.ceil(Math.max(...pts.map(p => p[1]))) + 12);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { let r = 0, gg = 0, bb = 0;
    for (let sy = 0; sy < 3; sy++) for (let sx = 0; sx < 3; sx++) { const px = x + (sx + .5) / 3, py = y + (sy + .5) / 3, w = inv[6] * px + inv[7] * py + inv[8];
      const u = (inv[0] * px + inv[1] * py + inv[2]) / w, v = (inv[3] * px + inv[4] * py + inv[5]) / w;
      if (u >= 0 && u < G && v >= 0 && v < G) { const p = ((v | 0) * G + (u | 0)) * 4; r += src[p]; gg += src[p + 1]; bb += src[p + 2]; } else { r += 28; gg += 28; bb += 32; } }
    const o = (y * W + x) * 4; out[o] = r / 9; out[o + 1] = gg / 9; out[o + 2] = bb / 9; }
  if (c.blur > 0) { const k = [], R = Math.ceil(c.blur * 3); let sum = 0; for (let i = -R; i <= R; i++) { const v = Math.exp(-i * i / (2 * c.blur * c.blur)); k.push(v); sum += v; }
    const tmp = new Float32Array(W * H * 3);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) for (let ch = 0; ch < 3; ch++) { let a2 = 0; for (let i = -R; i <= R; i++) { const xx = Math.min(W - 1, Math.max(0, x + i)); a2 += out[(y * W + xx) * 4 + ch] * k[i + R]; } tmp[(y * W + x) * 3 + ch] = a2 / sum; }
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) for (let ch = 0; ch < 3; ch++) { let a2 = 0; for (let i = -R; i <= R; i++) { const yy = Math.min(H - 1, Math.max(0, y + i)); a2 += tmp[(yy * W + x) * 3 + ch] * k[i + R]; } out[(y * W + x) * 4 + ch] = a2 / sum; } }
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const o = (y * W + x) * 4, v = [out[o], out[o + 1], out[o + 2]];
    for (let ch = 0; ch < 3; ch++) { const m = c.xtalk[ch][0] * v[0] + c.xtalk[ch][1] * v[1] + c.xtalk[ch][2] * v[2]; out[o + ch] = c.off[ch] + c.gain[ch] * 255 * Math.pow(Math.min(1, m / 255), c.gamma[ch]) + gauss() * c.noise; } }
  for (let y = y0 & ~1; y < y1; y += 2) for (let x = x0 & ~1; x < x1; x += 2) { let cb = 0, cr = 0; const px = [];   // 4:2:0 chroma
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) { const o = ((y + dy) * W + x + dx) * 4, R = out[o], G2 = out[o + 1], B = out[o + 2], Y = .299 * R + .587 * G2 + .114 * B; cb += (B - Y) * .564 / 4; cr += (R - Y) * .713 / 4; px.push([o, Y]); }
    for (const [o, Y] of px) { out[o] = Y + 1.403 * cr; out[o + 1] = Y - .344 * cb - .714 * cr; out[o + 2] = Y + 1.773 * cb; } }
  return { data: out, width: W, height: H };
}
const NOM = { theta: 3 * Math.PI / 180, tilt: .05, blur: .8, noise: 3, gamma: [1, 1.05, .95], gain: [.9, .95, .85], off: [18, 18, 22], xtalk: [[1, .06, .02], [.05, 1, .05], [.02, .07, 1]] };
export async function trial(name, s, cond = NOM) {
  const P = PROFILES[name], L = makeLayout(P.G), fr = makeFrame(P, L), img = camera(fr.rgba, P.G, s, cond), r = decodeFrame(img, P, L);
  if (!r.soft) return { lock: false, reason: r.reason, cellPx: r.cellPx };
  let err = 0, n = fr.NP * fr.cpp * P.bpc; for (let i = 0; i < n; i++) if ((r.soft[i] > 0 ? 1 : 0) !== fr.truth[i]) err++;
  let ok = 0; const mother = 2 * (P.pkt * 8 + 6);
  for (let p = 0; p < fr.NP; p++) { const sl = r.soft.subarray(p * fr.cpp * P.bpc, (p + 1) * fr.cpp * P.bpc), de = new Float32Array(fr.tx); for (let j = 0; j < fr.tx; j++) de[fr.perm[j]] = sl[j];
    const dec = viterbi(depunc(de, P.rate, mother)); if (dec.every((b, i) => b === fr.infos[p][i])) ok++; }
  return { lock: true, ber: err / n, pass: ok, np: fr.NP, cellPx: r.cellPx };
}
if (process.argv[1].endsWith('sim.mjs')) {
  const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(PROFILES);
  for (const nm of names) { const P = PROFILES[nm]; const row = [];
    for (const s of [4, 5, 6, 7, 8, 9]) { if (P.G * s > 1020) { row.push(`${s}px: --`); continue; }
      let lock = 0, pass = 0, np = 0, ber = 0, why = ''; for (let t = 0; t < 2; t++) { const r = await trial(nm, s); if (r.lock) { lock++; pass += r.pass; np += r.np; ber += r.ber; } else why = r.reason; }
      row.push(lock ? `${s}px: ${pass}/${np} ok, rawBER ${(ber / lock * 100).toFixed(1)}%` : `${s}px: NO LOCK (${why})`); }
    console.log(nm.padEnd(8), row.join(' | ')); }
}
