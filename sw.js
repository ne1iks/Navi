// Старый кэш мешал обновлению: этот воркер чистит кэш, удаляет себя и перезагружает страницу.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then(k => Promise.all(k.map(x => caches.delete(x))))
    .then(() => self.registration.unregister())
    .then(() => self.clients.matchAll())
    .then(cs => cs.forEach(c => c.navigate(c.url)))
));
