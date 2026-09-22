/* FieldLens offline shell.
 *
 * The app is only useful with no signal, so the shell must be served from the
 * device itself. The cache is deliberately tiny and versioned: capture writes
 * to IndexedDB, not to the cache, so a worker's records never depend on the
 * cache surviving a browser eviction - they are exportable regardless.
 *
 * The local Office Kit target is never cached and never intercepted, because
 * those requests must reach the PC on the LAN every time.
 */

const VERSION = "fieldlens-v1";
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./engine.js",
  "./store.js",
  "./transfer.js",
  "./manifest.webmanifest",
  "./icon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // LAN transfers bypass the cache entirely
  if (url.pathname.startsWith("/api/")) return;

  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request).then((response) => {
      const copy = response.clone();
      caches.open(VERSION).then((cache) => cache.put(request, copy)).catch(() => {});
      return response;
    }).catch(() => caches.match("./index.html"))),
  );
});
