// Makes the page cross-origin isolated where its host can't send the headers for that (GitHub
// Pages, an editor's live preview): the reader's own server sends them, and with them the voices
// may use several processor cores rather than one. This worker adds the headers to the pages and
// scripts of this site as they arrive. Other sites' files are passed by untouched: the page
// fetches them with CORS, which isolation allows.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (new URL(req.url).origin !== self.location.origin || (req.cache === 'only-if-cached' && req.mode !== 'same-origin')) return;
  e.respondWith(fetch(req).then((res) => {
    if (res.status === 0 || res.type === 'opaqueredirect') return res;
    const headers = new Headers(res.headers);
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
    headers.set('Cross-Origin-Resource-Policy', 'same-origin');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }));
});
