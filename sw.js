const CACHE = 'cutroom-v14';
const ASSETS = ['./edit-policy.mjs?v=14', './connection.mjs?v=14', './continuity-core.mjs?v=14', './continuity.mjs?v=14', './', './index.html', './styles.css?v=8', './app.js?v=14', './vault.mjs?v=14', './media.mjs?v=14', './core.mjs?v=14', './planner.mjs?v=14', './audio-cuts.mjs?v=14', './motion.mjs?v=14', './transition-core.mjs?v=14', './transitions.mjs?v=14', './overlap.mjs?v=14', './analyze.mjs?v=14', './render-core.mjs?v=14', './renderer.mjs?v=14', './quality.mjs?v=14', './export-inspect.mjs?v=14', './packet-copy.mjs?v=14', './color.mjs?v=14', './color-gpu.mjs?v=14', './finish-core.mjs?v=14', './cut-timing.mjs?v=14', './join-quality.mjs?v=14', './review-joins.mjs?v=14', './export-recovery.mjs?v=14', './mediabunny.mjs?v=6', './manifest.webmanifest', './icon-192.png', './icon-512.png'];
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
