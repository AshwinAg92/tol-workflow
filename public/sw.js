// Minimal service worker — enables "Add to Home Screen" installability.
// Deliberately does not cache API responses (leads/tasks/etc change constantly);
// this is just enough for the browser to consider the app installable.
self.addEventListener("install", (e) => self.skipWaiting());
self.addEventListener("activate", (e) => self.clients.claim());
self.addEventListener("fetch", () => {}); // presence of a fetch handler is required for installability

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

