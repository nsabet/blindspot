const C = 'blindspot-__BUILD__', A = ['./', 'index.html', 'app.js', 'sender.js', 'receiver.js', 'rx-worker.js', 'layout.js', 'vision.js', 'qr.js', 'link.js',
  'manifest.webmanifest', 'pkg/blindspot_core.js', 'pkg/blindspot_core_bg.wasm'];
self.addEventListener('install', e => e.waitUntil(caches.open(C).then(c => c.addAll(A)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== C).map(x => caches.delete(x)))).then(() => clients.claim())));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.pathname.startsWith('/api/')) return;   // never intercept the handshake channel
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});
