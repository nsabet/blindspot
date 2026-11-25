// Frame geometry + modulation profiles, shared by sender and receiver (must match exactly).
// minPx = minimum camera pixels per cell the profile needs (receiver warns below this).
export const PROFILES = {
  classic: { G: 64,  bpc: 3, rate: 0, pkt: 512,  minPx: 5, label: 'Classic (8 colours)' },
  wide:    { G: 100, bpc: 3, rate: 0, pkt: 512,  minPx: 5, label: 'Wide (8 colours, big grid)' },
  fast:    { G: 112, bpc: 6, rate: 0, pkt: 1024, minPx: 6, label: 'Fast (64 colours, rate 1/2)' },
  turbo:   { G: 128, bpc: 6, rate: 1, pkt: 1024, minPx: 6, label: 'Turbo (64 colours, rate 2/3)' },
  max:     { G: 160, bpc: 6, rate: 2, pkt: 1024, minPx: 7, label: 'Max (64 colours, rate 3/4)' },
};
export const LEVELS = [0, 85, 170, 255];
const g2l = g => g ^ (g >> 1);                                  // 2-bit Gray -> level 0..3
export const cellRGB = (v, bpc) => bpc === 3 ? [(v >> 2 & 1) * 255, (v >> 1 & 1) * 255, (v & 1) * 255]
  : [LEVELS[g2l(v >> 4 & 3)], LEVELS[g2l(v >> 2 & 3)], LEVELS[g2l(v & 3)]];
// Soft bits (b1,b0) of one Gray-coded channel from the camera's measured response m[0..3] to the 4 levels.
export function levelSoft(m, v) {
  const t1 = (m[0] + m[1]) / 2, t2 = (m[1] + m[2]) / 2, t3 = (m[2] + m[3]) / 2, tc = (t1 + t3) / 2, hw = (t3 - t1) / 2;
  const s = (m[3] - m[0]) / 3, cl = x => x > 1 ? 1 : x < -1 ? -1 : x;
  return [cl((v - t2) / s), cl((hw - Math.abs(v - tc)) / s)];
}
export function makeLayout(G) {
  const big = G >= 96, M = 2, FB = big ? 11 : 7, RING = big ? 2 : 1, PW = G >= 128 ? 6 : big ? 5 : 3, NPATCH = 12, CAL_H = 3;
  const CAL_Y = G - M - CAL_H, CAL_X = M + FB + 1;
  const fidOrigin = i => [[M, M], [G - M - FB, M], [M, G - M - FB], [G - M - FB, G - M - FB]][i];
  const fidCenter = i => { const [x, y] = fidOrigin(i); return [x + FB / 2, y + FB / 2]; };
  const inBlock = (x, y) => [0, 1, 2, 3].some(i => { const [a, b] = fidOrigin(i); return x >= a && x < a + FB && y >= b && y < b + FB; });
  const reserved = (x, y) => x < M || y < M || x >= G - M || y >= G - M || inBlock(x, y) ||
    (y >= CAL_Y && y < CAL_Y + CAL_H && x >= CAL_X && x < CAL_X + NPATCH * PW);
  const DATA = []; for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) if (!reserved(x, y)) DATA.push([x, y]);
  // calibration patches (3 cells tall): 0..7 = RGB cube corners, 8..11 = grey ramp 0/85/170/255
  const patchRGB = i => i < 8 ? cellRGB(i, 3) : [LEVELS[i - 8], LEVELS[i - 8], LEVELS[i - 8]];
  const patchPoints = i => { const cx = CAL_X + i * PW + PW / 2, p = []; for (const dx of [-.25, 0, .25]) for (const dy of [-.5, 0, .5]) p.push([cx + dx * PW, CAL_Y + CAL_H / 2 + dy]); return p; };
  return { G, M, FB, RING, PW, NPATCH, CAL_H, CAL_X, CAL_Y, fidOrigin, fidCenter, DATA, patchRGB, patchPoints };
}
