"use strict";

const CACHE_PREFIX = "samurai2-mobile-shell-";
const CACHE_NAME = `${CACHE_PREFIX}v1`;
const SHELL_PATHS = [
  "./",
  "index.html",
  "styles.css",
  "samurai2.js",
  "samurai2.wasm",
  "app.js",
  "manifest.webmanifest",
  "icon.svg",
  "icon-192.png",
  "icon-512.png",
  "apple-touch-icon.png",
  "assets/data/DATA/GAME1.PRG",
  "assets/data/DATA/GAME_CV.PRG",
  "assets/data/embedded/CV_M.PRG",
  "assets/data/DATA/063_S1.FIX",
  "assets/data/DATA/F1400.SPR",
  "assets/data/DATA/B100.BGR",
];
const SHELL_URLS = new Set(
  SHELL_PATHS.map(path => new URL(path, self.registration.scope).href));

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(SHELL_PATHS);
    // Bank 0x0a does not exist; derive the exact 25 original PAT paths from
    // the same extracted manifest the runtime validates instead of assuming a
    // contiguous numeric range.
    const manifestUrl = new URL(
      "assets/audio/patterns/manifest.json", self.registration.scope);
    const response = await fetch(manifestUrl);
    if (!response.ok) throw new Error("pattern manifest unavailable");
    const manifest = await response.clone().json();
    if (manifest.bank_count !== 25 || !Array.isArray(manifest.banks) ||
        manifest.banks.length !== 25) {
      throw new Error("pattern manifest format");
    }
    await cache.put(manifestUrl, response);
    await cache.addAll(manifest.banks.map(
      bank => new URL(`assets/audio/patterns/${bank.path}`,
                      self.registration.scope).href));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    throw error;
  }
}

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (event.request.mode === "navigate" || SHELL_URLS.has(url.href) ||
      /\/assets\/audio\/patterns\/(?:manifest\.json|SND_[0-9A-F]{2}\.PAT)$/.test(
        url.pathname)) {
    event.respondWith(networkFirst(event.request));
  }
  // Match/fighter/stage/ending and music resources are intentionally not put
  // into Cache Storage: the runtime requests them on demand, while the normal
  // HTTP cache may evict them under the browser's own mobile storage budget.
});
