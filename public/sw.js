// Enables offline access: the app shell (HTML/JS/CSS) and the data behind
// Leads/Calendar/Team/etc are cached as they're fetched, so opening the app
// with no signal still shows the last-synced data — read-only, since writes
// need a live connection anyway. Two caches: one for the shell (rarely
// changes shape), one for API GET responses (changes constantly).
const SHELL_CACHE = "tol-shell-v1";
const API_CACHE = "tol-api-v1";
const SHELL_URLS = ["/login", "/app.js", "/styles.css", "/manifest.json", "/logo.png", "/logo-icon.png"];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_URLS)).catch(() => {})
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== SHELL_CACHE && n !== API_CACHE).map((n) => caches.delete(n)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return; // writes always need a live connection
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // don't intercept third-party requests

  // Large binary files (uploaded documents, images) aren't worth the
  // storage quota for offline access — let those pass through normally.
  if (url.pathname.startsWith("/api/documents/") && url.pathname.endsWith("/file")) return;
  if (url.pathname.startsWith("/uploads/")) return;

  const isApi = url.pathname.startsWith("/api/");
  const isNavigation = request.mode === "navigate";
  const cacheName = isApi ? API_CACHE : SHELL_CACHE;

  // Network-first with a cache fallback, for both the app shell and API
  // data: whenever there's a connection, always prefer the freshest copy
  // (and update the cache for next time); when there isn't, fall back to
  // whatever was last saved instead of failing outright.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(cacheName).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        if (isNavigation) {
          const shellFallback = await caches.match("/login");
          if (shellFallback) return shellFallback;
        }
        return new Response(isApi ? JSON.stringify({ error: "Offline — no cached data available yet." }) : "Offline", {
          status: 503,
          headers: { "Content-Type": isApi ? "application/json" : "text/plain" },
        });
      })
  );
});

self.addEventListener("push", (event) => {
  let data = { title: "Together, Out Loud", body: "New activity in the CRM.", url: "/" };
  try { if (event.data) data = { ...data, ...event.data.json() }; } catch (e) { /* fall back to defaults */ }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/logo-icon.png",
      badge: "/logo-icon.png",
      data: { url: data.url || "/" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) { client.navigate(url); return client.focus(); }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});

