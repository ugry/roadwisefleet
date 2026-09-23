/*
 * RoadwiseFleet driver app — service worker (board task #4).
 *
 * Scope: `/pilot/` only. It caches the app *shell* (the driver page, the shared
 * domain core, the manifest and the icons) so the app opens with no signal.
 *
 * It deliberately never caches `/api/*`: trip data, documents and tracking
 * payloads are per-user and must not sit in a shared HTTP cache. API requests
 * always go to the network; the offline queue in the page owns replay.
 *
 * Bump CACHE_NAME whenever a shell file changes — the activate step deletes
 * every older cache.
 */
'use strict';

var CACHE_NAME = 'rwf-driver-shell-v1';
var SHELL = [
  './driver.html',
  './lib/driver-core.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png'
];
var OFFLINE_FALLBACK = './driver.html';

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(SHELL);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (key) {
        return key !== CACHE_NAME;
      }).map(function (key) {
        return caches.delete(key);
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

function isShellRequest(request, url) {
  if (url.origin !== self.location.origin) return false;
  if (url.pathname.indexOf('/pilot/') !== 0) return false;
  if (url.pathname.indexOf('/api/') === 0) return false;
  return true;
}

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;

  var url;
  try {
    url = new URL(request.url);
  } catch (err) {
    return;
  }

  // Everything outside the pilot surface (including /api/*) is never cached.
  if (!isShellRequest(request, url)) return;

  // Navigation: network first, so a deployed change lands immediately; the
  // cached shell is the offline fallback.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).then(function (response) {
        var copy = response.clone();
        caches.open(CACHE_NAME).then(function (cache) { cache.put(request, copy); });
        return response;
      }).catch(function () {
        return caches.match(request).then(function (cached) {
          return cached || caches.match(OFFLINE_FALLBACK);
        });
      })
    );
    return;
  }

  // Shell assets: cache first, refresh in the background.
  event.respondWith(
    caches.match(request).then(function (cached) {
      var network = fetch(request).then(function (response) {
        if (response && response.status === 200) {
          var copy = response.clone();
          caches.open(CACHE_NAME).then(function (cache) { cache.put(request, copy); });
        }
        return response;
      }).catch(function () {
        return cached;
      });
      return cached || network;
    })
  );
});
