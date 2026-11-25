// Camera capture + frame pump to the worker. Returns a controller: { stop, reopen, devices, caps, settings, zoom }.
// link (optional): reports ready / aligned / progress / done to the sender.
export async function startReceive(video, onStat, link, profile = 'turbo') {
  const hi = profile !== 'classic';
  let stream, track, run = true, busy = false, hist = [], ready = false, streak = 0, miss = 0, aligned = false, lastProg = 0;
  const open = async (c = {}) => {                       // (re)open the camera: lens (deviceId) and resolution are user-selectable
    stream?.getTracks().forEach(t => t.stop());
    const v = { width: { ideal: c.w || (hi ? 1920 : 1280) }, height: { ideal: c.h || (hi ? 1080 : 720) }, frameRate: { ideal: c.fps || (hi ? 30 : 60) } };
    if (c.deviceId) v.deviceId = { exact: c.deviceId }; else v.facingMode = 'environment';
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: v });
    track = stream.getVideoTracks()[0]; video.srcObject = stream; await video.play();
    try { await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch {}
  };
  await open();
  const worker = new Worker(new URL('./rx-worker.js', import.meta.url), { type: 'module' });
  worker.postMessage({ profile });
  const pump = async () => {
    if (!run) return;
    if (!busy && video.videoWidth) { busy = true; worker.postMessage({ bmp: await createImageBitmap(video) }); }
    video.requestVideoFrameCallback ? video.requestVideoFrameCallback(pump) : setTimeout(pump, 16);
  };
  const stop = () => { run = false; stream?.getTracks().forEach(t => t.stop()); worker.terminate(); };
  worker.onmessage = async ({ data: m }) => {
    if (m.type === 'stat') {
      busy = false; const now = performance.now(); hist.push([now, m.good]); hist = hist.filter(h => now - h[0] < 8000);
      const rate = hist.length > 1 ? (m.good - hist[0][1]) / ((now - hist[0][0]) / 1000) : 0;
      const left = m.needed ? Math.max(0, m.needed + 2 - m.good) : null;
      onStat({ ...m, rate, eta: left !== null && rate > 0 ? left / rate : null, res: video.videoWidth + 'x' + video.videoHeight });
      if (link) {
        if (!ready) { ready = true; link.send({ type: 'ready' }); }
        if (m.locked) { miss = 0; if (++streak >= 8 && !aligned) { aligned = true; link.send({ type: 'align', ok: true }); } }
        else { streak = 0; if (++miss >= 15 && aligned) { aligned = false; link.send({ type: 'align', ok: false }); } }
        if (m.good > 0 && now - lastProg > 500) { lastProg = now; link.send({ type: 'progress', good: m.good, needed: m.needed, rate }); }
      }
    } else if (m.type === 'done') {
      run = false;
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([m.data])); a.download = m.name || 'received.bin';
      a.click(); onStat({ done: true, name: m.name, size: m.data.length });
      await link?.send({ type: 'done', name: m.name, size: m.data.length });
      stop(); setTimeout(() => link?.close(), 1500);
    }
  };
  pump();
  return { stop, reopen: async c => { await open(c); }, caps: () => track?.getCapabilities?.() || {}, settings: () => track?.getSettings?.() || {},
    devices: async () => (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput'),
    zoom: z => track.applyConstraints({ advanced: [{ zoom: z }] }) };
}
