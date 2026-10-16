/* Hero Weather service worker
 *
 * What is cached
 *   - Static shell: the forecast page, manifest, icons, and the small
 *     /lib scripts it needs so the app opens with no network.
 *   - One last successful /api/forecast JSON (network-first). Offline
 *     opens reuse that copy. The page always labels how old it is —
 *     this worker never pretends cached weather is live.
 *
 * Update policy (do not "wait" for old tabs)
 *   - Cache names are versioned. Bump SHELL_CACHE when shell files
 *     change; bump FORECAST_CACHE only if the stored forecast format
 *     changes (so a deploy can keep the last forecast).
 *   - install: precache the shell, then skipWaiting() so the new
 *     worker activates without waiting for every tab to close.
 *   - activate: delete unknown caches, then clients.claim() so this
 *     worker controls open pages right away.
 *   - sw.js is served Cache-Control: no-cache (see vercel.json).
 *     Clients register with updateViaCache: 'none'.
 *   - Shell requests are cache-first (instant open / offline). We do
 *     not stale-while-revalidate individual files, so HTML and /lib
 *     scripts stay on the same version. A deploy bumps SHELL_CACHE,
 *     install precaches the new set, activate drops the old set.
 *   - Open pages keep the HTML they already have in memory. A refresh
 *     loads the new shell from the new versioned cache. We do not
 *     force a reload on controllerchange (that would wipe a search
 *     in progress).
 */
/* eslint-disable no-restricted-globals */
importScripts('/lib/offline-forecast.js');

const SHELL_CACHE = 'hero-shell-v1';
const FORECAST_CACHE = 'hero-forecast-v1';
const LAST_FORECAST_PATH = self.OfflineForecast
  ? self.OfflineForecast.LAST_FORECAST_PATH
  : '/__hero/last-forecast';
const FROM_CACHE_HEADER = self.OfflineForecast
  ? self.OfflineForecast.FROM_CACHE_HEADER
  : 'X-Hero-From-Cache';
const CACHED_AT_HEADER = self.OfflineForecast
  ? self.OfflineForecast.CACHED_AT_HEADER
  : 'X-Hero-Cached-At';

const SHELL_URLS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-512-maskable.png',
  '/icons/apple-touch-icon.png',
  '/lib/spray-settings.js',
  '/lib/url-location.js',
  '/lib/offline-forecast.js',
  '/lib/pwa-install.js'
];

function isForecastRequest(url) {
  return url.pathname === '/api/forecast';
}

function isShellRequest(url) {
  if (url.pathname === '/' || url.pathname === '/index.html') return true;
  return SHELL_URLS.some((path) => url.pathname === path);
}

function isForecastNavigation(request, url) {
  return request.mode === 'navigate' && (url.pathname === '/' || url.pathname === '/index.html');
}

async function precacheShell() {
  const cache = await caches.open(SHELL_CACHE);
  await Promise.all(SHELL_URLS.map(async (path) => {
    try {
      const res = await fetch(path, { cache: 'reload' });
      if (res && res.ok) await cache.put(path, res);
    } catch {
      // One missing file must not block install (e.g. "/" on some hosts).
    }
  }));
}

async function fromShellCache(request) {
  const cache = await caches.open(SHELL_CACHE);
  const url = new URL(request.url);
  const hit = await cache.match(request, { ignoreSearch: true })
    || await cache.match(url.pathname);
  if (hit) return hit;
  if (url.pathname === '/' || url.pathname === '/index.html') {
    return (await cache.match('/index.html')) || (await cache.match('/'));
  }
  return undefined;
}

function copyResponse(response, extraHeaders) {
  const headers = new Headers(response.headers);
  if (extraHeaders) {
    Object.keys(extraHeaders).forEach((key) => {
      const value = extraHeaders[key];
      if (value == null) headers.delete(key);
      else headers.set(key, value);
    });
  }
  return response.blob().then((body) => new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers
  }));
}

async function putLastForecast(response) {
  if (!response || !response.ok) return;
  const cachedAt = new Date().toISOString();
  const stored = await copyResponse(response, {
    [CACHED_AT_HEADER]: cachedAt,
    [FROM_CACHE_HEADER]: null
  });
  const cache = await caches.open(FORECAST_CACHE);
  await cache.put(LAST_FORECAST_PATH, stored);
}

async function matchLastForecast() {
  const cache = await caches.open(FORECAST_CACHE);
  const stored = await cache.match(LAST_FORECAST_PATH);
  if (!stored) return null;
  return copyResponse(stored, { [FROM_CACHE_HEADER]: '1' });
}

self.addEventListener('install', (event) => {
  event.waitUntil(precacheShell());
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => {
      if (key !== SHELL_CACHE && key !== FORECAST_CACHE) return caches.delete(key);
      return undefined;
    }));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (isForecastRequest(url)) {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        if (fresh && fresh.ok) {
          event.waitUntil(putLastForecast(fresh.clone()));
          return fresh;
        }
        const cached = await matchLastForecast();
        if (cached) return cached;
        return fresh;
      } catch {
        const cached = await matchLastForecast();
        if (cached) return cached;
        throw new Error('offline');
      }
    })());
    return;
  }

  // Only the forecast app is the offline shell. Do not treat
  // /spray-map.html (or other navigations) as index.html.
  if (isForecastNavigation(request, url) || isShellRequest(url)) {
    event.respondWith((async () => {
      const cached = await fromShellCache(request);
      if (cached) return cached;
      const fresh = await fetch(request);
      if (fresh && fresh.ok) {
        const cache = await caches.open(SHELL_CACHE);
        await cache.put(url.pathname === '/' ? '/' : url.pathname, fresh.clone());
      }
      return fresh;
    })());
  }
});
