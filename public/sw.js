// Shadow Mitts service worker (M5 PWA). Registered only by production builds (src/app/pwa.ts).
//
// What is cached — game files and the pinned model files, nothing else. Camera frames, poses and
// faces never go through fetch, so they can't end up here (docs/FACE-PRIVACY.md).
//
// Staying fresh: pages are network-first, so a new deploy shows up on the next load; Vite's
// build files have content hashes in their names, so caching those forever is safe. Model/WASM
// URLs are version-pinned (…/float16/1/…, tasks-vision@x.y.z), so those are safe to keep too.

const APP = 'sm-app-v1';
const CDN = 'sm-cdn-v1';

self.addEventListener('install', (event) => {
  // nothing stale can be served (network-first pages), so the new worker may take over at once
  self.skipWaiting();
  event.waitUntil(caches.open(APP).then((c) => c.addAll(['./', './manifest.webmanifest'])).catch(() => {}));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== APP && k !== CDN) await caches.delete(k);
    await self.clients.claim();
  })());
});

const PINNED_CDN = [
  /^https:\/\/cdn\.jsdelivr\.net\/npm\/@mediapipe\/tasks-vision@\d+\.\d+\.\d+\//,
  /^https:\/\/storage\.googleapis\.com\/mediapipe-models\/.+\/float16\/\d+\//,
];
const FONTS = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//;

async function networkFirst(req) {
  const cache = await caches.open(APP);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (e) {
    const hit = (await cache.match(req)) || (await cache.match('./'));
    if (hit) return hit;
    throw e;
  }
}

async function cacheFirst(req, name) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
  return res;
}

async function staleWhileRevalidate(req, name) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  const fresh = fetch(req).then((res) => {
    if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
    return res;
  }).catch(() => hit);
  return hit || fresh;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (req.mode === 'navigate') return event.respondWith(networkFirst(req));
  if (url.origin === self.location.origin) {
    if (url.pathname.includes('/assets/')) return event.respondWith(cacheFirst(req, APP));
    if (url.pathname.endsWith('/sw.js')) return; // always from the network
    return event.respondWith(staleWhileRevalidate(req, APP));
  }
  if (PINNED_CDN.some((re) => re.test(req.url))) return event.respondWith(cacheFirst(req, CDN));
  if (FONTS.test(req.url)) return event.respondWith(staleWhileRevalidate(req, CDN));
  // anything else: straight to the network, not stored
});
