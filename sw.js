const CACHE = 'cutroom-v6';
const ASSETS = ['./', './index.html', './styles.css?v=6', './app.js?v=6', './vault.mjs?v=6', './media.mjs?v=6', './core.mjs?v=6', './planner.mjs?v=6', './overlap.mjs?v=6', './analyze.mjs?v=6', './render-core.mjs?v=6', './renderer.mjs?v=6', './mediabunny.mjs?v=6', './manifest.webmanifest', './icon-192.png', './icon-512.png'];
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
