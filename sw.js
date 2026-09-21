const CACHE = 'cutroom-v13';
const ASSETS = ['./edit-policy.mjs?v=13', './connection.mjs?v=13', './continuity-core.mjs?v=13', './continuity.mjs?v=13', './', './index.html', './styles.css?v=8', './app.js?v=13', './vault.mjs?v=10', './vault.mjs?v=6', './media.mjs?v=13', './core.mjs?v=6', './planner.mjs?v=13', './audio-cuts.mjs?v=12', './motion.mjs?v=9', './transition-core.mjs?v=13', './transitions.mjs?v=13', './overlap.mjs?v=6', './analyze.mjs?v=12', './render-core.mjs?v=12', './renderer.mjs?v=13', './quality.mjs?v=11', './export-inspect.mjs?v=11', './packet-copy.mjs?v=11', './color.mjs?v=11', './color-gpu.mjs?v=11', './finish-core.mjs?v=11', './cut-timing.mjs?v=12', './join-quality.mjs?v=12', './review-joins.mjs?v=12', './export-recovery.mjs?v=12', './mediabunny.mjs?v=6', './manifest.webmanifest', './icon-192.png', './icon-512.png'];
const urls = new Set(ASSETS.map(path => new URL(path, self.registration.scope).href));
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)));
  // Activate after the previous app closes, never in the middle of an import.
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key => /^cutroom-v\d+$/.test(key) && key !== CACHE).map(key => caches.delete(key))
  )));
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || !urls.has(event.request.url)) return;
  event.respondWith(caches.open(CACHE).then(async cache => (await cache.match(event.request)) || fetch(event.request)));
});
