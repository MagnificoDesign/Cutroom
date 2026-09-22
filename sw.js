const CACHE = 'cutroom-v15';
const ASSETS = ['./match-cut.mjs?v=15', './analysis-report.mjs?v=15', './edit-policy.mjs?v=15', './connection.mjs?v=15', './continuity-core.mjs?v=15', './continuity.mjs?v=15', './', './index.html', './styles.css?v=15', './app.js?v=15', './vault.mjs?v=15', './media.mjs?v=15', './core.mjs?v=15', './planner.mjs?v=15', './audio-cuts.mjs?v=15', './motion.mjs?v=15', './transition-core.mjs?v=15', './transitions.mjs?v=15', './overlap.mjs?v=15', './analyze.mjs?v=15', './render-core.mjs?v=15', './renderer.mjs?v=15', './quality.mjs?v=15', './export-inspect.mjs?v=15', './packet-copy.mjs?v=15', './color.mjs?v=15', './color-gpu.mjs?v=15', './finish-core.mjs?v=15', './cut-timing.mjs?v=15', './join-quality.mjs?v=15', './review-joins.mjs?v=15', './export-recovery.mjs?v=15', './mediabunny.mjs?v=6', './manifest.webmanifest', './icon-192.png', './icon-512.png'];
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
