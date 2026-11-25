// Frame geometry + modulation profiles, shared by sender and receiver (must match exactly).
export const PROFILES = {
  classic: { G: 64,  bpc: 3, rate: 0, pkt: 512,  label: 'Classic (8 colours, baseline)' },
  fast:    { G: 112, bpc: 6, rate: 0, pkt: 1024, label: 'Fast (64 colours, rate 1/2)' },
  turbo:   { G: 128, bpc: 6, rate: 1, pkt: 1024, label: 'Turbo (64 colours, rate 2/3)' },
  max:     { G: 160, bpc: 6, rate: 2, pkt: 1024, label: 'Max (64 colours, rate 3/4)' },
};
export const LEVELS = [0, 85, 170, 255];
const g2l = g => g ^ (g >> 1);                                  // 2-bit Gray -> level 0..3
export const cellRGB = (v, bpc) => bpc === 3 ? [(v >> 2 & 1) * 255, (v >> 1 & 1) * 255, (v & 1) * 255]
  : [LEVELS[g2l(v >> 4 & 3)], LEVELS[g2l(v >> 2 & 3)], LEVELS[g2l(v & 3)]];
// Soft bits (b1,b0) of one Gray-coded channel from measured level responses m[0..3] and sample v.
export function levelSoft(m, v) {
  const t = (m[1] + m[2]) / 2, s = (m[3] - m[0]) / 3, cl = x => x > 1 ? 1 : x < -1 ? -1 : x;
  return [cl((v - t) / s), cl((s - Math.abs(v - t)) / s)];
}
export function makeLayout(G) {
  const M = 2, FB = 7, PW = G >= 96 ? 5 : 3, NPATCH = 12, CAL_Y = G - M - 1, CAL_X = M + FB + 1;
  const fidOrigin = i => [[M, M], [G - M - FB, M], [M, G - M - FB], [G - M - FB, G - M - FB]][i];
  const fidCenter = i => { const [x, y] = fidOrigin(i); return [x + FB / 2, y + FB / 2]; };
  const inBlock = (x, y) => [0, 1, 2, 3].some(i => { const [a, b] = fidOrigin(i); return x >= a && x < a + FB && y >= b && y < b + FB; });
  const reserved = (x, y) => x < M || y < M || x >= G - M || y >= G - M || inBlock(x, y) || (y === CAL_Y && x >= CAL_X && x < CAL_X + NPATCH * PW);
  const DATA = []; for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) if (!reserved(x, y)) DATA.push([x, y]);
  // calibration patches: 0..7 = RGB cube corners, 8..11 = grey ramp 0/85/170/255 (measures camera response per channel)
  const patchRGB = i => i < 8 ? cellRGB(i, 3) : [LEVELS[i - 8], LEVELS[i - 8], LEVELS[i - 8]];
  return { G, M, FB, PW, NPATCH, CAL_X, CAL_Y, fidOrigin, fidCenter, DATA, patchRGB };
}
