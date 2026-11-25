import init, { Encoder } from './pkg/blindspot_core.js';
import { PROFILES, makeLayout, cellRGB } from './layout.js';

// Shows an ALIGNMENT frame until start(); then streams frames, each carrying several independent packets (spatial bands).
export async function prepareSend(file, canvas, fps, profName, onFrame) {
  await init();
  const P = PROFILES[profName], L = makeLayout(P.G), G = P.G;
  const enc = new Encoder(new Uint8Array(await file.arrayBuffer()), file.name, P.bpc, P.rate, P.pkt);
  const cpp = enc.cells_per_packet(), NP = Math.floor(L.DATA.length / cpp);
  if (NP < 1) throw new Error('grid too small for this profile');
  const small = document.createElement('canvas'); small.width = small.height = G;
  const sctx = small.getContext('2d'), img = sctx.createImageData(G, G), base = new Uint8ClampedArray(G * G * 4);
  const put = (buf, x, y, c) => { const p = (y * G + x) * 4; buf[p] = c[0]; buf[p + 1] = c[1]; buf[p + 2] = c[2]; buf[p + 3] = 255; };
  for (let i = 0; i < G * G; i++) put(base, i % G, (i / G) | 0, [0, 0, 0]);
  for (let i = 0; i < 4; i++) { const [a, b] = L.fidOrigin(i);
    for (let y = L.RING; y < L.FB - L.RING; y++) for (let x = L.RING; x < L.FB - L.RING; x++) put(base, a + x, b + y, [255, 255, 255]); }
  for (let i = 0; i < L.NPATCH; i++) for (let k = 0; k < L.PW; k++) for (let r = 0; r < L.CAL_H; r++) put(base, L.CAL_X + i * L.PW + k, L.CAL_Y + r, L.patchRGB(i));
  const ctx = canvas.getContext('2d'); let size = 0, mode = 'align', last = 0, alive = true, lcg = 12345;
  const fit = () => { size = Math.floor(Math.min(innerWidth, document.fullscreenElement ? innerHeight : innerHeight * 0.8) / G) * G;
    canvas.width = canvas.height = size; ctx.imageSmoothingEnabled = false; draw(true); };
  const draw = keep => {
    if (!keep || mode === 'send') { img.data.set(base);
      if (mode === 'send') {
        for (let p = 0; p < NP; p++) { const v = enc.next_packet(); for (let i = 0; i < cpp; i++) { const [x, y] = L.DATA[p * cpp + i]; put(img.data, x, y, cellRGB(v[i], P.bpc)); } }
        for (let i = NP * cpp; i < L.DATA.length; i++) { lcg = (lcg * 1103515245 + 12345) & 0x7fffffff; const [x, y] = L.DATA[i]; put(img.data, x, y, cellRGB((lcg >> 16) & ((1 << P.bpc) - 1), P.bpc)); }
      } }
    sctx.putImageData(img, 0, 0); ctx.drawImage(small, 0, 0, size, size);
  };
  const tick = t => { if (!alive) return; requestAnimationFrame(tick);
    if (mode === 'send' && t - last >= 1000 / fps - 2) { last = t; draw(); onFrame?.(enc.packet_index(), enc.source_packets()); } };
  addEventListener('resize', fit); document.addEventListener('fullscreenchange', fit); fit(); requestAnimationFrame(tick);
  return { np: NP, payload: NP * enc.sym_bytes(), sources: enc.source_packets(),
    start() { mode = 'send'; }, stop() { mode = 'align'; draw(); },
    close() { alive = false; removeEventListener('resize', fit); document.removeEventListener('fullscreenchange', fit); } };
}
