const C = 'optxfer-v3', A = ['./', 'index.html', 'app.js', 'sender.js', 'receiver.js', 'rx-worker.js', 'layout.js', 'link.js',
  'manifest.webmanifest', 'pkg/optxfer_core.js', 'pkg/optxfer_core_bg.wasm'];
self.addEventListener('install', e => e.waitUntil(caches.open(C).then(c => c.addAll(A)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== C).map(x => caches.delete(x)))).then(() => clients.claim())));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.pathname.startsWith('/api/')) return;   // never intercept the handshake channel
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});
