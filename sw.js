/* Don Mac POS — service worker
   Scope: /DonMac/  (registered from index.html as './sw.js')

   Bump VERSION on every deploy. That name change is what evicts the old
   cache in activate(); leaving it alone means cashiers keep the previous
   shell until the browser happens to discard it on its own. */
const VERSION = '3.2.0';
const CACHE = 'donmac-pos-' + VERSION;
const NAV_TIMEOUT = 4000;

/* The whole app is inline in index.html — no external CSS, JS, or font
   files — so the shell is just these. Add your manifest icons here too
   (e.g. './icon-192.png'); a missing entry is tolerated, see install(). */
const CORE = [
  './',
  './index.html',
  './dashboard.html',
  './manifest.json'
];

/* Requests that must never be served from cache. */
function bypass(req, url) {
  // Writes to Supabase. The app already queues these in arroyo_sync_queue
  // when offline, so a service worker has nothing useful to add.
  if (req.method !== 'GET') return true;
  // Supabase reads and remote business logos. Caching an auth token response
  // would be worse than useless.
  if (url.origin !== self.location.origin) return true;
  // The update checker reads this to decide if a new build exists. Serving a
  // cached copy would pin it to the installed version forever, so the
  // "Check for updates" button would always report "up to date".
  if (url.pathname.endsWith('/version.json')) return true;
  return false;
}

self.addEventListener('install', function (e) {
  e.waitUntil((async function () {
    const cache = await caches.open(CACHE);
    // Fetched one at a time on purpose. cache.addAll() rejects the entire
    // install if a single URL 404s, which would leave the app with no
    // offline support at all — one missing icon shouldn't cost the shell.
    await Promise.all(CORE.map(async function (u) {
      try {
        // cache:'reload' skips the HTTP cache, so installing right after a
        // push doesn't store the build you just replaced.
        const r = await fetch(new Request(u, { cache: 'reload' }));
        if (r.ok) await cache.put(u, r);
      } catch (err) { /* optional file, keep going */ }
    }));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', function (e) {
  e.waitUntil((async function () {
    const names = await caches.keys();
    await Promise.all(names.map(function (n) {
      if (n !== CACHE && n.indexOf('donmac-pos-') === 0) return caches.delete(n);
    }));
    // Take over open tabs. This does NOT reload them — a page mid-sale keeps
    // the JS it already has, and picks up the new build on its next open.
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', function (e) {
  const req = e.request;
  let url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (bypass(req, url)) return;              // straight to the network
  if (req.mode === 'navigate') { e.respondWith(navigation(req, e)); return; }
  e.respondWith(asset(req, e));
});

/* Page loads: network first, cache as the safety net.
   Cache-first would be faster, but this app is deployed by pushing a new
   index.html to GitHub Pages — cache-first means a fix you shipped this
   morning doesn't reach the counter. The timeout keeps a flaky connection
   from stalling the till: 4s of nothing and it serves the stored shell. */
async function navigation(req, e) {
  const cache = await caches.open(CACHE);
  try {
    const fresh = await timeout(fetch(req), NAV_TIMEOUT);
    // GitHub Pages answers a missing path with a 404 page, so a response
    // isn't proof of success — check before storing or returning it.
    if (!fresh || !fresh.ok) throw new Error('bad response');
    e.waitUntil(cache.put(req, fresh.clone()).catch(function () {}));
    return fresh;
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: true })
      || await cache.match('./index.html')
      || await cache.match('./');
    return hit || offline();
  }
}

/* Everything else (icons, images): serve stored copy instantly, refresh in
   the background for next time. */
async function asset(req, e) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req, { ignoreSearch: true });
  if (hit) {
    e.waitUntil((async function () {
      try {
        const r = await fetch(req);
        if (r.ok) await cache.put(req, r.clone());
      } catch (err) { /* offline, keep the stored copy */ }
    })());
    return hit;
  }
  try {
    const r = await fetch(req);
    if (r.ok) e.waitUntil(cache.put(req, r.clone()).catch(function () {}));
    return r;
  } catch (err) {
    return new Response('', { status: 504, statusText: 'Offline' });
  }
}

function timeout(p, ms) {
  return new Promise(function (resolve, reject) {
    const t = setTimeout(function () { reject(new Error('timeout')); }, ms);
    p.then(
      function (r) { clearTimeout(t); resolve(r); },
      function (err) { clearTimeout(t); reject(err); }
    );
  });
}

function offline() {
  return new Response(
    '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/>' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"/>' +
    '<title>Offline</title><style>' +
    'body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;' +
    'background:#111110;color:#e8e8e3;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;' +
    'text-align:center;padding:24px}h1{font-size:17px;margin:0 0 8px}' +
    'p{font-size:14px;color:#8b8b85;margin:0 0 20px;line-height:1.5}' +
    'button{padding:11px 22px;border:0;border-radius:8px;background:#e8e8e3;color:#111110;' +
    'font-size:14px;font-weight:600;font-family:inherit}</style></head><body><div>' +
    '<h1>Don Mac POS isn\'t stored on this device yet</h1>' +
    '<p>Open the app once while online and it will work offline after that.</p>' +
    '<button onclick="location.reload()">Try again</button>' +
    '</div></body></html>',
    { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

/* Lets the page force an update without waiting for a tab close.
   Hook this to your existing "Check for updates" button:
     navigator.serviceWorker.controller?.postMessage({type:'CLEAR_CACHE'}); */
self.addEventListener('message', function (e) {
  const t = e.data && e.data.type ? e.data.type : e.data;
  if (t === 'SKIP_WAITING') self.skipWaiting();
  if (t === 'CLEAR_CACHE') {
    e.waitUntil(caches.delete(CACHE).then(function () { return self.skipWaiting(); }));
  }
});
