import { prepareSend } from './sender.js';
import { startReceive } from './receiver.js';
import { Link } from './link.js';
import { PROFILES } from './layout.js';
const $ = id => document.getElementById(id);
let cleanup = null, lock = null;
async function wake() { try { lock = await navigator.wakeLock?.request('screen'); } catch {} }
document.addEventListener('visibilitychange', () => { if (cleanup && document.visibilityState === 'visible') wake(); });
function reset(mode) {
  cleanup?.(); cleanup = null; lock?.release?.(); lock = null;
  $('send').hidden = mode !== 'send'; $('recv').hidden = mode !== 'recv';
  $('tsend').classList.toggle('on', mode === 'send'); $('trecv').classList.toggle('on', mode === 'recv');
  $('stage').hidden = true; $('pick').hidden = false; $('go').hidden = false; $('file').value = '';
  $('pairbox').hidden = true; $('hs').textContent = ''; $('rstat').textContent = ''; $('hs2').textContent = ''; $('bar').value = 0;
}
$('tsend').onclick = () => reset('send'); $('trecv').onclick = () => reset('recv');
$('cv').onclick = () => $('cv').requestFullscreen?.();       // bigger screen area = more camera pixels per cell

$('file').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  const hs = t => $('hs').textContent = t, pn = $('prof').value, P = PROFILES[pn], fps = +$('fps').value;
  await wake(); $('pick').hidden = true; $('stage').hidden = false; hs('Preparing…');
  const link = new Link(); let code = null;
  try { code = await link.create(); } catch {}
  let ctl;
  try { ctl = await prepareSend(f, $('cv'), fps, pn, (k, n) => $('sstat').textContent = `${P.label}: packet ${k} (${n} source) · ${ctl.np}/frame`); }
  catch (err) { hs('Cannot prepare: ' + (err.message || err)); link.close(); return; }
  $('sstat').textContent = `${P.label}: ${ctl.np} packets/frame · ${ctl.payload} B/frame · ceiling ≈ ${(ctl.payload * fps / 1000).toFixed(0)} KB/s. Tap the code for full screen.`;
  cleanup = () => { ctl.close(); link.close(); };
  let started = false;
  const begin = () => { if (started) return; started = true; ctl.start(); link.send({ type: 'start', name: f.name, size: f.size, profile: pn }); hs('Sending…'); };
  $('startnow').onclick = begin;
  if (!code) { hs('No handshake server reachable: sending open-loop (the receiver auto-detects the profile)'); return begin(); }
  link.send({ type: 'profile', profile: pn });
  $('pairbox').hidden = false; $('code').textContent = code; $('joinurl').textContent = `${location.origin}/?code=${code}`;
  hs('Waiting for receiver…');
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
  } else hs('No code: open-loop mode (sender gets no feedback). Profile will be auto-detected.');
  await wake();
  try {
    const stopRx = await startReceive($('vid'), s => {
      if (s.done) { $('rstat').textContent = `Done: ${s.name} (${s.size} bytes)`; return; }
      $('bar').value = s.needed ? Math.min(100, 100 * s.good / (s.needed + 2)) : 0;
      $('rstat').textContent = `${s.locked ? 'locked' : 'searching for corners…'} · ${s.res} · ${s.good}/${s.needed ? s.needed + 2 : '?'} packets` + (s.good ? ` · ${s.bad} CRC fails · ${PROFILES[s.profile] ? (s.rate * (PROFILES[s.profile].pkt - 20) / 1000).toFixed(1) + ' KB/s' : 'detecting profile…'}` : '') + (s.eta != null ? ` · ~${Math.ceil(s.eta)}s left` : '');
    }, link, pn);
    $('go').hidden = true; cleanup = () => { stopRx(); link?.close(); };
  } catch (e) { hs('Camera error: ' + e.message); link?.close(); }
};
const qc = new URLSearchParams(location.search).get('code');
if (qc) { reset('recv'); $('codein').value = qc; } else reset('send');
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
