/**
 * Service worker: держит оболочку приложения в кэше, чтобы коллекция
 * открывалась без интернета. Поисковые запросы к внешним API не трогаем —
 * они всегда идут в сеть.
 */

const CACHE = 'collectmovie-v6';

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './assets/css/app.css',
  './assets/js/app.js',
  './assets/js/store.js',
  './assets/js/ui.js',
  './assets/js/providers.js',
  './assets/js/recs.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;   // API и постеры — мимо кэша

  // Сначала сеть, кэш — только запасной вариант.
  //
  // Раньше было наоборот (отдаём кэш, обновляем в фоне), и это скрывало
  // исправления: при запуске показывалась прошлая сборка, а новая доезжала
  // лишь со следующего открытия. Приложение весит считанные килобайты, так
  // что поход в сеть ничего не стоит, а офлайн всё так же работает.
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      try {
        const fresh = await fetch(request);
        if (fresh && fresh.ok) cache.put(request, fresh.clone());
        return fresh;
      } catch {
        const cached = await cache.match(request, { ignoreSearch: true });
        if (cached) return cached;

        // Офлайн и ничего не сохранено — для навигации отдаём оболочку.
        if (request.mode === 'navigate') {
          const shell = await cache.match('./index.html');
          if (shell) return shell;
        }
        return new Response('Офлайн', { status: 503, statusText: 'Offline' });
      }
    })
  );
});
