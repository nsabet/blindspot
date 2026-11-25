import { prepareSend } from './sender.js';
import { startReceive } from './receiver.js';
import { Link } from './link.js';
import { PROFILES } from './layout.js';
import { drawQR } from './qr.js';
const $ = id => document.getElementById(id);
let cleanup = null, lock = null;
async function wake() { try { lock = await navigator.wakeLock?.request('screen'); } catch {} }
document.addEventListener('visibilitychange', () => { if (cleanup && document.visibilityState === 'visible') wake(); });
function reset(mode) {
  cleanup?.(); cleanup = null; lock?.release?.(); lock = null;
  $('send').hidden = mode !== 'send'; $('recv').hidden = mode !== 'recv';
  $('tsend').classList.toggle('on', mode === 'send'); $('trecv').classList.toggle('on', mode === 'recv');
  $('stage').hidden = true; $('pick').hidden = false; $('go').hidden = false; $('file').value = ''; $('camctl').hidden = true;
  $('pairbox').hidden = true; $('codeline').hidden = false; $('autorow').hidden = false; $('qrbox').hidden = false; $('hs').textContent = ''; $('rstat').textContent = ''; $('hs2').textContent = ''; $('bar').value = 0;
}
$('tsend').onclick = () => reset('send'); $('trecv').onclick = () => reset('recv');
$('cv').onclick = () => $('cv').requestFullscreen?.();       // bigger screen area = more camera pixels per cell
const baseUrl = () => location.origin + location.pathname.replace(/[^/]*$/, '');

$('file').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  const hs = t => $('hs').textContent = t, pn = $('prof').value, P = PROFILES[pn], fps = +$('fps').value;
  await wake(); $('pick').hidden = true; $('stage').hidden = false; hs('Preparing…');
  const link = new Link(); let code = null;
  try { code = await link.create(); } catch {}
  let ctl;
  try { ctl = await prepareSend(f, $('cv'), fps, pn, (k, n) => $('sstat').textContent = `${P.label}: packet ${k} (${n} source) · ${ctl.np}/frame`); }
  catch (err) { hs('Cannot prepare: ' + (err.message || err)); link.close(); return; }
  $('sstat').textContent = `${P.label}: ${ctl.np} packets/frame · ${ctl.payload} B/frame · ceiling ≈ ${(ctl.payload * fps / 1000).toFixed(0)} KB/s. Tap the code to go full screen.`;
  cleanup = () => { ctl.close(); link.close(); };
  let started = false;
  const begin = () => { if (started) return; started = true; $('qrbox').hidden = true; ctl.start(); link.send({ type: 'start', name: f.name, size: f.size, profile: pn }); hs('Sending…'); };
  $('startnow').onclick = begin;
  const url = `${baseUrl()}?r=1&p=${pn}${code ? '&code=' + code : ''}`;   // opens the receiver with the right profile (and pairing code)
  try { drawQR($('qr'), url); } catch {}
  $('joinurl').textContent = url; $('qrbox').hidden = false; $('pairbox').hidden = false;
  if (!code) {                                                   // no handshake server (e.g. GitHub Pages): manual start
    $('codeline').hidden = true; $('autorow').hidden = true;
    return hs('Scan the QR code with your phone, choose zoom/lens, aim at the four corner squares, then press Start now.');
  }
  link.send({ type: 'profile', profile: pn });
  $('code').textContent = code; hs('Waiting for receiver…');
  link.onmsg = m => {
    if (m.type === 'joined') hs('Receiver connected. Start its camera.');
    else if (m.type === 'ready') hs('Receiver camera ready. Aim it at the four corner squares.');
    else if (m.type === 'align') { if (m.ok) { if (!started) hs('Receiver aligned.'); if ($('auto').checked) begin(); } else if (!started) hs('Receiver lost alignment.'); }
    else if (m.type === 'progress' && started) hs(`Sending… receiver has ${m.good}/${m.needed + 2} packets (${(m.rate * (P.pkt - 20) / 1000).toFixed(1)} KB/s)`);
    else if (m.type === 'done') { hs(`✔ Receiver confirmed transfer complete: ${m.name} (${m.size} bytes)`); ctl.stop(); }
  };
};

$('go').onclick = async () => {
  const code = $('codein').value.trim(), hs = t => $('hs2').textContent = t; let link = null, pn = $('rprof').value;
  if (code) {
    link = new Link();
    const gotProfile = new Promise(res => { const t = setTimeout(res, 2500);
      link.onmsg = m => { if (m.profile && PROFILES[m.profile]) { pn = m.profile; clearTimeout(t); res(); } if (m.type === 'start') hs('Sender started transmitting.'); }; });
    try { await link.join(code); } catch { hs('Cannot join: wrong code or server unreachable.'); return; }
    await gotProfile; link.send({ type: 'joined' }); hs(`Joined sender (${PROFILES[pn]?.label || 'auto-detect'}). Starting camera…`);
  } else hs(pn === 'auto' ? 'Not paired: profile will be auto-detected.' : `Not paired: using ${PROFILES[pn].label}.`);
  await wake();
  try {
    const ctl = await startReceive($('vid'), s => {
      if (s.done) { $('rstat').textContent = `Done: ${s.name} (${s.size} bytes)`; return; }
      const P = PROFILES[s.profile];
      $('bar').value = s.needed ? Math.min(100, 100 * s.good / (s.needed + 2)) : 0;
      $('hint').textContent = !P ? 'Fit all four white corner squares in view (detecting profile…)' :
        s.cellPx ? `Cell size ≈ ${s.cellPx.toFixed(1)} px` + (s.cellPx < P.minPx ? ` — too small for ${s.profile} (need ≥ ${P.minPx}). Zoom in, move closer, or pick a smaller-grid profile.` : ' ✓') : 'Fit all four white corner squares in view.';
      $('rstat').textContent = `${s.locked ? 'locked' : (s.reason || 'searching for corners…')} · ${s.res} · ${s.good}/${s.needed ? s.needed + 2 : '?'} packets` +
        (s.good ? ` · ${s.bad} CRC fails · ${P ? (s.rate * (P.pkt - 20) / 1000).toFixed(1) + ' KB/s' : ''}` : '') + (s.eta != null ? ` · ~${Math.ceil(s.eta)}s left` : '');
    }, link, pn);
    $('go').hidden = true; cleanup = () => { ctl.stop(); link?.close(); };
    // camera controls: lens, resolution, zoom (zoom needs Chrome/Android; iOS Safari has no zoom constraint)
    $('camctl').hidden = false; if (pn === 'classic') $('res').value = '1280x720';
    const zoomUI = () => { const c = ctl.caps(); $('zoomrow').hidden = !c.zoom; if (c.zoom) { const z = $('zoom'); z.min = c.zoom.min; z.max = c.zoom.max; z.step = c.zoom.step || 0.1; z.value = ctl.settings().zoom || c.zoom.min; $('zv').textContent = (+z.value).toFixed(1) + '×'; } };
    const lenses = async () => { const ds = await ctl.devices(); $('lens').innerHTML = ds.map((d, i) => `<option value="${d.deviceId}">${d.label || 'Camera ' + (i + 1)}</option>`).join(''); const id = ctl.settings().deviceId; if (id) $('lens').value = id; };
    const apply = async () => { try { const [w, h] = $('res').value.split('x').map(Number); await ctl.reopen({ deviceId: $('lens').value, w, h }); zoomUI(); } catch (e) { hs('Camera error: ' + e.message); } };
    $('lens').onchange = apply; $('res').onchange = apply;
    $('zoom').oninput = e => { $('zv').textContent = (+e.target.value).toFixed(1) + '×'; ctl.zoom(+e.target.value).catch(() => {}); };
    await lenses(); zoomUI();
  } catch (e) { hs('Camera error: ' + e.message); link?.close(); }
};
const qp = new URLSearchParams(location.search);       // QR-code deep link: ?r=1&p=<profile>&code=<pairing code>
if (qp.get('r') || qp.get('code')) { reset('recv'); if (PROFILES[qp.get('p')]) $('rprof').value = qp.get('p'); if (qp.get('code')) $('codein').value = qp.get('code'); } else reset('send');
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
