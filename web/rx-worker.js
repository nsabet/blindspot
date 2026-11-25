import init, { Decoder } from './pkg/blindspot_core.js';
import { PROFILES, makeLayout } from './layout.js';
import { decodeFrame } from './vision.js';

const cv = new OffscreenCanvas(1, 1), cx = cv.getContext('2d', { willReadFrequently: true });
const Q = {}, ORDER = ['turbo', 'max', 'fast', 'classic', 'wide'];
const getQ = n => Q[n] || (Q[n] = (() => { const P = PROFILES[n], dec = new Decoder(P.bpc, P.rate, P.pkt); return { n, P, lay: makeLayout(P.G), dec, cpp: dec.cells_per_packet() }; })());
let auto = true, cur = 'turbo', found = null, ti = 0;     // auto: try one candidate profile per frame until a packet passes CRC
const ready = init();

onmessage = async ({ data }) => {
  await ready;
  if (data.profile) { auto = data.profile === 'auto'; if (!auto) cur = data.profile; found = null; return; }
  const bmp = data.bmp; cv.width = bmp.width; cv.height = bmp.height; cx.drawImage(bmp, 0, 0); bmp.close();
  const img = cx.getImageData(0, 0, cv.width, cv.height);
  const name = auto ? (found || ORDER[ti++ % ORDER.length]) : cur, q = getQ(name);
  const r = decodeFrame(img, q.P, q.lay);
  if (r.soft) { const NP = Math.floor(q.lay.DATA.length / q.cpp), per = q.cpp * q.P.bpc;
    for (let p = 0; p < NP && !q.dec.done(); p++) q.dec.push_packet(r.soft.subarray(p * per, (p + 1) * per));
    if (auto && !found && q.dec.good() > 0) found = name; }
  postMessage({ type: 'stat', locked: auto && !found ? !!r.f : !!r.soft, reason: r.soft ? null : r.reason, cellPx: r.cellPx || 0,
    profile: found || (auto ? null : cur), good: q.dec.good(), bad: q.dec.bad(), needed: q.dec.needed() });
  if (q.dec.done()) { const out = q.dec.file_data(); postMessage({ type: 'done', name: q.dec.file_name(), data: out }, [out.buffer]); }
};
